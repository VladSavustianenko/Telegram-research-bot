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
import { WorkerLoop } from '../common/worker-loop';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { PrismaService } from '../database/prisma.service';
import {
  INVITATION_TOKEN_PLACEHOLDER,
  deriveInvitationToken,
  hashInvitationToken,
} from '../identity/invitation-token';
import {
  TELEGRAM_SENDER,
  TelegramSendError,
  type InlineKeyboard,
  type TelegramSender,
} from '../telegram/telegram-sender';

export const DELIVERY_LEASE_SECONDS = 60;
export const MAX_DELIVERY_ATTEMPTS = 5;
const SHUTDOWN_WAIT_MS = 10_000;

interface Claim {
  id: string;
  fencingToken: number;
  attempts: number;
  chatId: bigint;
  kind: string;
  invitationId: string | null;
}

class StaleDeliveryLease extends Error {}

/**
 * Sends stored delivery parts in order. Never calls the research provider.
 * - A part is marked SENDING before the request and SENT with its Telegram
 *   message ID right after, so confirmed parts are never resent.
 * - Telegram error responses are definite (retry with backoff or give up).
 * - Network failures/timeouts, and crashes while SENDING, make the part
 *   UNKNOWN: no automatic resend; the user can request an explicit /result.
 * - Before each part, a delivery about a run whose owner is suspended, or not
 *   resolved (an unlinked TRB-020 run), becomes SUPPRESSED. A suspension
 *   committed after that check can let one part through.
 * - INVITATION deliveries store a placeholder; the token is derived just before sending.
 */
@Injectable()
export class DeliveryWorker implements OnApplicationBootstrap, OnModuleDestroy {
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly logger = new Logger(DeliveryWorker.name);
  private loop: WorkerLoop | undefined;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: Env,
    @Optional() @Inject(TELEGRAM_SENDER) private readonly sender: TelegramSender | null,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.BACKGROUND_WORKERS !== 'on' || !this.sender) return;
    this.loop = new WorkerLoop(
      'Delivery worker',
      this.config.WORKER_POLL_INTERVAL_MS,
      () => this.tick(),
      this.logger,
    );
    this.loop.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.loop?.stop(SHUTDOWN_WAIT_MS);
  }

  /** Recovers expired leases, then sends at most one delivery. True when one was handled. */
  async tick(): Promise<boolean> {
    if (!this.sender) return false;
    await this.recoverExpired();
    const claim = await this.claim();
    if (!claim) return false;
    try {
      await this.send(claim, this.sender);
    } catch (error) {
      if (!(error instanceof StaleDeliveryLease)) {
        this.logger.error({ message: 'Delivery error', deliveryId: claim.id, ...errorInfo(error) });
      }
    }
    return true;
  }

  private async claim(): Promise<Claim | null> {
    const rows = await this.prisma.$queryRaw<Claim[]>`
      UPDATE delivery
         SET state = 'SENDING', lease_owner = ${this.workerId},
             lease_until = now() + ${DELIVERY_LEASE_SECONDS} * interval '1 second',
             fencing_token = fencing_token + 1, attempts = attempts + 1, updated_at = now()
       WHERE id = (SELECT id FROM delivery
                    WHERE state = 'PENDING'
                       OR (state = 'RETRYABLE_FAILURE' AND next_attempt_at <= now())
                    ORDER BY created_at, id
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED)
      RETURNING id, fencing_token AS "fencingToken", attempts, chat_id AS "chatId",
                kind::text AS kind, invitation_id AS "invitationId"`;
    return rows[0] ?? null;
  }

  /** A worker died while SENDING: any in-flight part has an unknown outcome. */
  private async recoverExpired(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const expired = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM delivery WHERE state = 'SENDING' AND lease_until < now() FOR UPDATE SKIP LOCKED`;
      for (const { id } of expired) {
        const unknown = await tx.deliveryPart.updateMany({
          where: { deliveryId: id, state: 'SENDING' },
          data: { state: 'UNKNOWN' },
        });
        await tx.delivery.update({
          where: { id },
          data: {
            state: unknown.count > 0 ? 'UNKNOWN' : 'PENDING',
            lastErrorCode: unknown.count > 0 ? 'INTERRUPTED_WHILE_SENDING' : null,
            leaseOwner: null,
            leaseUntil: null,
            fencingToken: { increment: 1 },
          },
        });
        this.logger.warn({
          message: 'Recovered expired delivery',
          deliveryId: id,
          unknownParts: unknown.count,
        });
      }
    });
  }

  private async send(claim: Claim, sender: TelegramSender): Promise<void> {
    const parts = await this.prisma.deliveryPart.findMany({
      where: { deliveryId: claim.id },
      orderBy: { ordinal: 'asc' },
    });
    for (const part of parts) {
      if (part.state === 'SENT') continue;
      if (part.state !== 'PENDING') {
        return this.finish(
          claim,
          part.state === 'UNKNOWN' ? 'UNKNOWN' : 'PERMANENT_FAILURE',
          'PART_NOT_SENDABLE',
        );
      }
      const ineligible = await this.ineligibleOwner(claim);
      if (ineligible) {
        this.logger.log({ message: 'Delivery suppressed', deliveryId: claim.id, code: ineligible });
        return this.finish(claim, 'SUPPRESSED', ineligible);
      }
      const html = await this.payload(claim, part.html);
      if (html === null)
        return this.finish(claim, 'PERMANENT_FAILURE', 'INVITATION_TOKEN_UNAVAILABLE');
      await this.fencedPart(claim, part.ordinal, { state: 'SENDING' });

      let messageId: number;
      try {
        ({ messageId } = await sender.sendHtml(
          claim.chatId,
          html,
          (part.replyMarkup as InlineKeyboard | null) ?? undefined,
        ));
      } catch (error) {
        const failure =
          error instanceof TelegramSendError
            ? error
            : new TelegramSendError('TELEGRAM_UNEXPECTED', 'unknown', false);
        return this.handleFailure(claim, part.ordinal, failure);
      }
      await this.fencedPart(claim, part.ordinal, {
        state: 'SENT',
        telegramMessageId: BigInt(messageId),
        sentAt: new Date(),
      });
    }
    await this.finish(claim, 'SENT', null);
    this.logger.log({ message: 'Delivery sent', deliveryId: claim.id, parts: parts.length });
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
    });
    if (failure.certainty === 'unknown') {
      await this.fencedPart(claim, ordinal, { state: 'UNKNOWN' });
      return this.finish(claim, 'UNKNOWN', failure.code);
    }
    if (failure.permanent || claim.attempts >= MAX_DELIVERY_ATTEMPTS) {
      await this.fencedPart(claim, ordinal, { state: failure.permanent ? 'FAILED' : 'PENDING' });
      return this.finish(claim, 'PERMANENT_FAILURE', failure.code);
    }
    await this.fencedPart(claim, ordinal, { state: 'PENDING' });
    const delaySeconds = failure.retryAfterSeconds ?? Math.min(300, 5 * 2 ** (claim.attempts - 1));
    const updated = await this.prisma.$executeRaw`
      UPDATE delivery
         SET state = 'RETRYABLE_FAILURE', last_error_code = ${failure.code},
             next_attempt_at = now() + ${delaySeconds} * interval '1 second',
             lease_owner = NULL, lease_until = NULL, updated_at = now()
       WHERE id = ${claim.id}::uuid AND fencing_token = ${claim.fencingToken} AND state = 'SENDING'`;
    if (updated !== 1) throw new StaleDeliveryLease();
  }

  private async finish(
    claim: Claim,
    state: 'SENT' | 'UNKNOWN' | 'PERMANENT_FAILURE' | 'SUPPRESSED',
    code: string | null,
  ): Promise<void> {
    const result = await this.prisma.delivery.updateMany({
      where: { id: claim.id, fencingToken: claim.fencingToken, state: 'SENDING' },
      data: { state, lastErrorCode: code, leaseOwner: null, leaseUntil: null },
    });
    if (result.count !== 1) throw new StaleDeliveryLease();
  }

  /** Suppression code for a run-related delivery whose owner may not receive it, else null. */
  private async ineligibleOwner(claim: Claim): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<{ userId: string | null; status: string | null }[]>`
      SELECT r.user_id AS "userId", u.status::text AS status
        FROM delivery d
        JOIN research_run r ON r.id = d.run_id
        LEFT JOIN app_user u ON u.id = r.user_id
       WHERE d.id = ${claim.id}::uuid`;
    const owner = rows[0];
    if (!owner) return null; // not about a run (replies, invitations)
    if (owner.userId === null) return 'OWNER_UNRESOLVED';
    return owner.status === 'SUSPENDED' ? 'RECIPIENT_SUSPENDED' : null;
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
      select: { tokenHash: true },
    });
    const token = deriveInvitationToken(secret, claim.invitationId);
    if (!invitation || hashInvitationToken(token) !== invitation.tokenHash) return null;
    return html.split(INVITATION_TOKEN_PLACEHOLDER).join(token);
  }

  /** Updates one part only while this worker still holds the delivery lease. */
  private async fencedPart(
    claim: Claim,
    ordinal: number,
    data: {
      state: 'SENDING' | 'SENT' | 'UNKNOWN' | 'FAILED' | 'PENDING';
      telegramMessageId?: bigint;
      sentAt?: Date;
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
