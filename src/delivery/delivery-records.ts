import { createHash } from 'node:crypto';
import type { Tx } from '../database/prisma-errors';
import { escapeHtml } from './telegram-html';

export type DeliveryKindName = 'STATUS' | 'REPORT' | 'RESEND';

/** Creates a delivery with immutable rendered parts. Call inside the business transaction. */
export async function createDelivery(
  tx: Tx,
  input: { kind: DeliveryKindName; chatId: bigint; runId?: string; parts: readonly string[] },
): Promise<string> {
  const delivery = await tx.delivery.create({
    data: {
      kind: input.kind,
      chatId: input.chatId,
      runId: input.runId ?? null,
      parts: {
        create: input.parts.map((html, ordinal) => ({
          ordinal,
          html,
          contentHash: createHash('sha256').update(html).digest('hex'),
        })),
      },
    },
    select: { id: true },
  });
  return delivery.id;
}

/** Status message: plain text, escaped. */
export function createStatusDelivery(
  tx: Tx,
  chatId: bigint,
  text: string,
  runId?: string,
): Promise<string> {
  return createDelivery(tx, {
    kind: 'STATUS',
    chatId,
    parts: [escapeHtml(text)],
    ...(runId ? { runId } : {}),
  });
}
