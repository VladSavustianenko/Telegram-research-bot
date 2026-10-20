import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import type { AppUser } from '../generated/prisma/client';
import { cancelQueuedRuns, suppressRunDeliveries } from '../research/lifecycle';
import { recordAudit } from './audit';
import { isConfiguredAdmin } from './authorization';
import { lockUserByTelegramId } from './users';

export type LifecycleResult =
  | { result: 'DONE'; cancelledRuns: number; suppressedDeliveries: number; runningRuns: number }
  | { result: 'USER_NOT_FOUND' | 'TARGET_IS_ADMIN' | 'NO_CHANGE' };

/**
 * Suspends a user (SPEC §2). The caller must have authorized the administrator.
 * In one transaction, under the target's row lock:
 * - status SUSPENDED (no new research or protected operations);
 * - QUEUED and RUNNING runs get a durable delivery_suppressed_at decision;
 *   QUEUED runs become CANCELLED / USER_SUSPENDED (never submitted);
 * - unfinished deliveries of the user's runs get suppressed_at: waiting ones
 *   become SUPPRESSED, one being sent stops before its next part.
 * Running runs are left to the worker, which requests provider cancellation
 * and keeps tracking the request; their reports are stored but created
 * SUPPRESSED. Reactivation never clears these decisions.
 * Administrators (by role or configuration) cannot be suspended.
 */
export async function suspendUser(
  tx: Tx,
  config: Env,
  actor: AppUser,
  targetTelegramId: bigint,
): Promise<LifecycleResult> {
  const target = await lockUserByTelegramId(tx, targetTelegramId);
  if (!target) return { result: 'USER_NOT_FOUND' };
  if (target.role === 'ADMIN' || isConfiguredAdmin(config, target.telegramUserId)) {
    return { result: 'TARGET_IS_ADMIN' };
  }
  if (target.status === 'SUSPENDED') return { result: 'NO_CHANGE' };

  await tx.appUser.update({
    where: { id: target.id },
    data: { status: 'SUSPENDED', suspendedAt: new Date(), revision: { increment: 1 } },
  });
  // Durable decision for unfinished runs and deliveries (never cleared by
  // reactivation); then queued runs are cancelled, releasing their reservations
  // and execution events.
  const suppressedDeliveries = await suppressRunDeliveries(
    tx,
    { userId: target.id },
    'USER_SUSPENDED',
  );
  const cancelledRuns = await cancelQueuedRuns(tx, { userId: target.id }, 'USER_SUSPENDED');
  const runningRuns = await tx.researchRun.count({
    where: { userId: target.id, state: 'RUNNING' },
  });
  await recordAudit(tx, {
    kind: 'USER_SUSPENDED',
    actorUserId: actor.id,
    subjectUserId: target.id,
    details: { cancelledRuns, suppressedDeliveries, runningRuns },
  });
  return { result: 'DONE', cancelledRuns, suppressedDeliveries, runningRuns };
}

/**
 * Reactivates a suspended user. Suppressed deliveries and cancelled runs stay
 * as they are: no accumulated backlog is delivered (SPEC §2).
 */
export async function reactivateUser(
  tx: Tx,
  actor: AppUser,
  targetTelegramId: bigint,
): Promise<LifecycleResult> {
  const target = await lockUserByTelegramId(tx, targetTelegramId);
  if (!target) return { result: 'USER_NOT_FOUND' };
  if (target.status !== 'SUSPENDED') return { result: 'NO_CHANGE' };
  await tx.appUser.update({
    where: { id: target.id },
    data: { status: 'ACTIVE', suspendedAt: null, revision: { increment: 1 } },
  });
  await recordAudit(tx, {
    kind: 'USER_REACTIVATED',
    actorUserId: actor.id,
    subjectUserId: target.id,
  });
  return { result: 'DONE', cancelledRuns: 0, suppressedDeliveries: 0, runningRuns: 0 };
}
