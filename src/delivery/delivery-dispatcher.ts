import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { errorInfo } from '../common/error-info';
import { AppLifecycle } from '../common/lifecycle';
import { WorkerLoop, loopStaleAfterMs } from '../common/worker-loop';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import { ExecutionGate } from '../operations/execution-gate';
import { DELIVERY_QUEUE, QueueService } from '../queue/queue.service';
import { TELEGRAM_SENDER, type TelegramSender } from '../telegram/telegram-sender';
import {
  finalizeSuppressed,
  suppressionCodeFor,
  wakeDelivery,
  wakeNextInChat,
} from './delivery-records';
import { applyRecordedBlock, pendingRecordedBlocks } from './destination';

/** Events published per dispatcher transaction. */
const DISPATCH_BATCH = 20;
const DISPATCH_TRANSACTION_TIMEOUT_MS = 15_000;
/** How often the recovery sweep runs in the background. */
export const DELIVERY_SWEEP_INTERVAL_MS = 30_000;
/**
 * A sendable delivery whose last event was dispatched this long ago and that
 * has no pending event lost its job; the sweep wakes it again. Longer than a
 * delivery job's expiry.
 */
export const DELIVERY_LOST_JOB_SECONDS = 600;
const SHUTDOWN_WAIT_MS = 10_000;

/**
 * Delivery outbox → the `delivery-send` pg-boss queue (docs/DELIVERY.md), the
 * same pattern as research (docs/QUEUE.md).
 *
 * Publication: due delivery events are locked (FOR UPDATE SKIP LOCKED),
 * published through pg-boss's Prisma adapter in the same transaction, and
 * marked dispatched. The event ID is the job ID. An event of a delivery that
 * can no longer be sent automatically (sent, UNKNOWN, failed, suppressed) is
 * cancelled instead.
 *
 * Recovery sweep:
 * - a SENDING delivery whose lease expired (dead or frozen worker): a part that
 *   was handed to Telegram becomes UNKNOWN and the delivery UNKNOWN, never
 *   resent; with no part in flight it becomes PENDING again (or SUPPRESSED if a
 *   decision was recorded meanwhile) and is woken;
 * - a sendable delivery without a pending event and without a recent dispatch
 *   is woken (lost job, rows written outside createDelivery).
 */
@Injectable()
export class DeliveryDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DeliveryDispatcher.name);
  private loop: WorkerLoop | undefined;
  private lastSweep = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: Env,
    private readonly queue: QueueService,
    private readonly lifecycle: AppLifecycle,
    private readonly gate: ExecutionGate,
    @Optional() @Inject(TELEGRAM_SENDER) private readonly sender: TelegramSender | null,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.BACKGROUND_WORKERS !== 'on' || !this.sender) return;
    const interval = this.config.WORKER_POLL_INTERVAL_MS;
    this.lifecycle.register('delivery-dispatcher', { staleAfterMs: loopStaleAfterMs(interval) });
    this.gate.whenOpen(() =>
      this.queue.onUp(() => {
        this.loop = new WorkerLoop(
          'Delivery dispatcher',
          interval,
          () => this.tick(),
          this.logger,
          {
            lifecycle: this.lifecycle,
            component: 'delivery-dispatcher',
          },
        );
        this.loop.start();
        return Promise.resolve();
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.loop?.stop(SHUTDOWN_WAIT_MS);
  }

  async tick(): Promise<boolean> {
    if (Date.now() - this.lastSweep >= DELIVERY_SWEEP_INTERVAL_MS) {
      this.lastSweep = Date.now();
      await this.sweep();
    }
    return (await this.dispatchDue()) > 0;
  }

  /** Publishes up to one batch of due delivery events. Returns the number handled. */
  async dispatchDue(): Promise<number> {
    if (!this.queue.has(DELIVERY_QUEUE)) return 0;
    return this.prisma.$transaction(
      async (tx) => {
        const events = await tx.$queryRaw<{ id: string; deliveryId: string; state: string }[]>`
          SELECT e.id, e.delivery_id AS "deliveryId", d.state::text AS state
            FROM delivery_event e JOIN delivery d ON d.id = e.delivery_id
           WHERE e.dispatched_at IS NULL AND e.cancelled_at IS NULL AND e.available_at <= now()
           ORDER BY e.available_at, e.created_at, e.id
           LIMIT ${DISPATCH_BATCH}
             FOR UPDATE OF e SKIP LOCKED`;
        for (const event of events) {
          if (event.state !== 'PENDING' && event.state !== 'RETRYABLE_FAILURE') {
            // SENDING is covered by its worker or lease recovery; the rest is final.
            await tx.$executeRaw`UPDATE delivery_event SET cancelled_at = now() WHERE id = ${event.id}::uuid`;
            continue;
          }
          await this.queue.publishDelivery(tx, { deliveryId: event.deliveryId, eventId: event.id });
          await tx.$executeRaw`UPDATE delivery_event SET dispatched_at = now() WHERE id = ${event.id}::uuid`;
        }
        return events.length;
      },
      { timeout: DISPATCH_TRANSACTION_TIMEOUT_MS },
    );
  }

  /** Recovery sweep; see the class comment. Safe to run concurrently and repeatedly. */
  async sweep(): Promise<void> {
    await this.recoverExpired();
    await this.finalizeStranded();
    await this.applyRecordedBlocks();
    const woken = await this.prisma.$executeRaw`
      INSERT INTO delivery_event (id, delivery_id, reason, available_at)
      SELECT gen_random_uuid(), d.id, 'JOB_LOST', now()
        FROM delivery d
       WHERE (d.state = 'PENDING' OR (d.state = 'RETRYABLE_FAILURE' AND d.next_attempt_at <= now()))
         AND d.suppressed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM delivery_event p
                          WHERE p.delivery_id = d.id AND p.dispatched_at IS NULL AND p.cancelled_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM delivery_event r
                          WHERE r.delivery_id = d.id
                            AND r.dispatched_at > now() - ${DELIVERY_LOST_JOB_SECONDS} * interval '1 second')
      ON CONFLICT (delivery_id) WHERE dispatched_at IS NULL AND cancelled_at IS NULL DO NOTHING`;
    if (woken > 0) this.logger.warn({ message: 'Delivery sweep woke deliveries', count: woken });
  }

  /** Waiting deliveries with a suppression decision are made final (they would block their chat). */
  private async finalizeStranded(): Promise<void> {
    const stranded = await this.prisma.delivery.findMany({
      where: { state: { in: ['PENDING', 'RETRYABLE_FAILURE'] }, suppressedAt: { not: null } },
      select: { id: true },
      take: 50,
    });
    let count = 0;
    for (const { id } of stranded) if (await finalizeSuppressed(this.prisma, id)) count += 1;
    if (count > 0) this.logger.warn({ message: 'Finalized suppressed waiting deliveries', count });
  }

  /** Confirmed destination refusals whose effects were not applied (failure after recording). */
  private async applyRecordedBlocks(): Promise<void> {
    for (const id of await pendingRecordedBlocks(this.prisma)) {
      try {
        const result = await applyRecordedBlock(this.prisma, id);
        this.logger.warn({
          message: 'Applied recorded destination refusal',
          deliveryId: id,
          ...result,
        });
      } catch (error) {
        this.logger.error({
          message: 'Recorded destination refusal not applied',
          deliveryId: id,
          ...errorInfo(error),
        });
      }
    }
  }

  /** A worker died or froze while SENDING: an in-flight part has an unknown outcome. */
  private async recoverExpired(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const expired = await tx.$queryRaw<
        { id: string; suppressedAt: Date | null; chatId: bigint }[]
      >`
        SELECT id, suppressed_at AS "suppressedAt", chat_id AS "chatId" FROM delivery
         WHERE state = 'SENDING' AND lease_until < now() FOR UPDATE SKIP LOCKED`;
      for (const { id, suppressedAt, chatId } of expired) {
        const unknown = await tx.deliveryPart.updateMany({
          where: { deliveryId: id, state: 'SENDING' },
          data: { state: 'UNKNOWN', errorCode: 'INTERRUPTED_WHILE_SENDING' },
        });
        // An ambiguous part stays UNKNOWN (never retried); otherwise a suppression
        // decision taken while it was being sent makes it final.
        const state = unknown.count > 0 ? 'UNKNOWN' : suppressedAt ? 'SUPPRESSED' : 'PENDING';
        await tx.delivery.update({
          where: { id },
          data: {
            state,
            lastErrorCode:
              unknown.count > 0
                ? 'INTERRUPTED_WHILE_SENDING'
                : suppressedAt
                  ? await suppressionCodeFor(tx, id)
                  : null,
            leaseOwner: null,
            leaseUntil: null,
            fencingToken: { increment: 1 },
          },
        });
        if (state === 'PENDING') await wakeDelivery(tx, id, 'LEASE_EXPIRED');
        else await wakeNextInChat(tx, chatId);
        this.logger.warn({
          message: 'Recovered expired delivery',
          deliveryId: id,
          unknownParts: unknown.count,
          state,
        });
      }
    });
  }
}
