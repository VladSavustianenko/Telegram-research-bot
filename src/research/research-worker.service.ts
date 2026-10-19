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

export const RUN_LEASE_SECONDS = 60;
const SHUTDOWN_WAIT_MS = 10_000;

/** Stored in research_run.request_snapshot. `request` is written before submission. */
interface StoredSnapshot {
  config: RunConfigSnapshot;
  context?: ResearchContext;
  request?: ResearchRequest;
}

interface Claim {
  id: string;
  fencingToken: number;
}

/** The lease was lost to another worker; this worker must stop touching the run. */
export class StaleLeaseError extends Error {
  constructor() {
    super('research run lease lost');
    this.name = 'StaleLeaseError';
  }
}

/**
 * Database-backed research execution (prototype, one run globally).
 *
 * Recovery policy for a run whose lease expired:
 * - NOT_SUBMITTED: nothing was sent; execute normally.
 * - SUBMITTING: a request may have reached the provider but no response ID was
 *   saved; mark UNCERTAIN and never resubmit automatically.
 * - SUBMITTED: resume polling the saved response ID; never resubmit.
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

  private async claimQueued(): Promise<Claim | null> {
    try {
      const rows = await this.prisma.$queryRaw<Claim[]>`
        UPDATE research_run
           SET state = 'RUNNING', lease_owner = ${this.workerId},
               lease_until = now() + ${RUN_LEASE_SECONDS} * interval '1 second',
               fencing_token = fencing_token + 1, started_at = COALESCE(started_at, now()),
               updated_at = now()
         WHERE id = (SELECT id FROM research_run
                      WHERE state = 'QUEUED'
                        AND NOT EXISTS (SELECT 1 FROM research_run WHERE state = 'RUNNING')
                      ORDER BY created_at, id
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

    // Never switch providers silently (e.g. a run admitted as live must not get fake results).
    if (stored.config.providerKind !== provider.kind) {
      return this.finishWithoutReport(claim, 'FAILED', 'PROVIDER_CHANGED');
    }

    if (run.submissionState === 'SUBMITTING') {
      return this.finishWithoutReport(claim, 'UNCERTAIN', 'SUBMISSION_INTERRUPTED');
    }
    if (run.submissionState === 'SUBMITTED') {
      if (!run.providerResponseId || !run.submittedAt)
        throw new Error('submitted run without response id');
      return this.poll(
        claim,
        provider,
        stored,
        run.providerResponseId,
        run.submittedAt,
        null,
        signal,
      );
    }

    const submittedAt = this.clock.now();
    const context = buildResearchContext(submittedAt, run.createdAt, stored.config.timeZone);
    const request = buildResearchRequest(run.id, run.prompt, stored.config, context);
    const snapshot: StoredSnapshot = { config: stored.config, context, request };
    // Record the intent before the potentially billed call.
    await this.fenced(this.prisma, claim, {
      submissionState: 'SUBMITTING',
      submittedAt,
      requestSnapshot: snapshot as unknown as Prisma.InputJsonValue,
    });

    let first: ProviderSnapshot;
    try {
      first = await provider.submit(request);
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : null;
      const code = providerError?.code ?? 'SUBMIT_UNEXPECTED';
      this.logger.warn({ message: 'Research submission failed', runId: run.id, code });
      return providerError?.certainty === 'not_accepted'
        ? this.finishWithoutReport(claim, 'FAILED', code)
        : this.finishWithoutReport(claim, 'UNCERTAIN', code);
    }

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

    const problems = unconfirmedBounds(request, first.bounds);
    if (problems.length > 0) {
      await this.cancelQuietly(provider, first.id, run.id);
      return this.finishWithoutReport(
        claim,
        'FAILED',
        `BOUNDS_NOT_CONFIRMED:${problems.join(',')}`,
        first,
      );
    }
    return this.poll(claim, provider, snapshot, first.id, submittedAt, first, signal);
  }

  private async poll(
    claim: Claim,
    provider: ResearchProvider,
    stored: StoredSnapshot,
    responseId: string,
    submittedAt: Date,
    initial: ProviderSnapshot | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const deadline = submittedAt.getTime() + stored.config.deadlineSeconds * 1_000;
    let latest = initial;
    let needsFetch = initial === null;

    for (;;) {
      if (latest && !NON_TERMINAL_STATUSES.has(latest.status)) {
        return this.finishTerminal(claim, stored, latest);
      }
      if (this.clock.now().getTime() >= deadline) {
        const cancelled = await this.cancelQuietly(provider, responseId, claim.id);
        if (cancelled?.status === 'completed') return this.finishTerminal(claim, stored, cancelled);
        return this.finishWithoutReport(claim, 'FAILED', 'DEADLINE_EXCEEDED', cancelled ?? latest);
      }
      if (!needsFetch) await abortableSleep(this.config.OPENAI_POLL_INTERVAL_MS, signal);
      if (signal?.aborted) return this.releaseLease(claim);
      needsFetch = false;
      await this.renewLease(claim);
      try {
        latest = await provider.retrieve(responseId);
      } catch (error) {
        if (error instanceof ProviderError && error.gone) {
          return this.finishWithoutReport(claim, 'UNCERTAIN', 'RESPONSE_NOT_RETRIEVABLE', latest);
        }
        // Polling is not billed; keep trying until the deadline.
        this.logger.warn({ message: 'Research poll failed', runId: claim.id, ...errorInfo(error) });
      }
    }
  }

  private async finishTerminal(
    claim: Claim,
    stored: StoredSnapshot,
    response: ProviderSnapshot,
  ): Promise<void> {
    if (response.status !== 'completed') {
      const code =
        response.status === 'incomplete'
          ? `INCOMPLETE:${response.incompleteReason ?? 'unknown'}`
          : response.status === 'cancelled'
            ? 'PROVIDER_CANCELLED'
            : `PROVIDER_FAILED:${response.errorCode ?? 'unknown'}`;
      // Incomplete output is never delivered as a report.
      return this.finishWithoutReport(claim, 'FAILED', code, response);
    }
    const report = extractReport(response);
    if (!report) return this.finishWithoutReport(claim, 'FAILED', 'EMPTY_OUTPUT', response);

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
        ...this.resultFields(response),
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
    claim: Claim,
    state: 'FAILED' | 'UNCERTAIN',
    failureCode: string,
    response?: ProviderSnapshot | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const run = await this.fenced(tx, claim, {
        ...(response ? this.resultFields(response) : {}),
        state,
        failureCode: failureCode.slice(0, 120),
        completedAt: this.clock.now(),
        leaseOwner: null,
        leaseUntil: null,
      });
      const text =
        state === 'UNCERTAIN'
          ? messages.runUncertain(claim.id, failureCode)
          : messages.runFailed(claim.id, failureCode);
      await createStatusDelivery(tx, run.chatId, text, claim.id);
    });
    this.logger.warn({ message: `Research ${state.toLowerCase()}`, runId: claim.id, failureCode });
  }

  private resultFields(response: ProviderSnapshot): Prisma.ResearchRunUpdateManyMutationInput {
    return {
      providerStatus: response.status,
      providerModel: response.model,
      usage: (response.usage ?? undefined) as Prisma.InputJsonValue | undefined,
      toolCallCount: response.webSearchCalls,
      sources: response.sources,
    };
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

  private async cancelQuietly(
    provider: ResearchProvider,
    responseId: string,
    runId: string,
  ): Promise<ProviderSnapshot | null> {
    try {
      return await provider.cancel(responseId);
    } catch (error) {
      this.logger.warn({ message: 'Research cancel failed', runId, ...errorInfo(error) });
      return null;
    }
  }
}
