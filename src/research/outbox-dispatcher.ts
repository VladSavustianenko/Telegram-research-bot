import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { AppLifecycle } from '../common/lifecycle';
import { WorkerLoop, loopStaleAfterMs } from '../common/worker-loop';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { ExecutionGate } from '../operations/execution-gate';
import { QueueService, RESEARCH_QUEUE } from '../queue/queue.service';
import { cancelOverdueQueued, cancelUnadmitted } from './lifecycle';
import { EXECUTE_EVENT, TERMINAL_RUN_STATES, WAKE_EVENT } from './wake';

/** Events published per dispatcher transaction. */
const DISPATCH_BATCH = 20;
/** Bound of one dispatcher transaction (lock, publish, acknowledge a batch). */
const DISPATCH_TRANSACTION_TIMEOUT_MS = 15_000;
/** How often the recovery sweep runs in the background. */
export const SWEEP_INTERVAL_MS = 30_000;
/**
 * A queued run whose last event was dispatched this long ago and that has no
 * pending event lost its job (failed after retries, deleted by an operator);
 * the sweep wakes it again. Longer than any deferral delay.
 */
export const LOST_JOB_SECONDS = 600;
const SHUTDOWN_WAIT_MS = 10_000;

const terminal = new Set<string>(TERMINAL_RUN_STATES);

/**
 * Transactional outbox → pg-boss (docs/QUEUE.md).
 *
 * Publication: due events are locked (FOR UPDATE SKIP LOCKED, so several
 * dispatchers never take the same event), published through pg-boss's Prisma
 * adapter in the same transaction, and marked dispatched; the job and the
 * acknowledgement commit or roll back together. A crash before the commit
 * leaves the event pending and it is published again later. The job ID is the
 * event ID, so even a repeated publication of one event is a no-op while its
 * job is retained. An event of a run that is already finished is cancelled
 * instead of published.
 *
 * Recovery sweep (the durability floor, independent of pg-boss state):
 * cancels queued runs without admission evidence or past the maximum queue
 * wait, wakes RUNNING runs whose lease expired (dead worker) and wakes queued
 * runs whose job was lost. Duplicate wake-ups are harmless: every job
 * re-inspects the run in the database.
 */
@Injectable()
export class OutboxDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private loop: WorkerLoop | undefined;
  private lastSweep = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: Env,
    private readonly queue: QueueService,
    private readonly lifecycle: AppLifecycle,
    private readonly gate: ExecutionGate,
  ) {}

  onApplicationBootstrap(): void {
    // Runs whenever this process has a queue (as before TRB-100: started by queue.onUp).
    if (this.config.BACKGROUND_WORKERS !== 'on' || this.queue.status === 'disabled') return;
    const interval = this.config.WORKER_POLL_INTERVAL_MS;
    this.lifecycle.register('outbox-dispatcher', { staleAfterMs: loopStaleAfterMs(interval) });
    this.gate.whenOpen(() =>
      this.queue.onUp(() => {
        this.loop = new WorkerLoop('Outbox dispatcher', interval, () => this.tick(), this.logger, {
          lifecycle: this.lifecycle,
          component: 'outbox-dispatcher',
        });
        this.loop.start();
        return Promise.resolve();
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.loop?.stop(SHUTDOWN_WAIT_MS);
  }

  /** One background pass: the sweep when due, then one publication batch. */
  async tick(): Promise<boolean> {
    if (Date.now() - this.lastSweep >= SWEEP_INTERVAL_MS) {
      this.lastSweep = Date.now();
      await this.sweep();
    }
    return (await this.dispatchDue()) > 0;
  }

  /** Publishes up to one batch of due events. Returns the number of events handled. */
  async dispatchDue(): Promise<number> {
    if (!this.queue.has(RESEARCH_QUEUE)) return 0;
    return this.prisma.$transaction(
      async (tx) => {
        const events = await tx.$queryRaw<{ id: string; runId: string; state: string }[]>`
          SELECT o.id, o.run_id AS "runId", r.state::text AS state
            FROM outbox_event o JOIN research_run r ON r.id = o.run_id
           WHERE o.dispatched_at IS NULL AND o.cancelled_at IS NULL AND o.available_at <= now()
             AND o.type IN (${EXECUTE_EVENT}, ${WAKE_EVENT})
           ORDER BY o.available_at, o.created_at, o.id
           LIMIT ${DISPATCH_BATCH}
             FOR UPDATE OF o SKIP LOCKED`;
        for (const event of events) {
          if (terminal.has(event.state)) {
            // Finished work is never published as executable.
            await tx.$executeRaw`UPDATE outbox_event SET cancelled_at = now() WHERE id = ${event.id}::uuid`;
            continue;
          }
          await this.queue.publish(tx, { runId: event.runId, eventId: event.id });
          await tx.$executeRaw`UPDATE outbox_event SET dispatched_at = now() WHERE id = ${event.id}::uuid`;
        }
        return events.length;
      },
      { timeout: DISPATCH_TRANSACTION_TIMEOUT_MS },
    );
  }

  /** Recovery sweep; see the class comment. Safe to run concurrently and repeatedly. */
  async sweep(): Promise<void> {
    const unadmitted = await cancelUnadmitted(this.prisma);
    if (unadmitted > 0) {
      this.logger.warn({
        message: 'Cancelled queued runs without admission evidence',
        count: unadmitted,
      });
    }
    const overdue = await cancelOverdueQueued(
      this.prisma,
      this.config.RESEARCH_QUEUE_MAX_WAIT_SECONDS,
    );
    if (overdue > 0) {
      this.logger.warn({ message: 'Cancelled queued runs past the maximum wait', count: overdue });
    }
    const woken = await this.prisma.$executeRaw`
      INSERT INTO outbox_event (id, operation_key, type, run_id, payload, available_at)
      SELECT gen_random_uuid(), ${WAKE_EVENT} || ':' || gen_random_uuid(), ${WAKE_EVENT}, r.id,
             jsonb_build_object('runId', r.id::text,
                                'reason', CASE WHEN r.state = 'RUNNING' THEN 'LEASE_EXPIRED' ELSE 'JOB_LOST' END),
             now()
        FROM research_run r
       WHERE NOT EXISTS (SELECT 1 FROM outbox_event p
                          WHERE p.run_id = r.id AND p.dispatched_at IS NULL AND p.cancelled_at IS NULL)
         AND ((r.state = 'RUNNING' AND (r.lease_until IS NULL OR r.lease_until < now()))
           OR (r.state = 'QUEUED'
               AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= now())
               AND NOT EXISTS (SELECT 1 FROM outbox_event d
                                WHERE d.run_id = r.id
                                  AND d.dispatched_at > now() - ${LOST_JOB_SECONDS} * interval '1 second')))
      ON CONFLICT (run_id) WHERE dispatched_at IS NULL AND cancelled_at IS NULL DO NOTHING`;
    if (woken > 0) this.logger.warn({ message: 'Recovery sweep woke runs', count: woken });
  }
}
