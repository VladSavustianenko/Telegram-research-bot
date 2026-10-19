import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import type { AppUser } from '../generated/prisma/client';
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
  // Durable decision for unfinished runs. Must precede the delivery statement: a
  // worker completing a run holds its row lock, so this waits for that commit and
  // the next statement then sees the REPORT delivery it created; a run locked
  // here first is completed afterwards and sees the decision (createDelivery).
  await tx.$executeRaw`
    UPDATE research_run SET delivery_suppressed_at = COALESCE(delivery_suppressed_at, now())
     WHERE user_id = ${target.id}::uuid AND state IN ('QUEUED', 'RUNNING')`;
  const cancelledRuns = await tx.$executeRaw`
    UPDATE research_run
       SET state = 'CANCELLED', failure_code = 'USER_SUSPENDED', completed_at = now(), updated_at = now()
     WHERE user_id = ${target.id}::uuid AND state = 'QUEUED'`;
  // Waiting deliveries end now; one being sent stops before its next part (the
  // worker holds the lease and finishes it). Never cleared by reactivation.
  const suppressedDeliveries = await tx.$executeRaw`
    UPDATE delivery
       SET suppressed_at = COALESCE(suppressed_at, now()),
           state = CASE WHEN state = 'SENDING' THEN state ELSE 'SUPPRESSED' END,
           last_error_code = CASE WHEN state = 'SENDING' THEN last_error_code ELSE 'RECIPIENT_SUSPENDED' END,
           updated_at = now()
     WHERE state IN ('PENDING', 'RETRYABLE_FAILURE', 'SENDING')
       AND run_id IN (SELECT id FROM research_run WHERE user_id = ${target.id}::uuid)`;
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
