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
import { errorInfo } from '../common/error-info';
import { AppLifecycle } from '../common/lifecycle';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import { PrismaService } from '../database/prisma.service';
import type { DeliveryPart } from '../generated/prisma/client';
import { runDeliveryDenial } from '../identity/authorization';
import {
  INVITATION_TOKEN_PLACEHOLDER,
  deriveInvitationToken,
  hashInvitationToken,
} from '../identity/invitation-token';
import { ExecutionGate } from '../operations/execution-gate';
import { DELIVERY_QUEUE, QueueService, type DeliveryJob } from '../queue/queue.service';
import {
  TELEGRAM_SENDER,
  TelegramSendError,
  type InlineKeyboard,
  type TelegramSender,
} from '../telegram/telegram-sender';
import { DeliveryDispatcher } from './delivery-dispatcher';
import {
  cancelDeliveryEvents,
  chatBlocked,
  finalizeSuppressed,
  suppressionCodeFor,
  wakeDelivery,
  wakeNextInChat,
} from './delivery-records';
import { applyRecordedBlock } from './destination';

export const DELIVERY_LEASE_SECONDS = 60;
/** Claims of one delivery (each send pass); retryable refusals stop after this many. */
export const MAX_DELIVERY_ATTEMPTS = 5;
/** Upper bound of one wake-up delay; a later retry time is reached by re-inspection. */
export const MAX_WAKE_DELAY_SECONDS = 3_600;
/** Application backoff without a valid Retry-After: 5 s doubling, at most this. */
export const MAX_BACKOFF_SECONDS = 300;
/**
 * Largest Retry-After honoured (30 days). Telegram's value is honoured in full up
 * to this; a larger one ends the delivery PERMANENT_FAILURE rather than send early.
 */
export const MAX_RETRY_AFTER_SECONDS = 30 * 24 * 3_600;

/** A usable Retry-After: a positive whole number of seconds within the bound. */
export function validRetryAfter(value: number | undefined): value is number {
  return (
    value !== undefined && Number.isInteger(value) && value >= 1 && value <= MAX_RETRY_AFTER_SECONDS
  );
}
/** Re-inspection delay of a delivery waiting behind an earlier one to the same chat. */
const ORDER_WAIT_SECONDS = 5;
/** Shutdown waits for a Telegram call in flight (the HTTP timeout is 15 s). */
const SHUTDOWN_WAIT_MS = 20_000;

interface Claim {
  id: string;
  fencingToken: number;
  attempts: number;
  chatId: bigint;
  kind: string;
  invitationId: string | null;
  runId: string | null;
}

type HandleOutcome = 'sent' | 'stopped' | 'idle';

class StaleDeliveryLease extends Error {}

/**
 * Sends stored delivery parts in order (TRB-080, docs/DELIVERY.md). Never calls
 * the research provider, never changes a run, quota or reservation.
 *
 * A pg-boss job only names the delivery. The handler claims it in the database
 * (PENDING, or RETRYABLE_FAILURE whose retry time has come) with a lease and a
 * fencing token; any other state, including SENDING under another worker, makes
 * the job a no-op. So duplicate jobs, redelivery and several workers never
 * send a part twice. Deliveries to one chat go out in creation order (seq): a
 * delivery waits while an earlier one to the same chat is unfinished, and each
 * finished delivery wakes the next.
 *
 * Per part:
 * - rechecks, right before the send: the owner's account access for run-related
 *   deliveries (suspended/revoked/unresolved → SUPPRESSED), a confirmed chat
 *   block (→ SUPPRESSED CHAT_BLOCKED), and the durable decision
 *   (delivery.suppressed_at) in the transaction that marks the part SENDING;
 * - SENDING (send intent, send_started_at) is committed before the Telegram call
 *   and SENT with the message ID right after it, so a confirmed part is never
 *   resent, and a part interrupted after its intent becomes UNKNOWN;
 * - outcomes (classifyTelegramError): unknown → part and delivery UNKNOWN,
 *   never retried, multipart continuation stops; confirmed refusal that may
 *   succeed later (429, 5xx answer, connection never opened) → RETRYABLE_FAILURE
 *   with a durable retry time (Retry-After, else backoff) and a delayed delivery
 *   event, bounded by MAX_DELIVERY_ATTEMPTS; permanent refusal → part FAILED,
 *   delivery PERMANENT_FAILURE; a confirmed blocked/deactivated chat also
 *   records the refusal on the delivery and applies the destination block
 *   (applyRecordedBlock; the recovery sweep completes it after a failure).
 * - INVITATION deliveries store a placeholder; the token is derived just before sending.
 *
 * Fencing protects the database writes; it cannot undo a send. A part whose
 * lease expired while its request was in flight becomes UNKNOWN (lease
 * recovery), and the late answer of the original request is only logged.
 */
@Injectable()
export class DeliveryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly logger = new Logger(DeliveryWorker.name);
  private readonly shutdown = new AbortController();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: Env,
    private readonly queue: QueueService,
    private readonly dispatcher: DeliveryDispatcher,
    private readonly lifecycle: AppLifecycle,
    private readonly gate: ExecutionGate,
    @Optional() @Inject(TELEGRAM_SENDER) private readonly sender: TelegramSender | null,
  ) {
    lifecycle.shutdownSignal.addEventListener('abort', () => this.shutdown.abort(), { once: true });
  }

  onApplicationBootstrap(): void {
    if (this.config.BACKGROUND_WORKERS !== 'on' || !this.sender) return;
    this.lifecycle.register('delivery-worker');
    this.gate.whenOpen(() =>
      this.queue.onUp(async () => {
        try {
          await this.queue.workDelivery((job) => this.process(job));
          this.lifecycle.mark('delivery-worker', 'up');
        } catch (error) {
          this.lifecycle.mark('delivery-worker', 'failed');
          throw error;
        }
      }),
    );
  }

  /**
   * Shutdown: stop fetching jobs and signal the active handler, which stops
   * before its next part and hands the delivery over (lease released, wake-up
   * written). A Telegram call in flight is awaited, bounded; if the process
   * ends first, the part stays SENDING and recovery marks it UNKNOWN.
   */
  async onModuleDestroy(): Promise<void> {
    this.shutdown.abort();
    const outcome = await this.queue.stopWork(SHUTDOWN_WAIT_MS, DELIVERY_QUEUE);
    if (outcome === 'timeout') {
      this.logger.warn({ message: 'Delivery worker did not stop before the shutdown timeout' });
    }
  }

  /** pg-boss handler. Throws only on infrastructure errors; pg-boss then retries the inspection. */
  async process(job: DeliveryJob): Promise<void> {
    await this.handle(job.data.deliveryId, AbortSignal.any([this.shutdown.signal, job.signal]));
  }

  /**
   * Manual driver (tests, diagnostics): recovery sweep, one publication batch,
   * then ready jobs until one sends something or none is left. True when a
   * delivery was handled.
   */
  async tick(signal?: AbortSignal): Promise<boolean> {
    if (!this.sender || !this.queue.has(DELIVERY_QUEUE)) return false;
    await this.dispatcher.sweep();
    await this.dispatcher.dispatchDue();
    for (;;) {
      const job = await this.queue.fetchDelivery();
      if (!job) return false;
      let outcome: HandleOutcome;
      try {
        outcome = await this.handle(job.data.deliveryId, signal);
      } catch (error) {
        await this.queue.fail(job, error, DELIVERY_QUEUE);
        throw error;
      }
      await this.queue.complete(job, DELIVERY_QUEUE);
      if (outcome !== 'idle') return true;
    }
  }

  /** Inspects one delivery and sends what is due; see the class comment. */
  async handle(deliveryId: string, signal?: AbortSignal): Promise<HandleOutcome> {
    const sender = this.sender;
    if (!sender) return 'idle';
    const claim = await this.claim(deliveryId);
    if (!claim) {
      // A waiting delivery stranded with a suppression decision is made final.
      if (!(await finalizeSuppressed(this.prisma, deliveryId))) {
        await this.rewakeIfWaiting(deliveryId);
      }
      return 'idle';
    }
    try {
      return await this.send(claim, sender, signal);
    } catch (error) {
      if (error instanceof StaleDeliveryLease) return 'stopped';
      this.logger.error({ message: 'Delivery error', deliveryId, ...errorInfo(error) });
      throw error;
    }
  }

  private async claim(deliveryId: string): Promise<Claim | null> {
    const rows = await this.prisma.$queryRaw<Claim[]>`
      UPDATE delivery
         SET state = 'SENDING', lease_owner = ${this.workerId},
             lease_until = now() + ${DELIVERY_LEASE_SECONDS} * interval '1 second',
             fencing_token = fencing_token + 1, attempts = attempts + 1, updated_at = now()
       WHERE id = ${deliveryId}::uuid AND suppressed_at IS NULL
         AND (state = 'PENDING' OR (state = 'RETRYABLE_FAILURE' AND next_attempt_at <= now()))
         -- Per-chat order: an earlier unfinished delivery to the same chat goes first;
         -- when it finishes it wakes this one (wakeNextInChat).
         AND NOT EXISTS (SELECT 1 FROM delivery o
                          WHERE o.chat_id = delivery.chat_id AND o.seq < delivery.seq
                            AND o.state IN ('PENDING', 'SENDING', 'RETRYABLE_FAILURE'))
      RETURNING id, fencing_token AS "fencingToken", attempts, chat_id AS "chatId",
                kind::text AS kind, invitation_id AS "invitationId", run_id AS "runId"`;
    return rows[0] ?? null;
  }

  /**
   * A job that found its delivery not claimable re-schedules it when it is still
   * waiting: before its retry time (merged wake-ups), or behind an earlier
   * unfinished delivery to the same chat (per-chat order). The new wake-up is
   * at the time the delivery could proceed (at least 5 s), never a busy loop;
   * the earlier delivery also wakes it when it finishes.
   */
  private async rewakeIfWaiting(deliveryId: string): Promise<void> {
    const rows = await this.prisma.$queryRaw<{ seconds: number }[]>`
      SELECT GREATEST(
               CEIL(EXTRACT(EPOCH FROM d.next_attempt_at - now())),
               CASE WHEN EXISTS (SELECT 1 FROM delivery o
                                  WHERE o.chat_id = d.chat_id AND o.seq < d.seq
                                    AND o.state IN ('PENDING', 'SENDING', 'RETRYABLE_FAILURE'))
                    THEN GREATEST(${ORDER_WAIT_SECONDS},
                                  COALESCE((SELECT CEIL(EXTRACT(EPOCH FROM MAX(o.next_attempt_at) - now()))
                                              FROM delivery o
                                             WHERE o.chat_id = d.chat_id AND o.seq < d.seq
                                               AND o.state = 'RETRYABLE_FAILURE'), 0))
                    ELSE 0 END)::int AS seconds
        FROM delivery d
       WHERE d.id = ${deliveryId}::uuid AND d.suppressed_at IS NULL
         AND d.state IN ('PENDING', 'RETRYABLE_FAILURE')`;
    const seconds = rows[0]?.seconds ?? 0;
    if (seconds > 0) {
      await wakeDelivery(
        this.prisma,
        deliveryId,
        'WAITING',
        Math.min(seconds, MAX_WAKE_DELAY_SECONDS),
      );
    }
  }

  private async send(
    claim: Claim,
    sender: TelegramSender,
    signal: AbortSignal | undefined,
  ): Promise<HandleOutcome> {
    const parts = await this.prisma.deliveryPart.findMany({
      where: { deliveryId: claim.id },
      orderBy: { ordinal: 'asc' },
    });
    let sent = 0;
    for (const part of parts) {
      if (part.state === 'SENT') continue;
      if (part.state !== 'PENDING') {
        await this.finish(
          claim,
          part.state === 'UNKNOWN' ? 'UNKNOWN' : 'PERMANENT_FAILURE',
          'PART_NOT_SENDABLE',
        );
        return 'stopped';
      }
      if (signal?.aborted) {
        await this.handOver(claim);
        return 'stopped';
      }
      if (part.contentPurgedAt) {
        // Retention removed the payload (TRB-090): never send an empty or partial message.
        await this.finish(claim, 'SUPPRESSED', 'CONTENT_EXPIRED', true);
        return 'stopped';
      }
      const denial = await this.denial(claim);
      if (denial) {
        this.logger.log({ message: 'Delivery suppressed', deliveryId: claim.id, code: denial });
        await this.finish(claim, 'SUPPRESSED', denial, true);
        return 'stopped';
      }
      const html = await this.payload(claim, part.html);
      if (html === null) {
        await this.finish(claim, 'PERMANENT_FAILURE', 'INVITATION_TOKEN_UNAVAILABLE');
        return 'stopped';
      }
      if (!(await this.beginPart(claim, part.ordinal))) {
        const code = await suppressionCodeFor(this.prisma, claim.id);
        this.logger.log({ message: 'Delivery suppressed', deliveryId: claim.id, code });
        await this.finish(claim, 'SUPPRESSED', code);
        return 'stopped';
      }

      let messageId: number;
      try {
        ({ messageId } = await this.sendPart(sender, claim.chatId, part, html));
      } catch (error) {
        const failure =
          error instanceof TelegramSendError
            ? error
            : new TelegramSendError('TELEGRAM_UNEXPECTED', 'unknown', false);
        await this.handleFailure(claim, part.ordinal, failure);
        return 'stopped';
      }
      try {
        await this.fencedPart(claim, part.ordinal, {
          state: 'SENT',
          telegramMessageId: BigInt(messageId),
          sentAt: new Date(),
        });
      } catch (error) {
        if (error instanceof StaleDeliveryLease) {
          // Recovery already marked this part UNKNOWN; the late confirmation is evidence only.
          this.logger.warn({
            message: 'Late Telegram confirmation after lease loss',
            deliveryId: claim.id,
            ordinal: part.ordinal,
            telegramMessageId: messageId,
          });
        }
        throw error;
      }
      sent += 1;
    }
    await this.finish(claim, 'SENT', null);
    this.logger.log({ message: 'Delivery sent', deliveryId: claim.id, parts: parts.length, sent });
    return 'sent';
  }

  private sendPart(
    sender: TelegramSender,
    chatId: bigint,
    part: DeliveryPart,
    html: string,
  ): Promise<{ messageId: number }> {
    if (part.kind === 'DOCUMENT') {
      return sender.sendDocument(
        chatId,
        {
          fileName: part.fileName ?? 'report.txt',
          content: Buffer.from(part.fileContent ?? '', 'utf8'),
        },
        html,
      );
    }
    return sender.sendHtml(chatId, html, (part.replyMarkup as InlineKeyboard | null) ?? undefined);
  }

  private async handleFailure(
    claim: Claim,
    ordinal: number,
    failure: TelegramSendError,
  ): Promise<void> {
    this.logger.warn({
      message: 'Delivery part failed',
      deliveryId: claim.id,
      ordinal,
      code: failure.code,
      certainty: failure.certainty,
      ...(failure.destinationUnavailable ? { destination: failure.destinationUnavailable } : {}),
    });
    if (failure.certainty === 'unknown') {
      // Ambiguous: never resent automatically; later parts are not sent either.
      await this.fencedPart(claim, ordinal, { state: 'UNKNOWN', errorCode: failure.code });
      return this.finish(claim, 'UNKNOWN', failure.code);
    }
    if (failure.destinationUnavailable) {
      return this.recordDestinationRefusal(claim, ordinal, failure, failure.destinationUnavailable);
    }
    if (failure.permanent || claim.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await this.fencedPart(claim, ordinal, {
        state: failure.permanent ? 'FAILED' : 'PENDING',
        errorCode: failure.code,
      });
      return this.finish(claim, 'PERMANENT_FAILURE', failure.code);
    }
    const retryAfter = failure.retryAfterSeconds;
    if (
      retryAfter !== undefined &&
      Number.isInteger(retryAfter) &&
      retryAfter > MAX_RETRY_AFTER_SECONDS
    ) {
      // Never send earlier than Telegram allows, and never wait without bound.
      await this.fencedPart(claim, ordinal, { state: 'PENDING', errorCode: failure.code });
      return this.finish(claim, 'PERMANENT_FAILURE', 'TELEGRAM_RETRY_AFTER_TOO_LONG');
    }
    const delaySeconds = validRetryAfter(retryAfter)
      ? retryAfter
      : Math.min(MAX_BACKOFF_SECONDS, 5 * 2 ** (claim.attempts - 1));
    await this.release(claim, 'RETRYABLE_FAILURE', failure.code, delaySeconds, async (tx) => {
      await tx.deliveryPart.update({
        where: { deliveryId_ordinal: { deliveryId: claim.id, ordinal } },
        data: { state: 'PENDING', errorCode: failure.code },
      });
    });
  }

  /**
   * A confirmed blocked/deactivated chat. The refusal is committed first, with
   * the delivery's terminal state (fenced; only the delivery row is written, so
   * no lock is taken out of order). Its effects are then applied in their own
   * transaction in the inbox lock order (applyRecordedBlock); if that fails, the
   * recorded refusal stays pending and the recovery sweep applies it. Nothing is
   * sent again in either case.
   */
  private async recordDestinationRefusal(
    claim: Claim,
    ordinal: number,
    failure: TelegramSendError,
    reason: 'BOT_BLOCKED' | 'USER_DEACTIVATED',
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const updated = await tx.$executeRaw`
          UPDATE delivery
             SET state = 'PERMANENT_FAILURE', last_error_code = ${failure.code},
                 destination_block_reason = ${reason}, destination_refused_at = now(),
                 lease_owner = NULL, lease_until = NULL, updated_at = now()
           WHERE id = ${claim.id}::uuid AND fencing_token = ${claim.fencingToken} AND state = 'SENDING'`;
        if (updated !== 1) throw new StaleDeliveryLease();
        await tx.deliveryPart.update({
          where: { deliveryId_ordinal: { deliveryId: claim.id, ordinal } },
          data: { state: 'FAILED', errorCode: failure.code },
        });
      });
    } catch (error) {
      if (!(error instanceof StaleDeliveryLease)) throw error;
      // The lease was lost (lease recovery makes the part UNKNOWN), but the answer is
      // still a confirmed fact about the chat: record it on the delivery as evidence.
      await this.prisma.$executeRaw`
        UPDATE delivery SET destination_block_reason = ${reason}, destination_refused_at = now()
         WHERE id = ${claim.id}::uuid AND destination_block_reason IS NULL`;
      await applyRecordedBlock(this.prisma, claim.id);
      throw error;
    }
    await wakeNextInChat(this.prisma, claim.chatId);
    const blocked = await applyRecordedBlock(this.prisma, claim.id);
    this.logger.warn({
      message: 'Telegram destination unavailable; automatic research paused',
      deliveryId: claim.id,
      reason,
      ...blocked,
    });
  }

  /** Shutdown between parts: release the lease and wake the delivery, in one transaction. */
  private async handOver(claim: Claim): Promise<void> {
    await this.release(claim, 'PENDING', null, 0);
    this.logger.log({ message: 'Delivery handed over on shutdown', deliveryId: claim.id });
  }

  /**
   * Leaves SENDING for a waiting state (after a confirmed retryable refusal, or a
   * shutdown hand-over), in one transaction. The same statement that takes the
   * delivery row lock reads the durable suppression decision: a decision
   * recorded while this worker was sending (suspension, deletion, chat block)
   * makes the delivery final, SUPPRESSED, instead of waiting. No send outcome is
   * ambiguous here (the last answer was a confirmed refusal, or no part is in
   * flight); confirmed parts keep their message IDs. A suppressed delivery's
   * pending wake-ups are cancelled and the next delivery to the chat is woken; a
   * waiting one gets its own wake-up at its retry time.
   */
  private async release(
    claim: Claim,
    waiting: 'RETRYABLE_FAILURE' | 'PENDING',
    code: string | null,
    delaySeconds: number,
    alsoInTx?: (tx: Tx) => Promise<void>,
  ): Promise<void> {
    const suppressed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ suppressed: boolean }[]>`
        UPDATE delivery
           SET state = (CASE WHEN suppressed_at IS NULL THEN ${waiting} ELSE 'SUPPRESSED' END)::"DeliveryState",
               last_error_code = CASE WHEN suppressed_at IS NULL THEN ${code} ELSE last_error_code END,
               next_attempt_at = CASE WHEN suppressed_at IS NULL
                                      THEN now() + ${delaySeconds} * interval '1 second'
                                      ELSE next_attempt_at END,
               lease_owner = NULL, lease_until = NULL, fencing_token = fencing_token + 1,
               updated_at = now()
         WHERE id = ${claim.id}::uuid AND fencing_token = ${claim.fencingToken} AND state = 'SENDING'
        RETURNING suppressed_at IS NOT NULL AS suppressed`;
      const row = rows[0];
      if (!row) throw new StaleDeliveryLease();
      await alsoInTx?.(tx);
      if (row.suppressed) {
        await tx.delivery.update({
          where: { id: claim.id },
          data: { lastErrorCode: await suppressionCodeFor(tx, claim.id) },
        });
        await cancelDeliveryEvents(tx, claim.id);
        await wakeNextInChat(tx, claim.chatId);
      } else {
        // Durable retry time: the job is published only when it is due (no busy loop).
        await wakeDelivery(
          tx,
          claim.id,
          waiting === 'PENDING' ? 'SHUTDOWN_HANDOVER' : 'RETRY_AFTER_REFUSAL',
          delaySeconds,
        );
      }
      return row.suppressed;
    });
    if (suppressed) this.logger.log({ message: 'Delivery suppressed', deliveryId: claim.id });
  }

  private async finish(
    claim: Claim,
    state: 'SENT' | 'UNKNOWN' | 'PERMANENT_FAILURE' | 'SUPPRESSED',
    code: string | null,
    /** Records a new suppression decision (an existing one is kept). */
    newDecision = false,
  ): Promise<void> {
    const result = await this.prisma.delivery.updateMany({
      where: { id: claim.id, fencingToken: claim.fencingToken, state: 'SENDING' },
      data: {
        state,
        lastErrorCode: code,
        leaseOwner: null,
        leaseUntil: null,
        ...(newDecision ? { suppressedAt: new Date() } : {}),
      },
    });
    if (result.count !== 1) throw new StaleDeliveryLease();
    await wakeNextInChat(this.prisma, claim.chatId);
  }

  /**
   * Suppression code when the delivery may not be sent now, else null:
   * - run-related deliveries: the owner's current account access (centralized
   *   rules, current configuration);
   * - every delivery: a confirmed unavailable chat (TRB-080).
   * Replies that are not about a run are not checked for account access.
   */
  private async denial(claim: Claim): Promise<string | null> {
    if (claim.runId) {
      const run = await this.prisma.researchRun.findUnique({
        where: { id: claim.runId },
        select: { user: true },
      });
      const denial = runDeliveryDenial(run?.user ?? null, this.config);
      if (denial) return denial;
    }
    return (await chatBlocked(this.prisma, claim.chatId)) ? 'CHAT_BLOCKED' : null;
  }

  /**
   * Marks the next part SENDING (send intent) unless a suppression decision
   * exists. The lease row is locked by the same statement that reads the
   * decision, so a concurrent suspension, deletion or block either commits
   * first (nothing more is sent) or waits until this part is SENDING (the
   * documented one-part race).
   */
  private async beginPart(claim: Claim, ordinal: number): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ suppressedAt: Date | null }[]>`
        UPDATE delivery SET lease_until = now() + ${DELIVERY_LEASE_SECONDS} * interval '1 second'
         WHERE id = ${claim.id}::uuid AND fencing_token = ${claim.fencingToken} AND state = 'SENDING'
        RETURNING suppressed_at AS "suppressedAt"`;
      const lease = rows[0];
      if (!lease) throw new StaleDeliveryLease();
      if (lease.suppressedAt) return false;
      await tx.deliveryPart.update({
        where: { deliveryId_ordinal: { deliveryId: claim.id, ordinal } },
        data: { state: 'SENDING', sendStartedAt: new Date() },
      });
      return true;
    });
  }

  /**
   * Text to send. For INVITATION deliveries the token is derived now and checked
   * against the stored hash (a rotated secret would produce an invalid link);
   * null when it cannot be produced. The token is never written anywhere.
   */
  private async payload(claim: Claim, html: string): Promise<string | null> {
    if (claim.kind !== 'INVITATION') return html;
    const secret = this.config.INVITATION_TOKEN_SECRET;
    if (!secret || !claim.invitationId) return null;
    const invitation = await this.prisma.invitation.findUnique({
      where: { id: claim.invitationId },
      select: { tokenHash: true, revokedAt: true },
    });
    const token = deriveInvitationToken(secret, claim.invitationId);
    if (
      !invitation ||
      invitation.revokedAt ||
      hashInvitationToken(token) !== invitation.tokenHash
    ) {
      return null;
    }
    return html.split(INVITATION_TOKEN_PLACEHOLDER).join(token);
  }

  /** Updates one part only while this worker still holds the delivery lease. */
  private async fencedPart(
    claim: Claim,
    ordinal: number,
    data: {
      state: 'SENT' | 'UNKNOWN' | 'FAILED' | 'PENDING';
      telegramMessageId?: bigint;
      sentAt?: Date;
      errorCode?: string;
    },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const lease = await tx.$executeRaw`
        UPDATE delivery SET lease_until = now() + ${DELIVERY_LEASE_SECONDS} * interval '1 second'
         WHERE id = ${claim.id}::uuid AND fencing_token = ${claim.fencingToken} AND state = 'SENDING'`;
      if (lease !== 1) throw new StaleDeliveryLease();
      await tx.deliveryPart.update({
        where: { deliveryId_ordinal: { deliveryId: claim.id, ordinal } },
        data,
      });
    });
  }
}
