import type { Tx } from '../database/prisma-errors';
import type { PrismaService } from '../database/prisma.service';
import type { AppUser } from '../generated/prisma/client';
import { recordAudit } from '../identity/audit';
import { lockTelegramIdentity, lockUserByTelegramId } from '../identity/users';
import { cancelQueuedRuns, suppressRunDeliveries } from '../research/lifecycle';
import { createStatusDelivery } from './delivery-records';
import { messages } from './messages';

export type BlockReason = 'BOT_BLOCKED' | 'USER_DEACTIVATED';

export interface BlockResult {
  /** False when the chat belongs to no user or the block was already recorded. */
  recorded: boolean;
  pausedTasks: number;
  cancelledRuns: number;
  suppressedDeliveries: number;
}

/**
 * Telegram confirmed that a private chat cannot receive messages (TRB-080,
 * docs/DELIVERY.md). In one transaction, with the inbox/scheduler lock order
 * (identity lock, user row, then task, run and delivery rows):
 * - the user gets chat_blocked_at (no automatic message is created for the chat
 *   while it is set);
 * - ACTIVE tasks become PAUSED with no next run, so no automatic research
 *   starts and nothing resumes by itself later;
 * - queued scheduled runs are cancelled (CHAT_BLOCKED), releasing their
 *   reservations once through the existing lifecycle;
 * - queued and running runs get the durable CHAT_BLOCKED delivery decision
 *   (their reports are stored but created SUPPRESSED), and every waiting
 *   delivery to the chat is suppressed. A running request is not cancelled:
 *   its cost is already committed and its report stays available;
 * - an audit event records the counts.
 * Repeating it (another delivery fails the same way) only suppresses what is
 * still waiting.
 */
export async function markDestinationBlocked(
  prisma: PrismaService,
  chatId: bigint,
  reason: BlockReason,
): Promise<BlockResult> {
  return prisma.$transaction(async (tx) => {
    const owner = await tx.appUser.findFirst({
      where: { OR: [{ privateChatId: chatId }, { telegramUserId: chatId }] },
      select: { telegramUserId: true },
    });
    const none = { recorded: false, pausedTasks: 0, cancelledRuns: 0, suppressedDeliveries: 0 };
    if (!owner) return none;
    await lockTelegramIdentity(tx, owner.telegramUserId);
    const user = await lockUserByTelegramId(tx, owner.telegramUserId);
    if (!user) return none;
    const first = user.chatBlockedAt === null;
    if (first) {
      await tx.appUser.update({
        where: { id: user.id },
        data: { chatBlockedAt: new Date(), chatBlockReason: reason },
      });
    }
    const paused = await tx.$executeRaw`
      UPDATE task SET state = 'PAUSED', next_run_at = NULL, revision = revision + 1, updated_at = now()
       WHERE user_id = ${user.id}::uuid AND state = 'ACTIVE'`;
    const cancelledRuns = await cancelQueuedRuns(
      tx,
      { userId: user.id, trigger: 'SCHEDULED' },
      'CHAT_BLOCKED',
    );
    let suppressed = await suppressRunDeliveries(tx, { userId: user.id }, 'CHAT_BLOCKED');
    suppressed += await tx.$executeRaw`
      UPDATE delivery
         SET suppressed_at = COALESCE(suppressed_at, now()),
             state = CASE WHEN state = 'SENDING' THEN state ELSE 'SUPPRESSED' END,
             last_error_code = CASE WHEN state = 'SENDING' THEN last_error_code ELSE 'CHAT_BLOCKED' END,
             updated_at = now()
       WHERE chat_id = ${chatId} AND state IN ('PENDING', 'RETRYABLE_FAILURE', 'SENDING')`;
    await tx.$executeRaw`
      UPDATE delivery_event e SET cancelled_at = now()
        FROM delivery d
       WHERE d.id = e.delivery_id AND d.chat_id = ${chatId} AND d.state = 'SUPPRESSED'
         AND e.dispatched_at IS NULL AND e.cancelled_at IS NULL`;
    const result = {
      recorded: first,
      pausedTasks: paused,
      cancelledRuns,
      suppressedDeliveries: suppressed,
    };
    if (first || paused > 0 || cancelledRuns > 0) {
      await recordAudit(tx, {
        kind: 'DESTINATION_BLOCKED',
        subjectUserId: user.id,
        details: { reason, pausedTasks: paused, cancelledRuns, suppressedDeliveries: suppressed },
      });
    }
    return result;
  });
}

/**
 * Explicit recovery: the user wrote to the bot again (any private message or
 * button), which Telegram only allows after unblocking. Called by the inbox
 * under the sender's locks, before the reply is created. Clears the block and
 * tells the user that tasks stay paused until resumed one by one (next future
 * occurrence, no catch-up) and that nothing suppressed is sent in bulk.
 */
export async function restoreDestination(tx: Tx, user: AppUser): Promise<AppUser> {
  if (user.chatBlockedAt === null) return user;
  const restored = await tx.appUser.update({
    where: { id: user.id },
    data: { chatBlockedAt: null, chatBlockReason: null },
  });
  const paused = await tx.task.count({ where: { userId: user.id, state: 'PAUSED' } });
  await recordAudit(tx, {
    kind: 'DESTINATION_RESTORED',
    subjectUserId: user.id,
    details: { blockedAt: user.chatBlockedAt.toISOString(), pausedTasks: paused },
  });
  await createStatusDelivery(
    tx,
    user.privateChatId ?? user.telegramUserId,
    messages.chatRestored(paused),
  );
  return restored;
}
