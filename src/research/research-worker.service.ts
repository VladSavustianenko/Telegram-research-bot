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
import { hasUnresolvedLiveUncertainty } from './uncertainty';

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
    try {
      const rows = await this.prisma.$queryRaw<Claim[]>`
        UPDATE research_run
           SET state = 'RUNNING', lease_owner = ${this.workerId},
               lease_until = now() + ${RUN_LEASE_SECONDS} * interval '1 second',
               fencing_token = fencing_token + 1, started_at = COALESCE(started_at, now()),
               updated_at = now()
         WHERE id = (SELECT q.id FROM research_run q
                      WHERE q.state = 'QUEUED'
                        AND NOT EXISTS (SELECT 1 FROM research_run r WHERE r.state = 'RUNNING')
                        AND (q.provider_kind <> 'openai' OR NOT EXISTS (
                              SELECT 1 FROM research_run u
                               WHERE u.state = 'UNCERTAIN' AND u.provider_kind = 'openai'
                                 AND u.reconciled_at IS NULL))
                      ORDER BY q.created_at, q.id
                      LIMIT 1
                      FOR UPDATE SKIP LOCKED)
        RETURNING id, fencing_token AS "fencingToken"`;
      return rows[0] ?? null;
    } catch (error) {
      // research_run_single_running: another worker started a run concurrently.
      if (isUniqueViolation(error)) return null;
      throw error;
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
      await this.fenced(this.prisma, claim, {
        state: 'QUEUED',
        leaseOwner: null,
        leaseUntil: null,
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
    execution.stored = { config: stored.config, context, request };
    // Record the intent (and the immutable request) before the potentially billed call.
    await this.fenced(this.prisma, claim, {
      submissionState: 'SUBMITTING',
      submittedAt,
      requestSnapshot: execution.stored as unknown as Prisma.InputJsonValue,
    });

    let first: ProviderSnapshot;
    try {
      first = await provider.submit(request);
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : null;
      const code = providerError?.code ?? 'SUBMIT_UNEXPECTED';
      this.logger.warn({ message: 'Research submission failed', runId: run.id, code });
      return providerError?.certainty === 'not_accepted'
        ? this.finishWithoutReport(execution, 'FAILED', code)
        : this.finishWithoutReport(execution, 'UNCERTAIN', code);
    }

    // Persist the response ID immediately; bounds are verified afterwards in poll()
    // and again after any recovery, so a crash in between cannot skip verification.
    try {
      await this.fenced(this.prisma, claim, {
        submissionState: 'SUBMITTED',
        providerResponseId: first.id,
        providerStatus: first.status,
        providerModel: first.model,
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
        await this.recordProgress(claim, latest);
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
      await createDelivery(tx, { kind: 'REPORT', chatId: run.chatId, runId: claim.id, parts });
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
    state: 'FAILED' | 'UNCERTAIN',
    failureCode: string,
    accounting?: ProviderSnapshot | null,
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
      const text =
        state === 'UNCERTAIN'
          ? messages.runUncertain(claim.id, failureCode, simulated)
          : messages.runFailed(claim.id, failureCode);
      await createStatusDelivery(tx, run.chatId, text, claim.id);
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

  /** Newest provider status (and usage, when reported) while polling. */
  private async recordProgress(claim: Claim, snapshot: ProviderSnapshot): Promise<void> {
    await this.fenced(this.prisma, claim, {
      providerStatus: snapshot.status,
      ...(snapshot.usage ? { usage: snapshot.usage as unknown as Prisma.InputJsonValue } : {}),
    });
  }

  /** Fenced update; returns the run's destination for follow-up writes. */
  private async fenced(
    client: Tx | PrismaService,
    claim: Claim,
    data: Prisma.ResearchRunUpdateManyMutationInput,
  ): Promise<{ chatId: bigint }> {
    const result = await client.researchRun.updateMany({
      where: { id: claim.id, fencingToken: claim.fencingToken, state: 'RUNNING' },
      data,
    });
    if (result.count !== 1) throw new StaleLeaseError();
    return client.researchRun.findUniqueOrThrow({
      where: { id: claim.id },
      select: { chatId: true },
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
