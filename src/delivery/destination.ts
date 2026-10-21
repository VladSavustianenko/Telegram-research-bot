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
  /** The recorded refusal was applied now (false: already applied, or superseded). */
  applied: boolean;
  /** The user wrote to the bot after the refusal: the chat works, nothing was blocked. */
  superseded: boolean;
  pausedTasks: number;
  cancelledRuns: number;
  suppressedDeliveries: number;
}

const NOTHING: BlockResult = {
  applied: false,
  superseded: false,
  pausedTasks: 0,
  cancelledRuns: 0,
  suppressedDeliveries: 0,
};

/**
 * Applies a confirmed destination refusal recorded on a delivery (TRB-080,
 * docs/DELIVERY.md). The refusal itself (destination_block_reason,
 * destination_refused_at) is committed first, with the delivery's terminal
 * state, by the delivery worker. This function applies its effects in one
 * transaction, with the inbox/scheduler lock order (identity lock, user row,
 * then task, run and delivery rows), and marks the record applied at the end,
 * so a failure anywhere leaves the record pending for the recovery sweep:
 * - the user gets chat_blocked_at (no automatic message is created for the
 *   chat while it is set);
 * - ACTIVE tasks become PAUSED with no next run, so no automatic research
 *   starts and nothing resumes by itself later;
 * - queued scheduled runs are cancelled (CHAT_BLOCKED), releasing their
 *   reservations once through the existing lifecycle;
 * - queued and running runs get the durable CHAT_BLOCKED delivery decision
 *   (their reports are stored but created SUPPRESSED), and every waiting
 *   delivery to the chat is suppressed. A running request is not cancelled:
 *   its cost is already committed and its report stays available;
 * - an audit event records the counts when something changed.
 * Idempotent: appliers are serialized by the identity lock and the record is
 * applied once. A refusal older than a later message from the user is
 * superseded (the chat demonstrably works again) and applies nothing.
 */
export async function applyRecordedBlock(
  prisma: PrismaService,
  deliveryId: string,
): Promise<BlockResult> {
  const record = await prisma.delivery.findUnique({
    where: { id: deliveryId },
    select: {
      chatId: true,
      destinationBlockReason: true,
      destinationRefusedAt: true,
      destinationBlockAppliedAt: true,
    },
  });
  if (!record?.destinationBlockReason || !record.destinationRefusedAt) return NOTHING;
  if (record.destinationBlockAppliedAt) return NOTHING;
  const reason = record.destinationBlockReason as BlockReason;
  const refusedAt = record.destinationRefusedAt;
  const chatId = record.chatId;

  return prisma.$transaction(async (tx) => {
    const owner = await tx.appUser.findFirst({
      where: { OR: [{ privateChatId: chatId }, { telegramUserId: chatId }] },
      select: { telegramUserId: true },
    });
    let result = NOTHING;
    let user: AppUser | null = null;
    if (owner) {
      await lockTelegramIdentity(tx, owner.telegramUserId);
      user = await lockUserByTelegramId(tx, owner.telegramUserId);
    }
    // Rechecked under the identity lock, which every applier takes first.
    const current = await tx.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: { destinationBlockAppliedAt: true },
    });
    if (current.destinationBlockAppliedAt) return NOTHING;
    if (user) {
      const later = await tx.telegramUpdate.count({
        where: { senderTelegramId: user.telegramUserId, receivedAt: { gt: refusedAt } },
      });
      result =
        later > 0
          ? { ...NOTHING, superseded: true }
          : { ...(await blockInTx(tx, user, chatId, reason)), applied: true, superseded: false };
    }
    await tx.$executeRaw`
      UPDATE delivery SET destination_block_applied_at = now()
       WHERE id = ${deliveryId}::uuid AND destination_block_applied_at IS NULL`;
    return result;
  });
}

/** Recorded refusals whose effects are not applied yet (recovery sweep), oldest first. */
export async function pendingRecordedBlocks(prisma: PrismaService): Promise<string[]> {
  const rows = await prisma.delivery.findMany({
    where: { destinationBlockReason: { not: null }, destinationBlockAppliedAt: null },
    orderBy: { destinationRefusedAt: 'asc' },
    select: { id: true },
    take: 20,
  });
  return rows.map((row) => row.id);
}

async function blockInTx(
  tx: Tx,
  user: AppUser,
  chatId: bigint,
  reason: BlockReason,
): Promise<Omit<BlockResult, 'applied' | 'superseded'>> {
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
           last_error_code = 'CHAT_BLOCKED',
           updated_at = now()
     WHERE chat_id = ${chatId} AND state IN ('PENDING', 'RETRYABLE_FAILURE', 'SENDING')`;
  await tx.$executeRaw`
    UPDATE delivery_event e SET cancelled_at = now()
      FROM delivery d
     WHERE d.id = e.delivery_id AND d.chat_id = ${chatId} AND d.state = 'SUPPRESSED'
       AND e.dispatched_at IS NULL AND e.cancelled_at IS NULL`;
  if (first || paused > 0 || cancelledRuns > 0) {
    await recordAudit(tx, {
      kind: 'DESTINATION_BLOCKED',
      subjectUserId: user.id,
      details: { reason, pausedTasks: paused, cancelledRuns, suppressedDeliveries: suppressed },
    });
  }
  return { pausedTasks: paused, cancelledRuns, suppressedDeliveries: suppressed };
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
