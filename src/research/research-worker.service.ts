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
import { abortableSleep } from '../common/abortable-sleep';
import { CLOCK, type Clock } from '../common/clock';
import { errorInfo } from '../common/error-info';
import { WorkerLoop } from '../common/worker-loop';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { isUniqueViolation, type Tx } from '../database/prisma-errors';
import { PrismaService } from '../database/prisma.service';
import { createDelivery, createStatusDelivery } from '../delivery/delivery-records';
import { messages } from '../delivery/messages';
import { renderReport } from '../delivery/report-renderer';
import type { Prisma } from '../generated/prisma/client';
import { submissionDenial } from '../identity/authorization';
import { lockUserForShare } from '../identity/users';
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
import { EXECUTE_EVENT } from './admission';
import { settleRun, type RunAccounting } from '../accounting/ledger';

export const RUN_LEASE_SECONDS = 60;
const SHUTDOWN_WAIT_MS = 10_000;

/** Stored in research_run.request_snapshot. `request` is written before submission and never changed. */
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
}

/** The lease was lost to another worker; this worker must stop touching the run. */
export class StaleLeaseError extends Error {
  constructor() {
    super('research run lease lost');
    this.name = 'StaleLeaseError';
  }
}

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

/**
 * Database-backed research execution (prototype, one run globally).
 *
 * Recovery policy for a run whose lease expired:
 * - NOT_SUBMITTED: nothing was sent; execute normally.
 * - SUBMITTING: a request may have reached the provider but no response ID was
 *   saved; UNCERTAIN, never resubmitted automatically.
 * - SUBMITTED: resume polling the saved response ID (bounds re-verified); never resubmit.
 *
 * Termination is "confirmed" only when the provider returns a terminal status.
 * A failed, missing or non-terminal cancellation leaves the run UNCERTAIN.
 * Unreconciled live UNCERTAIN runs block claiming of further live work.
 * Every write after claiming is fenced by (id, fencing_token, state=RUNNING).
 *
 * Owner eligibility (TRB-030) is rechecked before a new submission, in the
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
  private loop: WorkerLoop | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(RESEARCH_PROVIDER) private readonly provider: ResearchProvider | null,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.BACKGROUND_WORKERS !== 'on' || !this.provider) return;
    this.loop = new WorkerLoop(
      'Research worker',
      this.config.WORKER_POLL_INTERVAL_MS,
      (signal) => this.tick(signal),
      this.logger,
    );
    this.loop.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.loop?.stop(SHUTDOWN_WAIT_MS);
  }

  /** Claims and executes at most one run. Returns true when a run was handled. */
  async tick(signal?: AbortSignal): Promise<boolean> {
    if (!this.provider) return false;
    const claim = (await this.takeOverExpired()) ?? (await this.claimQueued());
    if (!claim) return false;
    try {
      await this.execute(claim, this.provider, signal);
    } catch (error) {
      if (error instanceof StaleLeaseError) {
        this.logger.warn({ message: 'Research run lease lost; stopping', runId: claim.id });
      } else {
        // The lease expires and recovery applies the policy above.
        this.logger.error({
          message: 'Research execution error',
          runId: claim.id,
          ...errorInfo(error),
        });
      }
    }
    return true;
  }

  /**
   * Claims the oldest eligible QUEUED run. Live runs are not eligible while an
   * unreconciled live run is UNCERTAIN. The check, the single-RUNNING check and
   * the claim are one statement (one snapshot): a run that becomes UNCERTAIN is
   * RUNNING until that commit, so no interleaving lets a live run start.
   */
  private async claimQueued(): Promise<Claim | null> {
    await this.cancelUnadmitted();
    try {
      // Only runs with a pending execution event (written by admission) are
      // eligible; the claim consumes that event in the same statement, so the
      // in-process worker is the only execution path until TRB-060.
      const rows = await this.prisma.$queryRaw<Claim[]>`
        WITH claimed AS (
          UPDATE research_run
             SET state = 'RUNNING', lease_owner = ${this.workerId},
                 lease_until = now() + ${RUN_LEASE_SECONDS} * interval '1 second',
                 fencing_token = fencing_token + 1, started_at = COALESCE(started_at, now()),
                 updated_at = now()
           WHERE id = (SELECT q.id FROM research_run q
                        WHERE q.state = 'QUEUED'
                          AND EXISTS (SELECT 1 FROM outbox_event o
                                       WHERE o.run_id = q.id AND o.type = ${EXECUTE_EVENT}
                                         AND o.dispatched_at IS NULL AND o.cancelled_at IS NULL)
                          AND NOT EXISTS (SELECT 1 FROM research_run r WHERE r.state = 'RUNNING')
                          AND (q.provider_kind <> 'openai' OR NOT EXISTS (
                                SELECT 1 FROM research_run u
                                 WHERE u.state = 'UNCERTAIN' AND u.provider_kind = 'openai'
                                   AND u.reconciled_at IS NULL))
                        ORDER BY q.created_at, q.id
                        LIMIT 1
                        FOR UPDATE SKIP LOCKED)
          RETURNING id, fencing_token),
        consumed AS (
          UPDATE outbox_event SET dispatched_at = now()
           WHERE run_id IN (SELECT id FROM claimed) AND type = ${EXECUTE_EVENT}
             AND dispatched_at IS NULL AND cancelled_at IS NULL)
        SELECT id, fencing_token AS "fencingToken" FROM claimed`;
      return rows[0] ?? null;
    } catch (error) {
      // research_run_single_running: another worker started a run concurrently.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /**
   * Queued runs without admission evidence (no pending execution event: rows
   * from before TRB-050 or inserted outside admission) are never executed. They
   * are cancelled before any submission; there is no reservation to release.
   */
  private async cancelUnadmitted(): Promise<void> {
    const cancelled = await this.prisma.$executeRaw`
      UPDATE research_run q
         SET state = 'CANCELLED', failure_code = 'ADMISSION_EVIDENCE_MISSING',
             completed_at = now(), updated_at = now()
       WHERE q.state = 'QUEUED'
         AND NOT EXISTS (SELECT 1 FROM outbox_event o
                          WHERE o.run_id = q.id AND o.type = ${EXECUTE_EVENT}
                            AND o.dispatched_at IS NULL AND o.cancelled_at IS NULL)`;
    if (cancelled > 0) {
      this.logger.warn({
        message: 'Cancelled queued runs without admission evidence',
        count: cancelled,
      });
    }
  }

  private async takeOverExpired(): Promise<Claim | null> {
    const rows = await this.prisma.$queryRaw<Claim[]>`
      UPDATE research_run
         SET lease_owner = ${this.workerId},
             lease_until = now() + ${RUN_LEASE_SECONDS} * interval '1 second',
             fencing_token = fencing_token + 1, updated_at = now()
       WHERE id = (SELECT id FROM research_run
                    WHERE state = 'RUNNING' AND lease_until < now()
                    ORDER BY lease_until
                    LIMIT 1
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
    const execution: Execution = { claim, provider, stored };

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
      return this.poll(execution, run.providerResponseId, run.submittedAt, null, signal);
    }

    // Defence in depth for the fail-closed gate (normally enforced at claim time).
    if (provider.kind === 'openai' && (await hasUnresolvedLiveUncertainty(this.prisma))) {
      await this.prisma.$transaction(async (tx) => {
        await this.fenced(tx, claim, { state: 'QUEUED', leaseOwner: null, leaseUntil: null });
        // The run is eligible again: its execution event becomes pending again.
        await tx.$executeRaw`
          UPDATE outbox_event SET dispatched_at = NULL
           WHERE run_id = ${claim.id}::uuid AND type = ${EXECUTE_EVENT} AND cancelled_at IS NULL`;
      });
      this.logger.warn({
        message: 'Live run returned to queue: unresolved uncertainty',
        runId: run.id,
      });
      return;
    }

    const submittedAt = this.clock.now();
    const context = buildResearchContext(submittedAt, run.createdAt, stored.config.timeZone);
    const request = buildResearchRequest(run.id, run.prompt, stored.config, context);
    const nextStored: StoredSnapshot = { config: stored.config, context, request };
    // Recheck the owner and record the intent (and the immutable request) before
    // the potentially billed call, atomically.
    const denial = await this.prisma.$transaction(async (tx) => {
      const owner = run.userId ? await lockUserForShare(tx, run.userId) : null;
      const reason = submissionDenial(owner, provider.kind, this.config);
      if (reason) return reason;
      // A live run is submitted only against its own reservation (admission evidence).
      if (provider.kind === 'openai') {
        const reservation = await tx.budgetReservation.findUnique({
          where: { runId: claim.id },
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
      return providerError?.certainty === 'not_accepted'
        ? this.finishWithoutReport(execution, 'FAILED', code, null, { providerNotAccepted: true })
        : this.finishWithoutReport(execution, 'UNCERTAIN', code);
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
      if (signal?.aborted) return this.releaseLease(claim);
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
   * Finalizes the run's reservation (live runs only) inside the fenced
   * transaction that finishes the run: a stale worker fails the fenced update
   * first and can neither settle nor release. Replays are no-ops (ledger).
   */
  private async settle(
    tx: Tx,
    claim: Claim,
    outcome: RunAccounting['outcome'],
    reason: string,
  ): Promise<void> {
    if (outcome === 'release') {
      await settleRun(tx, claim.id, { outcome, reason });
      return;
    }
    const run = await tx.researchRun.findUniqueOrThrow({
      where: { id: claim.id },
      select: { usage: true, providerModel: true, toolCallCount: true },
    });
    const observed = await tx.researchToolItem.count({ where: { runId: claim.id } });
    await settleRun(tx, claim.id, {
      outcome,
      reason,
      usage: (run.usage as unknown as ProviderSnapshot['usage']) ?? null,
      returnedModel: run.providerModel,
      // Observed items, not billed searches (docs/ACCOUNTING.md).
      observedSearchItems: Math.max(observed, run.toolCallCount ?? 0),
    });
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
    const { claim, stored } = execution;
    const simulated = stored.config.providerKind === 'fake';
    await this.prisma.$transaction(async (tx) => {
      // The provider response ID is never cleared: it is the reconciliation evidence.
      const run = await this.fenced(tx, claim, {
        ...(accounting ? this.resultFields(accounting) : {}),
        state,
        failureCode: failureCode.slice(0, 120),
        completedAt: this.clock.now(),
        leaseOwner: null,
        leaseUntil: null,
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
    });
    const log = { message: `Research ${state.toLowerCase()}`, runId: claim.id, failureCode };
    if (state === 'UNCERTAIN' && !simulated) {
      this.logger.error({ ...log, action: 'Live work blocked until operator reconciliation' });
    } else {
      this.logger.warn(log);
    }
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

  /** On shutdown: let another worker (or the next process) resume immediately. */
  private async releaseLease(claim: Claim): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE research_run SET lease_until = now()
       WHERE id = ${claim.id}::uuid AND fencing_token = ${claim.fencingToken} AND state = 'RUNNING'`;
  }

  /** Returns the provider's answer to the cancel request, or null when it is unknown. */
  private async cancelQuietly(
    execution: Execution,
    responseId: string,
  ): Promise<ProviderSnapshot | null> {
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
