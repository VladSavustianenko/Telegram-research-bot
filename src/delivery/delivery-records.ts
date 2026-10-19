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
  },
): Promise<string> {
  const delivery = await tx.delivery.create({
    data: {
      kind: input.kind,
      chatId: input.chatId,
      runId: input.runId ?? null,
      invitationId: input.invitationId ?? null,
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
): Promise<string> {
  return createDelivery(tx, {
    kind: 'STATUS',
    chatId,
    parts: [{ html: escapeHtml(text), ...(replyMarkup ? { replyMarkup } : {}) }],
    ...(runId ? { runId } : {}),
  });
}
