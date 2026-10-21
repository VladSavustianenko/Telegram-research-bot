import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { exposureMicros, reserve, settleRun, type RunAccounting } from '../accounting/ledger';
import { effectiveLimits } from '../accounting/limits';
import type { ReservationPolicy } from '../accounting/pricing';
import { abortableSleep } from '../common/abortable-sleep';
import { CLOCK, type Clock } from '../common/clock';
import { errorInfo } from '../common/error-info';
import { APP_CONFIG } from '../config/config.module';
import {
  MAX_SUBMISSION_RETRY_DELAY_SECONDS,
  RUN_LEASE_SECONDS,
  type Env,
} from '../config/env.schema';
import { isUniqueViolation, type Tx } from '../database/prisma-errors';
import { PrismaService } from '../database/prisma.service';
import { createDelivery, createStatusDelivery } from '../delivery/delivery-records';
import { messages } from '../delivery/messages';
import { renderReport } from '../delivery/report-renderer';
import { Prisma, type AppUser } from '../generated/prisma/client';
import { submissionDenial } from '../identity/authorization';
import { lockUserForShare } from '../identity/users';
import { QueueService, RESEARCH_QUEUE, type ResearchJob } from '../queue/queue.service';
import { ADMISSION_LOCK_KEY } from './admission';
import { cancelOverdueQueued, cancelUnadmitted } from './lifecycle';
import { OutboxDispatcher } from './outbox-dispatcher';
import {
  NON_TERMINAL_STATUSES,
  ProviderError,
  RESEARCH_PROVIDER,
  unconfirmedBounds,
  type ProviderSnapshot,
  type ResearchProvider,
  type ResearchRequest,
} from './provider/provider.types';
import { extractReport } from './report';
import {
  buildResearchContext,
  buildResearchRequest,
  type ResearchContext,
  type RunConfigSnapshot,
} from './request-builder';
import { TOOL_TELEMETRY_VERSION, recordToolItems } from './tool-telemetry';
import { hasUnresolvedLiveUncertainty } from './uncertainty';
import { EXECUTE_EVENT, TERMINAL_RUN_STATES, wakeQueuedRuns, wakeRun } from './wake';

export { RUN_LEASE_SECONDS };

/** Stored in research_run.request_snapshot. `request` is written before the first submission and never changed. */
interface StoredSnapshot {
  config: RunConfigSnapshot;
  context?: ResearchContext;
  request?: ResearchRequest;
}

interface Claim {
  id: string;
  fencingToken: number;
}

/** One execution of one claimed run. */
interface Execution {
  claim: Claim;
  provider: ResearchProvider;
  stored: StoredSnapshot;
  /** Scheduled runs: the planned occurrence (reported with the delay; never the time reference). */
  occurrenceAt: Date | null;
}

/** What one job did: advanced a run it held, or only inspected (and possibly deferred). */
export type JobOutcome = 'executed' | 'idle';

/** The lease was lost to another worker; this worker must stop touching the run. */
export class StaleLeaseError extends Error {
  constructor() {
    super('research run lease lost');
    this.name = 'StaleLeaseError';
  }
}

const terminalRunStates = new Set<string>(TERMINAL_RUN_STATES);

const isTerminal = (snapshot: ProviderSnapshot | null): snapshot is ProviderSnapshot =>
  snapshot !== null && !NON_TERMINAL_STATUSES.has(snapshot.status);

/**
 * Combines what is known about one provider response across polls: the newest
 * status and content, without overwriting known usage or tool/source counts
 * with missing data.
 */
export function mergeSnapshots(
  previous: ProviderSnapshot | null,
  next: ProviderSnapshot | null,
): ProviderSnapshot | null {
  if (!previous) return next;
  if (!next) return previous;
  return {
    ...next,
    model: next.model ?? previous.model,
    usage: next.usage ?? previous.usage,
    webSearchCalls: Math.max(previous.webSearchCalls, next.webSearchCalls),
    sources: next.sources.length > 0 ? next.sources : previous.sources,
  };
}

/**
 * Bounds policy, applied to every provider snapshot (fresh submission, poll
 * after recovery, cancellation result): the echoed bounds must equal the
 * immutable request snapshot of the run. A saved response ID alone proves
 * nothing; no verification state is persisted, so recovery re-verifies.
 */
export function boundsProblems(stored: StoredSnapshot, snapshot: ProviderSnapshot): string[] {
  if (!stored.request) return ['request_snapshot'];
  return unconfirmedBounds(stored.request, snapshot.bounds);
}

/** Delay before an authorized resubmission: the provider's Retry-After when given, bounded. */
export function submissionRetryDelaySeconds(
  retryAfterMs: number | null,
  configuredSeconds: number,
): number {
  const seconds = retryAfterMs === null ? configuredSeconds : Math.ceil(retryAfterMs / 1_000);
  return Math.min(MAX_SUBMISSION_RETRY_DELAY_SECONDS, Math.max(1, seconds));
}

/**
 * Research execution behind the pg-boss queue (TRB-060, docs/QUEUE.md).
 *
 * A job only asks to inspect and advance one run; everything is rechecked in
 * the database:
 * - finished run: nothing happens (duplicate or late job);
 * - RUNNING with a live lease: another worker holds it; nothing happens;
 * - RUNNING with an expired lease: taken over (new fencing token) and resumed
 *   according to its submission state;
 * - QUEUED: the worker claims the fairest eligible queued run (least recently
 *   served user first, then oldest) if capacity allows; otherwise the run gets
 *   a durable deferred wake-up.
 *
 * Recovery policy (submission state of the current attempt):
 * - NOT_SUBMITTED: nothing was sent; execute after the eligibility and
 *   reservation checks.
 * - SUBMITTING: a request may have reached the provider but no response ID was
 *   saved; UNCERTAIN, never resubmitted automatically.
 * - SUBMITTED: resume polling the saved response ID (bounds re-verified),
 *   within the original deadline; never resubmit.
 *
 * Termination is "confirmed" only when the provider returns a terminal status.
 * A failed, missing or non-terminal cancellation leaves the run UNCERTAIN.
 * Unreconciled live UNCERTAIN runs block claiming of further live work.
 * Every write after claiming is fenced by (id, fencing_token, state=RUNNING),
 * including settlement, delivery creation and wake-ups, so a stale worker can
 * change nothing.
 *
 * A new provider submission (attempt) is made only after a refusal that
 * proves the previous request was not accepted (HTTP 429), when
 * RESEARCH_SUBMISSION_RETRY_LIMIT allows it, after a fresh authorization
 * (owner, live gate, budgets) and with its own reservation.
 *
 * Owner eligibility (TRB-030) is rechecked before every submission, in the
 * transaction that records SUBMITTING and under a shared lock on the owner's
 * row: a suspended, unresolved or no-longer-permitted owner (live research is
 * administrator-only) gets CANCELLED with zero provider calls. A suspension
 * committed after SUBMITTING lets the request go out; polling then sees the
 * suspension and requests provider cancellation, keeping the request tracked.
 */
@Injectable()
export class ResearchWorker implements OnApplicationBootstrap, OnModuleDestroy {
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly logger = new Logger(ResearchWorker.name);
  private readonly shutdown = new AbortController();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly queue: QueueService,
    private readonly dispatcher: OutboxDispatcher,
    @Optional() @Inject(RESEARCH_PROVIDER) private readonly provider: ResearchProvider | null,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.BACKGROUND_WORKERS !== 'on' || !this.provider) return;
    this.queue.onUp(() => this.queue.work((job) => this.process(job)));
  }

  /**
   * Shutdown: stop fetching jobs and signal the active handler. A polling
   * handler releases its lease and hands the run over through a wake-up; a
   * provider call in flight is waited for (bounded by OPENAI_HTTP_TIMEOUT_MS)
   * so that its response ID can be saved. If the process ends first, the run's
   * submission state stays SUBMITTING and recovery marks it UNCERTAIN.
   */
  async onModuleDestroy(): Promise<void> {
    this.shutdown.abort();
    const outcome = await this.queue.stopWork(this.config.OPENAI_HTTP_TIMEOUT_MS + 5_000);
    if (outcome === 'timeout') {
      this.logger.warn({ message: 'Research worker did not stop before the shutdown timeout' });
    }
  }

  /** pg-boss handler. Throws only on infrastructure errors; pg-boss then retries the inspection. */
  process(job: ResearchJob): Promise<JobOutcome> {
    return this.handle(job.data.runId, AbortSignal.any([this.shutdown.signal, job.signal]));
  }

  /**
   * Manual driver (tests, diagnostics): runs the recovery sweep and one
   * publication batch, then processes ready jobs until one advances a run or
   * none is left. Returns true when a run was executed.
   */
  async tick(signal?: AbortSignal): Promise<boolean> {
    if (!this.provider || !this.queue.has(RESEARCH_QUEUE)) return false;
    await this.dispatcher.sweep();
    await this.dispatcher.dispatchDue();
    for (;;) {
      const job = await this.queue.fetchOne();
      if (!job) return false;
      let outcome: JobOutcome;
      try {
        outcome = await this.handle(job.data.runId, signal);
      } catch (error) {
        await this.queue.fail(job, error);
        throw error;
      }
      await this.queue.complete(job);
      if (outcome === 'executed') return true;
    }
  }

  /** Inspects and advances one run; see the class comment. */
  async handle(runId: string, signal?: AbortSignal): Promise<JobOutcome> {
    const provider = this.provider;
    if (!provider) return 'idle';
    const run = await this.prisma.researchRun.findUnique({
      where: { id: runId },
      select: { state: true },
    });
    if (!run || terminalRunStates.has(run.state)) return 'idle';

    let claim: Claim | null;
    if (run.state === 'RUNNING') {
      claim = await this.takeOverExpired(runId);
      if (!claim) return 'idle';
    } else {
      await cancelUnadmitted(this.prisma);
      await cancelOverdueQueued(this.prisma, this.config.RESEARCH_QUEUE_MAX_WAIT_SECONDS);
      claim = await this.claimNext();
      if (!claim) {
        await this.defer(runId);
        return 'idle';
      }
    }
    try {
      await this.execute(claim, provider, signal);
    } catch (error) {
      if (error instanceof StaleLeaseError) {
        this.logger.warn({ message: 'Research run lease lost; stopping', runId: claim.id });
      } else {
        // The lease expires; the recovery sweep wakes the run and the policy above applies.
        this.logger.error({
          message: 'Research execution error',
          runId: claim.id,
          ...errorInfo(error),
        });
      }
    }
    return 'executed';
  }

  /**
   * Claims the fairest eligible QUEUED run: global capacity is one RUNNING run
   * (research_run_single_running), which also bounds each user to one; among
   * eligible runs the user served least recently goes first, then the oldest
   * run. Eligible: admission evidence, retry delay elapsed and, for live runs,
   * no unreconciled live UNCERTAIN run. The check and the claim are one
   * statement (one snapshot): a run that becomes UNCERTAIN is RUNNING until
   * that commit, so no interleaving lets a live run start.
   */
  private async claimNext(): Promise<Claim | null> {
    try {
      const rows = await this.prisma.$queryRaw<Claim[]>`
        WITH head AS (
          SELECT q.id FROM research_run q
           WHERE q.state = 'QUEUED'
             AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= now())
             AND EXISTS (SELECT 1 FROM outbox_event o
                          WHERE o.run_id = q.id AND o.type = ${EXECUTE_EVENT} AND o.cancelled_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM research_run r WHERE r.state = 'RUNNING')
             AND (q.provider_kind <> 'openai' OR NOT EXISTS (
                   SELECT 1 FROM research_run u
                    WHERE u.state = 'UNCERTAIN' AND u.provider_kind = 'openai'
                      AND u.reconciled_at IS NULL))
           ORDER BY (SELECT max(s.started_at) FROM research_run s WHERE s.user_id = q.user_id)
                    ASC NULLS FIRST,
                    q.created_at, q.id
           LIMIT 1
             FOR UPDATE SKIP LOCKED)
        UPDATE research_run
           SET state = 'RUNNING', lease_owner = ${this.workerId},
               lease_until = now() + ${RUN_LEASE_SECONDS} * interval '1 second',
               fencing_token = fencing_token + 1, started_at = COALESCE(started_at, now()),
               next_attempt_at = NULL, updated_at = now()
         WHERE id IN (SELECT id FROM head)
        RETURNING id, fencing_token AS "fencingToken"`;
      return rows[0] ?? null;
    } catch (error) {
      // research_run_single_running: another worker started a run concurrently.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /**
   * A queued run that could not start now is inspected again later: when its
   * retry delay ends, otherwise after RESEARCH_CAPACITY_RETRY_SECONDS. Durable
   * (an outbox event), coalesced with any pending wake-up, never a tight loop.
   */
  private async defer(runId: string): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO outbox_event (id, operation_key, type, run_id, payload, available_at)
      SELECT gen_random_uuid(), 'RESEARCH_WAKE:' || gen_random_uuid(), 'RESEARCH_WAKE', q.id,
             jsonb_build_object('runId', q.id::text, 'reason', 'DEFERRED'),
             CASE WHEN q.next_attempt_at > now() THEN q.next_attempt_at
                  ELSE now() + ${this.config.RESEARCH_CAPACITY_RETRY_SECONDS} * interval '1 second' END
        FROM research_run q
       WHERE q.id = ${runId}::uuid AND q.state = 'QUEUED'
      ON CONFLICT (run_id) WHERE dispatched_at IS NULL AND cancelled_at IS NULL
      DO UPDATE SET available_at = LEAST(outbox_event.available_at, EXCLUDED.available_at)`;
  }

  /** Takes over a RUNNING run whose lease expired (its worker died or froze). */
  private async takeOverExpired(runId: string): Promise<Claim | null> {
    const rows = await this.prisma.$queryRaw<Claim[]>`
      UPDATE research_run
         SET lease_owner = ${this.workerId},
             lease_until = now() + ${RUN_LEASE_SECONDS} * interval '1 second',
             fencing_token = fencing_token + 1, updated_at = now()
       WHERE id = (SELECT id FROM research_run
                    WHERE id = ${runId}::uuid AND state = 'RUNNING'
                      AND (lease_until IS NULL OR lease_until < now())
                      FOR UPDATE SKIP LOCKED)
      RETURNING id, fencing_token AS "fencingToken"`;
    const claim = rows[0] ?? null;
    if (claim) this.logger.warn({ message: 'Took over expired research run', runId: claim.id });
    return claim;
  }

  private async execute(
    claim: Claim,
    provider: ResearchProvider,
    signal?: AbortSignal,
  ): Promise<void> {
    const run = await this.prisma.researchRun.findUniqueOrThrow({ where: { id: claim.id } });
    const stored = run.requestSnapshot as unknown as StoredSnapshot;
    const execution: Execution = { claim, provider, stored, occurrenceAt: run.occurrenceAt };

    // Never switch providers silently (e.g. a run admitted as live must not get fake results).
    if (stored.config.providerKind !== provider.kind) {
      return run.submissionState === 'NOT_SUBMITTED'
        ? this.finishWithoutReport(execution, 'FAILED', 'PROVIDER_CHANGED')
        : // The original provider request may still exist; it cannot be checked from here.
          this.finishWithoutReport(execution, 'UNCERTAIN', 'PROVIDER_CHANGED_AFTER_SUBMISSION');
    }

    if (run.submissionState === 'SUBMITTING') {
      return this.finishWithoutReport(execution, 'UNCERTAIN', 'SUBMISSION_INTERRUPTED');
    }
    if (run.submissionState === 'SUBMITTED') {
      if (!run.providerResponseId || !run.submittedAt) {
        throw new Error('submitted run without response id');
      }
      // Resumes the same response within the original deadline (submitted_at).
      return this.poll(execution, run.providerResponseId, run.submittedAt, null, signal);
    }

    // Defence in depth for the fail-closed gate (normally enforced at claim time).
    if (provider.kind === 'openai' && (await hasUnresolvedLiveUncertainty(this.prisma))) {
      await this.prisma.$transaction(async (tx) => {
        await this.fenced(tx, claim, { state: 'QUEUED', leaseOwner: null, leaseUntil: null });
        await wakeRun(tx, claim.id, 'LIVE_GATE', {
          delaySeconds: this.config.RESEARCH_CAPACITY_RETRY_SECONDS,
        });
      });
      this.logger.warn({
        message: 'Live run returned to queue: unresolved uncertainty',
        runId: run.id,
      });
      return;
    }

    const submittedAt = this.clock.now();
    // The immutable request is built once, with the actual execution time as its
    // reference; a later attempt resubmits it unchanged, and polling a submitted
    // response never rebuilds it.
    const context =
      stored.context ??
      buildResearchContext(submittedAt, run.createdAt, stored.config.timeZone, run.occurrenceAt);
    const request =
      stored.request ?? buildResearchRequest(run.id, run.prompt, stored.config, context);
    const nextStored: StoredSnapshot = { ...stored, config: stored.config, context, request };
    await this.renewLease(claim);
    // Recheck the owner and the task, and record the intent (the attempt and the
    // immutable request) before the potentially billed call, atomically.
    const denial = await this.prisma.$transaction(async (tx) => {
      const owner = run.userId ? await lockUserForShare(tx, run.userId) : null;
      const reason = submissionDenial(owner, provider.kind, this.config);
      if (reason) return reason;
      if (run.taskId) {
        const task = await tx.task.findUnique({
          where: { id: run.taskId },
          select: { state: true },
        });
        if (task?.state === 'DELETED') return 'TASK_DELETED';
      }
      // A live run is submitted only against its current attempt's own reservation.
      if (provider.kind === 'openai') {
        const reservation = await tx.budgetReservation.findUnique({
          where: { runId_attemptNo: { runId: claim.id, attemptNo: run.currentAttemptNo } },
          select: { status: true },
        });
        if (reservation?.status !== 'RESERVED') return 'ACCOUNTING_MISSING';
      }
      await this.fenced(tx, claim, {
        submissionState: 'SUBMITTING',
        submittedAt,
        // From here on, every provider snapshot's tool items are recorded (research_tool_item).
        toolTelemetryVersion: TOOL_TELEMETRY_VERSION,
        requestSnapshot: nextStored as unknown as Prisma.InputJsonValue,
      });
      await this.syncAttempt(tx, claim, {});
      return null;
    });
    if (denial) return this.finishWithoutReport(execution, 'CANCELLED', denial);
    execution.stored = nextStored;

    let first: ProviderSnapshot;
    try {
      first = await provider.submit(request);
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : null;
      const code = providerError?.code ?? 'SUBMIT_UNEXPECTED';
      this.logger.warn({ message: 'Research submission failed', runId: run.id, code });
      if (providerError?.certainty !== 'not_accepted') {
        return this.finishWithoutReport(execution, 'UNCERTAIN', code);
      }
      if (
        providerError.retryAfterMs !== undefined &&
        (await this.retry(execution, providerError))
      ) {
        return;
      }
      return this.finishWithoutReport(execution, 'FAILED', code, null, {
        providerNotAccepted: true,
      });
    }

    // Persist the response ID immediately; bounds are verified afterwards in poll()
    // and again after any recovery, so a crash in between cannot skip verification.
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.fenced(tx, claim, {
          submissionState: 'SUBMITTED',
          providerResponseId: first.id,
          providerStatus: first.status,
          providerModel: first.model,
        });
        await this.syncAttempt(tx, claim, {});
        await recordToolItems(tx, claim.id, first.id, first.toolItems);
      });
    } catch (error) {
      // Keep the ID in the log so an operator can reconcile the UNCERTAIN run.
      this.logger.error({
        message: 'Accepted response not recorded',
        runId: run.id,
        responseId: first.id,
      });
      throw error;
    }
    this.logger.log({ message: 'Research submitted', runId: run.id, responseId: first.id });
    return this.poll(execution, first.id, submittedAt, first, signal);
  }

  /**
   * After a rate-limit refusal (the request was not accepted): if the policy
   * allows another submission, closes the attempt (NOT_ACCEPTED, reservation
   * released), authorizes the next attempt like an admission (owner, live
   * gate, user and global budgets with a new reservation at the run's accepted
   * pricing) and requeues the run with a delay. One fenced transaction: a
   * crash leaves either the old attempt (recovered as SUBMITTING → UNCERTAIN,
   * fail-closed) or the complete requeue. Returns false when no retry is
   * allowed; a refused authorization finishes the run FAILED here.
   */
  private async retry(execution: Execution, error: ProviderError): Promise<boolean> {
    const { claim, provider } = execution;
    const run = await this.prisma.researchRun.findUniqueOrThrow({
      where: { id: claim.id },
      select: { userId: true, currentAttemptNo: true },
    });
    if (run.currentAttemptNo - 1 >= this.config.RESEARCH_SUBMISSION_RETRY_LIMIT) return false;
    const attemptNo = run.currentAttemptNo;
    const delaySeconds = submissionRetryDelaySeconds(
      error.retryAfterMs ?? null,
      this.config.RESEARCH_SUBMISSION_RETRY_DELAY_SECONDS,
    );
    const code = error.code.slice(0, 120);
    const refusal = await this.prisma.$transaction(async (tx) => {
      // Lock order as in admission: owner, then the run, then the admission lock.
      const owner = run.userId ? await lockUserForShare(tx, run.userId) : null;
      await this.fenced(tx, claim, { failureCode: code });
      await this.syncAttempt(tx, claim, {
        outcome: 'NOT_ACCEPTED',
        failureCode: code,
        completedAt: this.clock.now(),
      });
      await settleRun(tx, claim.id, { outcome: 'release', reason: code }, attemptNo);
      const denial = await this.authorizeAttempt(tx, owner, claim.id, provider, attemptNo + 1);
      if (denial) {
        await this.finishInTx(tx, execution, 'FAILED', `${code};RETRY_REFUSED:${denial}`, null, {
          providerNotAccepted: true,
        });
        return denial;
      }
      const moved = await tx.$executeRaw`
        UPDATE research_run
           SET state = 'QUEUED', lease_owner = NULL, lease_until = NULL,
               current_attempt_no = ${attemptNo + 1}, submission_state = 'NOT_SUBMITTED',
               submitted_at = NULL, provider_status = NULL, provider_model = NULL,
               failure_code = NULL,
               next_attempt_at = now() + ${delaySeconds} * interval '1 second', updated_at = now()
         WHERE id = ${claim.id}::uuid AND fencing_token = ${claim.fencingToken} AND state = 'RUNNING'`;
      if (moved !== 1) throw new StaleLeaseError();
      await wakeRun(tx, claim.id, 'SUBMISSION_RETRY', { delaySeconds });
      return null;
    });
    this.logger.warn({
      message: refusal ? 'Research resubmission refused' : 'Research resubmission scheduled',
      runId: claim.id,
      code,
      attemptNo: attemptNo + 1,
      ...(refusal ? { refusal } : { delaySeconds }),
    });
    return true;
  }

  /**
   * Authorization of an additional attempt, under the admission lock: owner
   * eligibility, the live gate and both monthly budgets (current exposure plus
   * the new reservation), then the new reservation (same pricing snapshot and
   * period as the run's first reservation). Returns a refusal code or null.
   */
  private async authorizeAttempt(
    tx: Tx,
    owner: AppUser | null,
    runId: string,
    provider: ResearchProvider,
    attemptNo: number,
  ): Promise<string | null> {
    const denial = submissionDenial(owner, provider.kind, this.config);
    if (denial) return denial;
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${ADMISSION_LOCK_KEY})`;
    if (provider.kind !== 'openai') return null;
    if (await hasUnresolvedLiveUncertainty(tx)) return 'LIVE_BLOCKED_UNCERTAIN';
    const first = await tx.budgetReservation.findUnique({
      where: { runId_attemptNo: { runId, attemptNo: 1 } },
      select: { userId: true, periodMonth: true, policy: true },
    });
    if (!first) return 'ACCOUNTING_MISSING';
    // The owner's effective budget (override or default), read under the owner's row lock.
    const userBudget = effectiveLimits(owner, this.config).monthlyBudgetMicros;
    const globalBudget = this.config.GLOBAL_MONTHLY_BUDGET_USD;
    if (
      userBudget === undefined ||
      globalBudget === undefined ||
      this.config.USER_MONTHLY_BUDGET_USD === undefined
    ) {
      return 'BUDGETS_NOT_CONFIGURED';
    }
    const policy = first.policy as unknown as ReservationPolicy;
    const reservation = BigInt(policy.reservedMicros);
    if ((await exposureMicros(tx, first.periodMonth, first.userId)) + reservation > userBudget) {
      return 'USER_BUDGET_EXHAUSTED';
    }
    if ((await exposureMicros(tx, first.periodMonth)) + reservation > globalBudget) {
      return 'GLOBAL_BUDGET_EXHAUSTED';
    }
    await reserve(tx, {
      runId,
      userId: first.userId,
      month: first.periodMonth,
      policy,
      attemptNo,
    });
    return null;
  }

  private async poll(
    execution: Execution,
    responseId: string,
    submittedAt: Date,
    initial: ProviderSnapshot | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const { claim, provider, stored } = execution;
    const deadline = submittedAt.getTime() + stored.config.deadlineSeconds * 1_000;
    let latest = initial;
    let known = initial;
    let needsFetch = initial === null;

    for (;;) {
      if (latest) {
        const problems = boundsProblems(stored, latest);
        if (problems.length > 0) {
          return this.onUnconfirmedBounds(execution, responseId, latest, known, problems);
        }
        if (isTerminal(latest)) return this.finishTerminal(execution, latest, known);
      }
      if (await this.ownerSuspended(execution)) {
        return this.onOwnerSuspended(execution, responseId, known);
      }
      if (this.clock.now().getTime() >= deadline) {
        return this.onDeadline(execution, responseId, known);
      }
      if (!needsFetch) await abortableSleep(this.config.OPENAI_POLL_INTERVAL_MS, signal);
      if (signal?.aborted) return this.handOver(claim);
      needsFetch = false;
      await this.renewLease(claim);
      try {
        latest = await provider.retrieve(responseId);
        known = mergeSnapshots(known, latest);
        await this.observe(claim, responseId, latest);
      } catch (error) {
        if (error instanceof StaleLeaseError) throw error;
        if (error instanceof ProviderError && error.gone) {
          return this.finishWithoutReport(
            execution,
            'UNCERTAIN',
            'RESPONSE_NOT_RETRIEVABLE',
            known,
          );
        }
        // Polling is not billed; keep trying until the deadline.
        this.logger.warn({ message: 'Research poll failed', runId: claim.id, ...errorInfo(error) });
      }
    }
  }

  /** Never accepts output whose bounds were not confirmed; stops the request if possible. */
  private async onUnconfirmedBounds(
    execution: Execution,
    responseId: string,
    latest: ProviderSnapshot,
    known: ProviderSnapshot | null,
    problems: string[],
  ): Promise<void> {
    const code = `BOUNDS_NOT_CONFIRMED:${problems.join(',')}`;
    if (isTerminal(latest)) {
      // The provider already finished; nothing is running. Output is discarded.
      return this.finishWithoutReport(execution, 'FAILED', code, known);
    }
    const cancelled = await this.cancelQuietly(execution, responseId);
    if (cancelled) await this.observe(execution.claim, responseId, cancelled);
    const merged = mergeSnapshots(known, cancelled);
    return isTerminal(cancelled)
      ? this.finishWithoutReport(execution, 'FAILED', code, merged)
      : this.finishWithoutReport(execution, 'UNCERTAIN', `${code};CANCEL_UNCONFIRMED`, merged);
  }

  private async onDeadline(
    execution: Execution,
    responseId: string,
    known: ProviderSnapshot | null,
  ): Promise<void> {
    const cancelled = await this.cancelQuietly(execution, responseId);
    if (cancelled) await this.observe(execution.claim, responseId, cancelled);
    const merged = mergeSnapshots(known, cancelled);
    if (!isTerminal(cancelled)) {
      // Cancellation failed or did not confirm termination: the request may still run and bill.
      return this.finishWithoutReport(
        execution,
        'UNCERTAIN',
        'DEADLINE_CANCEL_UNCONFIRMED',
        merged,
      );
    }
    if (cancelled.status === 'completed') {
      const problems = boundsProblems(execution.stored, cancelled);
      if (problems.length > 0) {
        return this.finishWithoutReport(
          execution,
          'FAILED',
          `BOUNDS_NOT_CONFIRMED:${problems.join(',')}`,
          merged,
        );
      }
      return this.finishTerminal(execution, cancelled, merged);
    }
    return this.finishWithoutReport(execution, 'FAILED', 'DEADLINE_EXCEEDED', merged);
  }

  /** The run's durable suspension decision, or a currently suspended owner. */
  private async ownerSuspended(execution: Execution): Promise<boolean> {
    const run = await this.prisma.researchRun.findUnique({
      where: { id: execution.claim.id },
      select: { deliverySuppressionReason: true, user: { select: { status: true } } },
    });
    return run?.deliverySuppressionReason === 'USER_SUSPENDED' || run?.user?.status === 'SUSPENDED';
  }

  /**
   * Finalizes the current attempt's reservation (live runs only) inside the
   * fenced transaction that finishes the run: a stale worker fails the fenced
   * update first and can neither settle nor release. Replays are no-ops (ledger).
   */
  private async settle(
    tx: Tx,
    claim: Claim,
    outcome: RunAccounting['outcome'],
    reason: string,
  ): Promise<void> {
    const run = await tx.researchRun.findUniqueOrThrow({
      where: { id: claim.id },
      select: {
        usage: true,
        providerModel: true,
        providerResponseId: true,
        toolCallCount: true,
        currentAttemptNo: true,
      },
    });
    if (outcome === 'release') {
      await settleRun(tx, claim.id, { outcome, reason }, run.currentAttemptNo);
      return;
    }
    // Observed items of this attempt's response, not billed searches (docs/ACCOUNTING.md).
    const observed = run.providerResponseId
      ? await tx.researchToolItem.count({
          where: { runId: claim.id, responseId: run.providerResponseId },
        })
      : 0;
    await settleRun(
      tx,
      claim.id,
      {
        outcome,
        reason,
        usage: (run.usage as unknown as ProviderSnapshot['usage']) ?? null,
        returnedModel: run.providerModel,
        observedSearchItems: Math.max(observed, run.toolCallCount ?? 0),
      },
      run.currentAttemptNo,
    );
  }

  /**
   * The owner was suspended while the request was at the provider. Requests
   * cancellation; only a terminal provider answer counts as confirmed. A
   * completed answer is stored as a report (its delivery is suppressed).
   */
  private async onOwnerSuspended(
    execution: Execution,
    responseId: string,
    known: ProviderSnapshot | null,
  ): Promise<void> {
    this.logger.warn({
      message: 'Run owner suspended; cancelling research',
      runId: execution.claim.id,
    });
    const cancelled = await this.cancelQuietly(execution, responseId);
    if (cancelled) await this.observe(execution.claim, responseId, cancelled);
    const merged = mergeSnapshots(known, cancelled);
    if (!isTerminal(cancelled)) {
      return this.finishWithoutReport(
        execution,
        'UNCERTAIN',
        'SUSPENDED_CANCEL_UNCONFIRMED',
        merged,
      );
    }
    if (cancelled.status === 'cancelled') {
      return this.finishWithoutReport(execution, 'CANCELLED', 'USER_SUSPENDED', merged);
    }
    const problems = boundsProblems(execution.stored, cancelled);
    if (problems.length > 0) {
      return this.finishWithoutReport(
        execution,
        'FAILED',
        `BOUNDS_NOT_CONFIRMED:${problems.join(',')}`,
        merged,
      );
    }
    return this.finishTerminal(execution, cancelled, merged);
  }

  /** `response` provides content; `known` provides the newest accounting. Bounds are already verified. */
  private async finishTerminal(
    execution: Execution,
    response: ProviderSnapshot,
    known: ProviderSnapshot | null,
  ): Promise<void> {
    const { claim, stored } = execution;
    const accounting = mergeSnapshots(known, response) ?? response;
    if (response.status !== 'completed') {
      const code =
        response.status === 'incomplete'
          ? `INCOMPLETE:${response.incompleteReason ?? 'unknown'}`
          : response.status === 'cancelled'
            ? 'PROVIDER_CANCELLED'
            : `PROVIDER_FAILED:${response.errorCode ?? 'unknown'}`;
      // Incomplete output is never delivered as a report.
      return this.finishWithoutReport(execution, 'FAILED', code, accounting);
    }
    const report = extractReport(response);
    if (!report) return this.finishWithoutReport(execution, 'FAILED', 'EMPTY_OUTPUT', accounting);

    const completedAt = this.clock.now();
    const parts = renderReport({
      runId: claim.id,
      checkedAt: completedAt,
      timeZone: stored.config.timeZone,
      outcome: report.outcome,
      warnings: report.warnings,
      simulated: response.simulated || stored.config.providerKind === 'fake',
      text: report.text,
      citations: report.citations,
      ...(execution.occurrenceAt ? { scheduledFor: execution.occurrenceAt } : {}),
    });
    await this.prisma.$transaction(async (tx) => {
      const run = await this.fenced(tx, claim, {
        ...this.resultFields(accounting),
        state: 'SUCCEEDED',
        outcome: report.outcome,
        reportText: report.text,
        citations: report.citations as unknown as Prisma.InputJsonValue,
        warnings: report.warnings,
        completedAt,
        leaseOwner: null,
        leaseUntil: null,
      });
      await this.syncAttempt(tx, claim, {
        outcome: 'PROVIDER_TERMINAL',
        failureCode: null,
        completedAt,
      });
      // Report is committed together with its delivery; sending happens afterwards.
      // The suspension decision is read after this transaction locked the run row,
      // so a concurrent suspension is either seen here or sees this delivery.
      await createDelivery(tx, {
        kind: 'REPORT',
        chatId: run.chatId,
        runId: claim.id,
        parts,
        suppressedBy: run.deliverySuppressionReason,
      });
      await this.settle(tx, claim, 'settle', 'SUCCEEDED');
      // Capacity is free again: queued runs are inspected now.
      await wakeQueuedRuns(tx, 'CAPACITY_FREED');
    });
    this.logger.log({
      message: 'Research succeeded',
      runId: claim.id,
      outcome: report.outcome,
      citations: report.citations.length,
      parts: parts.length,
    });
  }

  private async finishWithoutReport(
    execution: Execution,
    state: 'FAILED' | 'UNCERTAIN' | 'CANCELLED',
    failureCode: string,
    accounting?: ProviderSnapshot | null,
    options: { providerNotAccepted?: boolean } = {},
  ): Promise<void> {
    await this.prisma.$transaction((tx) =>
      this.finishInTx(tx, execution, state, failureCode, accounting, options),
    );
    const log = {
      message: `Research ${state.toLowerCase()}`,
      runId: execution.claim.id,
      failureCode,
    };
    if (state === 'UNCERTAIN' && execution.stored.config.providerKind !== 'fake') {
      this.logger.error({ ...log, action: 'Live work blocked until operator reconciliation' });
    } else {
      this.logger.warn(log);
    }
  }

  private async finishInTx(
    tx: Tx,
    execution: Execution,
    state: 'FAILED' | 'UNCERTAIN' | 'CANCELLED',
    failureCode: string,
    accounting?: ProviderSnapshot | null,
    options: { providerNotAccepted?: boolean } = {},
  ): Promise<void> {
    const { claim, stored } = execution;
    const simulated = stored.config.providerKind === 'fake';
    const completedAt = this.clock.now();
    // The provider response ID is never cleared: it is the reconciliation evidence.
    const run = await this.fenced(tx, claim, {
      ...(accounting ? this.resultFields(accounting) : {}),
      state,
      failureCode: failureCode.slice(0, 120),
      completedAt,
      leaseOwner: null,
      leaseUntil: null,
    });
    await this.syncAttempt(tx, claim, {
      outcome:
        state === 'UNCERTAIN'
          ? 'UNCERTAIN'
          : options.providerNotAccepted
            ? 'NOT_ACCEPTED'
            : 'PROVIDER_TERMINAL',
      failureCode: failureCode.slice(0, 120),
      completedAt,
    });
    // Delivery is suppressed later if the owner is suspended.
    const text =
      state === 'UNCERTAIN'
        ? messages.runUncertain(claim.id, failureCode, simulated)
        : state === 'CANCELLED'
          ? messages.runCancelled(claim.id, failureCode)
          : messages.runFailed(claim.id, failureCode);
    await createStatusDelivery(
      tx,
      run.chatId,
      text,
      claim.id,
      undefined,
      run.deliverySuppressionReason,
    );
    // Accounting: nothing could have been billed before submission or when the
    // provider refused the request; an ambiguous outcome stays unresolved;
    // otherwise the provider reached a terminal state and usage is settled.
    const outcome =
      options.providerNotAccepted || run.submissionState === 'NOT_SUBMITTED'
        ? 'release'
        : state === 'UNCERTAIN'
          ? 'unresolved'
          : 'settle';
    await this.settle(tx, claim, outcome, failureCode);
    await wakeQueuedRuns(tx, 'CAPACITY_FREED');
  }

  /** Accounting fields; missing usage never overwrites stored usage. */
  private resultFields(snapshot: ProviderSnapshot): Prisma.ResearchRunUpdateManyMutationInput {
    return {
      providerStatus: snapshot.status,
      ...(snapshot.model ? { providerModel: snapshot.model } : {}),
      ...(snapshot.usage ? { usage: snapshot.usage as unknown as Prisma.InputJsonValue } : {}),
      toolCallCount: snapshot.webSearchCalls,
      sources: snapshot.sources,
    };
  }

  /**
   * Mirrors the run's current-attempt fields (written by the fenced update just
   * before, in the same transaction) into the attempt record, plus `extra`.
   * Creates the record when it is missing (runs that reached submission before
   * TRB-060). Nothing is recorded for an attempt that never reached submission.
   */
  private async syncAttempt(
    tx: Tx,
    claim: Claim,
    extra: {
      outcome?: 'PROVIDER_TERMINAL' | 'NOT_ACCEPTED' | 'UNCERTAIN';
      failureCode?: string | null;
      completedAt?: Date;
    },
  ): Promise<void> {
    const run = await tx.researchRun.findUniqueOrThrow({
      where: { id: claim.id },
      select: {
        currentAttemptNo: true,
        submissionState: true,
        submittedAt: true,
        providerResponseId: true,
        providerStatus: true,
        providerModel: true,
        usage: true,
        toolCallCount: true,
      },
    });
    if (run.submissionState === 'NOT_SUBMITTED') return;
    const fields = {
      submissionState: run.submissionState,
      submittedAt: run.submittedAt,
      providerResponseId: run.providerResponseId,
      providerStatus: run.providerStatus,
      providerModel: run.providerModel,
      usage: run.usage === null ? Prisma.DbNull : (run.usage as Prisma.InputJsonValue),
      toolCallCount: run.toolCallCount,
      ...extra,
    };
    await tx.researchAttempt.upsert({
      where: { runId_attemptNo: { runId: claim.id, attemptNo: run.currentAttemptNo } },
      create: {
        runId: claim.id,
        attemptNo: run.currentAttemptNo,
        fencingToken: claim.fencingToken,
        workerId: this.workerId,
        ...fields,
      },
      update: fields,
    });
  }

  /**
   * Records one provider snapshot while the run is held: newest status, usage
   * when reported, and its tool items. Fenced, so a stale worker records nothing.
   */
  private async observe(
    claim: Claim,
    responseId: string,
    snapshot: ProviderSnapshot,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.fenced(tx, claim, {
        providerStatus: snapshot.status,
        toolTelemetryVersion: TOOL_TELEMETRY_VERSION,
        ...(snapshot.usage ? { usage: snapshot.usage as unknown as Prisma.InputJsonValue } : {}),
      });
      await this.syncAttempt(tx, claim, {});
      await recordToolItems(tx, claim.id, responseId, snapshot.toolItems);
    });
  }

  /** Fenced update; returns the run's destination and suspension decision for follow-up writes. */
  private async fenced(
    client: Tx | PrismaService,
    claim: Claim,
    data: Prisma.ResearchRunUpdateManyMutationInput,
  ): Promise<{
    chatId: bigint;
    deliverySuppressionReason: string | null;
    submissionState: string;
  }> {
    const result = await client.researchRun.updateMany({
      where: { id: claim.id, fencingToken: claim.fencingToken, state: 'RUNNING' },
      data,
    });
    if (result.count !== 1) throw new StaleLeaseError();
    return client.researchRun.findUniqueOrThrow({
      where: { id: claim.id },
      select: { chatId: true, deliverySuppressionReason: true, submissionState: true },
    });
  }

  private async renewLease(claim: Claim): Promise<void> {
    const updated = await this.prisma.$executeRaw`
      UPDATE research_run SET lease_until = now() + ${RUN_LEASE_SECONDS} * interval '1 second'
       WHERE id = ${claim.id}::uuid AND fencing_token = ${claim.fencingToken} AND state = 'RUNNING'`;
    if (updated !== 1) throw new StaleLeaseError();
  }

  /**
   * On shutdown: releases the lease and wakes the run in one transaction, so
   * another worker (or the next process) resumes polling the saved response at
   * once; nothing is finalized and no provider call is made.
   */
  private async handOver(claim: Claim): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const released = await tx.$executeRaw`
        UPDATE research_run SET lease_until = now()
         WHERE id = ${claim.id}::uuid AND fencing_token = ${claim.fencingToken} AND state = 'RUNNING'`;
      if (released === 1) await wakeRun(tx, claim.id, 'SHUTDOWN_HANDOVER');
    });
    this.logger.log({ message: 'Research run handed over on shutdown', runId: claim.id });
  }

  /** Returns the provider's answer to the cancel request, or null when it is unknown. */
  private async cancelQuietly(
    execution: Execution,
    responseId: string,
  ): Promise<ProviderSnapshot | null> {
    // The cancel call must not outlive the lease (a stale worker cancels nothing).
    await this.renewLease(execution.claim);
    try {
      return await execution.provider.cancel(responseId);
    } catch (error) {
      this.logger.warn({
        message: 'Research cancel failed',
        runId: execution.claim.id,
        ...errorInfo(error),
      });
      return null;
    }
  }
}
