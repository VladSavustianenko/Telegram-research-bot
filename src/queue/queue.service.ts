import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { PgBoss, fromPrisma, type Job, type Queue } from 'pg-boss';
import { errorInfo } from '../common/error-info';
import { APP_CONFIG } from '../config/config.module';
import { MAX_RUN_DEADLINE_SECONDS, type Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import { RESEARCH_PROVIDER, type ResearchProvider } from '../research/provider/provider.types';

/** The single research queue (docs/QUEUE.md). */
export const RESEARCH_QUEUE = 'research-execute';

/** A job only names the run to inspect; it is never permission to submit. */
export interface ResearchJobData {
  runId: string;
  eventId: string;
}

export type ResearchJob = Job<ResearchJobData>;

/**
 * Queue options (pg-boss 12.37). `standard` policy: no singleton constraint,
 * because a recovery job must be fetchable while the job of a dead or frozen
 * worker is still "active" in pg-boss (a singleton policy would delay
 * takeover until that job expires). Duplicates are bounded by the outbox (one
 * pending event per run, job ID = event ID); the database, not the queue,
 * prevents duplicate provider submissions. A job outlives the longest
 * legitimate execution (run deadline plus provider calls); if it expires
 * anyway, the redelivered job finds a live lease and does nothing. Handler
 * failures are infrastructure errors (the handler never retries provider
 * submissions), so a bounded retry with backoff only re-inspects the run.
 */
export const RESEARCH_QUEUE_OPTIONS = {
  policy: 'standard',
  expireInSeconds: MAX_RUN_DEADLINE_SECONDS + 360,
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,
  retryDelayMax: 300,
  retentionSeconds: 14 * 24 * 3600,
  deleteAfterSeconds: 7 * 24 * 3600,
} as const satisfies Omit<Queue, 'name'>;

export type QueueStatus = 'disabled' | 'starting' | 'up' | 'down' | 'stopped';

/** Delays between start attempts while the database is unavailable. */
const START_RETRY_MIN_MS = 1_000;
const START_RETRY_MAX_MS = 30_000;

/**
 * Owns the pg-boss instance. pg-boss lives in its own schema (QUEUE_SCHEMA),
 * which it creates and migrates at startup; Prisma migrations never touch it.
 * Started only when a research provider is configured. Maintenance (job
 * expiry, retention) runs only with BACKGROUND_WORKERS=on; tests drive jobs
 * through fetch/complete instead.
 *
 * Like the database client, a failed start does not stop the process: the
 * queue reports "down" in readiness and start is retried with backoff until it
 * succeeds or the application shuts down. Components that need the queue
 * register with onUp().
 */
@Injectable()
export class QueueService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private boss: PgBoss | null = null;
  private state: QueueStatus;
  private stopping = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly upCallbacks: (() => Promise<void>)[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: Env,
    @Optional() @Inject(RESEARCH_PROVIDER) provider: ResearchProvider | null,
  ) {
    this.state = provider ? 'starting' : 'disabled';
  }

  get status(): QueueStatus {
    return this.state;
  }

  get enabled(): boolean {
    return this.state === 'up';
  }

  /** Before any bootstrap hook, so that an available database gives a started queue at once. */
  async onModuleInit(): Promise<void> {
    if (this.state === 'disabled') return;
    await this.tryStart(START_RETRY_MIN_MS);
  }

  /** Runs `callback` once the queue is up (now, or after a later successful start). */
  onUp(callback: () => Promise<void>): void {
    if (this.state === 'up') {
      void this.runCallback(callback);
    } else if (this.state !== 'disabled') {
      this.upCallbacks.push(callback);
    }
  }

  private async runCallback(callback: () => Promise<void>): Promise<void> {
    try {
      await callback();
    } catch (error) {
      this.logger.error({ message: 'Queue component failed to start', ...errorInfo(error) });
    }
  }

  private async tryStart(retryDelayMs: number): Promise<void> {
    if (this.stopping) return;
    try {
      this.boss = await this.start();
      this.state = 'up';
      this.logger.log({ message: 'Queue started', schema: this.config.QUEUE_SCHEMA });
      for (const callback of this.upCallbacks.splice(0)) await this.runCallback(callback);
    } catch (error) {
      this.state = 'down';
      this.logger.error({ message: 'Queue start failed; retrying', ...errorInfo(error) });
      this.retryTimer = setTimeout(() => {
        void this.tryStart(Math.min(retryDelayMs * 2, START_RETRY_MAX_MS));
      }, retryDelayMs);
    }
  }

  private async start(): Promise<PgBoss> {
    const background = this.config.BACKGROUND_WORKERS === 'on';
    const boss = new PgBoss({
      connectionString: this.config.DATABASE_URL,
      schema: this.config.QUEUE_SCHEMA,
      application_name: 'trb-queue',
      max: 4,
      connectionTimeoutMillis: this.config.DATABASE_CONNECT_TIMEOUT_MS,
      migrate: true,
      createSchema: true,
      supervise: background,
      schedule: false,
      registerInstance: background,
      openTelemetry: { enabled: false },
    });
    // Without a listener an emitted 'error' would crash the process.
    boss.on('error', (error) => {
      this.logger.error({ message: 'Queue error', ...errorInfo(error) });
    });
    boss.on('warning', (warning) => {
      this.logger.warn({ message: 'Queue warning', warning: warning.message });
    });
    try {
      await boss.start();
      await this.ensureQueue(boss);
    } catch (error) {
      await boss.stop({ graceful: false }).catch(() => undefined);
      throw error;
    }
    return boss;
  }

  private async ensureQueue(boss: PgBoss): Promise<void> {
    const existing = await boss.getQueue(RESEARCH_QUEUE);
    if (!existing) {
      try {
        await boss.createQueue(RESEARCH_QUEUE, RESEARCH_QUEUE_OPTIONS);
        return;
      } catch (error) {
        // Another instance may have created it concurrently.
        if (!(await boss.getQueue(RESEARCH_QUEUE))) throw error;
      }
    } else if (existing.policy !== RESEARCH_QUEUE_OPTIONS.policy) {
      throw new Error(`Queue ${RESEARCH_QUEUE} has policy ${existing.policy}; expected standard`);
    }
    // Policy and the maximum retry delay are fixed at creation (pg-boss API); the rest is kept current.
    const options = RESEARCH_QUEUE_OPTIONS;
    await boss.updateQueue(RESEARCH_QUEUE, {
      expireInSeconds: options.expireInSeconds,
      retryLimit: options.retryLimit,
      retryDelay: options.retryDelay,
      retryBackoff: options.retryBackoff,
      retentionSeconds: options.retentionSeconds,
      deleteAfterSeconds: options.deleteAfterSeconds,
    });
  }

  private get started(): PgBoss {
    if (!this.boss || this.state !== 'up') throw new Error('Queue is not started');
    return this.boss;
  }

  /**
   * Publishes a job inside the caller's Prisma transaction (pg-boss's own
   * Prisma adapter), so the job and the outbox acknowledgement commit or roll
   * back together. The event ID is the job ID, so publishing one event twice
   * is a no-op while its job is retained (returns null).
   */
  publish(tx: Tx, data: ResearchJobData): Promise<string | null> {
    return this.started.send(RESEARCH_QUEUE, data, { id: data.eventId, db: fromPrisma(tx) });
  }

  /** Registers the background handler (one job at a time per process). */
  async work(handler: (job: ResearchJob) => Promise<unknown>): Promise<void> {
    await this.started.work<ResearchJobData>(
      RESEARCH_QUEUE,
      {
        batchSize: 1,
        pollingIntervalSeconds: Math.max(0.5, this.config.WORKER_POLL_INTERVAL_MS / 1_000),
      },
      async ([job]) => (job ? handler(job) : undefined),
    );
  }

  /** Stops fetching new jobs and waits (bounded) for the active handler. */
  async stopWork(timeoutMs: number): Promise<'stopped' | 'timeout'> {
    if (!this.boss || this.state !== 'up') return 'stopped';
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([
      this.boss.offWork(RESEARCH_QUEUE, { wait: true }).then(() => 'stopped' as const),
      timedOut,
    ]);
    clearTimeout(timer);
    return outcome;
  }

  /** Test and operator driver: claims one ready job (its handler must settle it). */
  async fetchOne(): Promise<ResearchJob | null> {
    const [job] = await this.started.fetch<ResearchJobData>(RESEARCH_QUEUE, { batchSize: 1 });
    return job ?? null;
  }

  async complete(job: ResearchJob): Promise<void> {
    await this.started.complete(RESEARCH_QUEUE, { id: job.id, retryCount: job.retryCount });
  }

  async fail(job: ResearchJob, error: unknown): Promise<void> {
    await this.started.fail(
      RESEARCH_QUEUE,
      { id: job.id, retryCount: job.retryCount },
      { error: errorInfo(error) },
    );
  }

  /** Runs pg-boss maintenance once (expiry of jobs whose handler vanished). */
  async supervise(): Promise<void> {
    await this.started.supervise(RESEARCH_QUEUE);
  }

  /** After workers stopped (onModuleDestroy): closes pg-boss's pool. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    const boss = this.boss;
    if (!boss) return;
    this.boss = null;
    this.state = 'stopped';
    try {
      await boss.stop({ graceful: true, timeout: 5_000 });
    } catch (error) {
      this.logger.warn({ message: 'Queue stop failed', ...errorInfo(error) });
    }
  }
}
