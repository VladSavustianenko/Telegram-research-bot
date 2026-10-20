import { createHash } from 'node:crypto';
import type { Tx } from '../database/prisma-errors';
import type { Prisma } from '../generated/prisma/client';
import type { InlineKeyboard } from '../telegram/telegram-sender';
import { escapeHtml } from './telegram-html';

export type DeliveryKindName = 'STATUS' | 'REPORT' | 'RESEND' | 'INVITATION';

export interface DeliveryPartInput {
  html: string;
  replyMarkup?: InlineKeyboard;
}

/** Creates a delivery with immutable rendered parts. Call inside the business transaction. */
export async function createDelivery(
  tx: Tx,
  input: {
    kind: DeliveryKindName;
    chatId: bigint;
    runId?: string;
    invitationId?: string;
    parts: readonly (string | DeliveryPartInput)[];
    /**
     * The run's durable suppression reason (USER_SUSPENDED or TASK_DELETED): the
     * delivery is stored but never sent automatically.
     */
    suppressedBy?: string | null;
  },
): Promise<string> {
  const delivery = await tx.delivery.create({
    data: {
      kind: input.kind,
      chatId: input.chatId,
      runId: input.runId ?? null,
      invitationId: input.invitationId ?? null,
      ...(input.suppressedBy
        ? {
            state: 'SUPPRESSED',
            suppressedAt: new Date(),
            lastErrorCode:
              input.suppressedBy === 'USER_SUSPENDED' ? 'RECIPIENT_SUSPENDED' : input.suppressedBy,
          }
        : {}),
      parts: {
        create: input.parts.map((part, ordinal) => {
          const { html, replyMarkup } = typeof part === 'string' ? { html: part } : part;
          return {
            ordinal,
            html,
            ...(replyMarkup
              ? { replyMarkup: replyMarkup as unknown as Prisma.InputJsonValue }
              : {}),
            contentHash: createHash('sha256').update(html).digest('hex'),
          };
        }),
      },
    },
    select: { id: true },
  });
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
