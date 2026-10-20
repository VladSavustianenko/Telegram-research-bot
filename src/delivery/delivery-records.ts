import type { Tx } from '../database/prisma-errors';
import type { PrismaService } from '../database/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import type { InlineKeyboard } from '../telegram/telegram-sender';
import { partContentHash } from './report-renderer';
import { escapeHtml } from './telegram-html';

export type DeliveryKindName = 'STATUS' | 'REPORT' | 'RESEND' | 'INVITATION';

/** A message part (HTML, optional buttons) or a document part (caption HTML and file). */
export type DeliveryPartInput =
  | { kind?: 'MESSAGE'; html: string; replyMarkup?: InlineKeyboard }
  | { kind: 'DOCUMENT'; html: string; fileName: string; fileContent: string };

/** Why a delivery is stored without ever being sent automatically. */
export type SuppressionReason = 'USER_SUSPENDED' | 'TASK_DELETED' | 'CHAT_BLOCKED';

/** Delivery error code recorded for a suppression reason. */
export function suppressionCode(reason: string): string {
  return reason === 'USER_SUSPENDED' ? 'RECIPIENT_SUSPENDED' : reason;
}

/**
 * Creates a delivery with immutable rendered parts and, unless it is
 * suppressed, its first wake-up for the delivery queue. Call inside the
 * business transaction: the record and its publication request commit
 * together (transactional outbox, docs/DELIVERY.md).
 */
export async function createDelivery(
  tx: Tx,
  input: {
    kind: DeliveryKindName;
    chatId: bigint;
    runId?: string;
    invitationId?: string;
    parts: readonly (string | DeliveryPartInput)[];
    /**
     * The run's durable suppression reason (USER_SUSPENDED, TASK_DELETED or
     * CHAT_BLOCKED): the delivery is stored but never sent automatically.
     */
    suppressedBy?: string | null;
  },
): Promise<string> {
  // A confirmed unavailable chat receives nothing automatically (TRB-080).
  const suppressedBy =
    input.suppressedBy ?? ((await chatBlocked(tx, input.chatId)) ? 'CHAT_BLOCKED' : null);
  const delivery = await tx.delivery.create({
    data: {
      kind: input.kind,
      chatId: input.chatId,
      runId: input.runId ?? null,
      invitationId: input.invitationId ?? null,
      ...(suppressedBy
        ? {
            state: 'SUPPRESSED',
            suppressedAt: new Date(),
            lastErrorCode: suppressionCode(suppressedBy),
          }
        : {}),
      parts: {
        create: input.parts.map((raw, ordinal) => {
          const part: DeliveryPartInput = typeof raw === 'string' ? { html: raw } : raw;
          if (part.kind === 'DOCUMENT') {
            return {
              ordinal,
              kind: 'DOCUMENT' as const,
              html: part.html,
              fileName: part.fileName,
              fileContent: part.fileContent,
              contentHash: partContentHash(part),
            };
          }
          return {
            ordinal,
            html: part.html,
            ...(part.replyMarkup
              ? { replyMarkup: part.replyMarkup as unknown as Prisma.InputJsonValue }
              : {}),
            contentHash: partContentHash(part),
          };
        }),
      },
    },
    select: { id: true },
  });
  if (!suppressedBy) await wakeDelivery(tx, delivery.id, 'CREATED');
  return delivery.id;
}

/** Status message: plain text, escaped; optionally with inline buttons. */
export function createStatusDelivery(
  tx: Tx,
  chatId: bigint,
  text: string,
  runId?: string,
  replyMarkup?: InlineKeyboard,
  suppressedBy: string | null = null,
): Promise<string> {
  return createDelivery(tx, {
    kind: 'STATUS',
    chatId,
    parts: [{ html: escapeHtml(text), ...(replyMarkup ? { replyMarkup } : {}) }],
    ...(runId ? { runId } : {}),
    suppressedBy,
  });
}

/**
 * Durable wake-up of a delivery: an event the delivery dispatcher publishes to
 * the delivery queue once due. At most one undispatched event per delivery; a
 * new request merges into it and the earlier time wins. Written in the
 * caller's transaction.
 */
export async function wakeDelivery(
  tx: Tx | PrismaService,
  deliveryId: string,
  reason: string,
  delaySeconds = 0,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO delivery_event (id, delivery_id, reason, available_at)
    VALUES (gen_random_uuid(), ${deliveryId}::uuid, ${reason},
            now() + ${delaySeconds} * interval '1 second')
    ON CONFLICT (delivery_id) WHERE dispatched_at IS NULL AND cancelled_at IS NULL
    DO UPDATE SET available_at = LEAST(delivery_event.available_at, EXCLUDED.available_at)`;
}

/** Whether Telegram confirmed that this private chat cannot receive messages. */
export async function chatBlocked(tx: Tx | PrismaService, chatId: bigint): Promise<boolean> {
  const rows = await tx.$queryRaw<{ blocked: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM app_user
                    WHERE (private_chat_id = ${chatId} OR telegram_user_id = ${chatId})
                      AND chat_blocked_at IS NOT NULL) AS blocked`;
  return rows[0]?.blocked ?? false;
}

/**
 * Code for a delivery stopped by a durable decision recorded while it was being
 * sent: the run's suppression reason, else a confirmed chat block, else
 * suspension (the only earlier source of such decisions).
 */
export async function suppressionCodeFor(
  tx: Tx | PrismaService,
  deliveryId: string,
): Promise<string> {
  const rows = await tx.$queryRaw<{ reason: string | null; chatId: bigint }[]>`
    SELECT r.delivery_suppression_reason AS reason, d.chat_id AS "chatId"
      FROM delivery d LEFT JOIN research_run r ON r.id = d.run_id
     WHERE d.id = ${deliveryId}::uuid`;
  const row = rows[0];
  if (row?.reason) return suppressionCode(row.reason);
  if (row && (await chatBlocked(tx, row.chatId))) return 'CHAT_BLOCKED';
  return 'RECIPIENT_SUSPENDED';
}

/**
 * After a delivery finished: the next unfinished delivery to the same chat (in
 * creation order) may go now, so it is woken (at its retry time if it has one).
 */
export async function wakeNextInChat(tx: Tx | PrismaService, chatId: bigint): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO delivery_event (id, delivery_id, reason, available_at)
    SELECT gen_random_uuid(), d.id, 'PREVIOUS_IN_CHAT_FINISHED', GREATEST(now(), d.next_attempt_at)
      FROM delivery d
     WHERE d.chat_id = ${chatId} AND d.state IN ('PENDING', 'RETRYABLE_FAILURE')
       AND d.suppressed_at IS NULL
     ORDER BY d.seq
     LIMIT 1
    ON CONFLICT (delivery_id) WHERE dispatched_at IS NULL AND cancelled_at IS NULL
    DO UPDATE SET available_at = LEAST(delivery_event.available_at, EXCLUDED.available_at)`;
}
