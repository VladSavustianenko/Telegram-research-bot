import { settleRun } from '../accounting/ledger';
import type { Tx } from '../database/prisma-errors';
import { Prisma } from '../generated/prisma/client';

export type RunScope = { userId: string } | { taskId: string };

const scopeSql = (scope: RunScope) =>
  'userId' in scope
    ? Prisma.sql`user_id = ${scope.userId}::uuid`
    : Prisma.sql`task_id = ${scope.taskId}::uuid`;

/**
 * Cancels QUEUED runs in scope (suspension, task pause or deletion). A queued
 * run was never submitted, so its reservation is released (once: the ledger
 * transition is conditional) and its execution event is cancelled, leaving
 * nothing executable. A run already claimed by a worker (RUNNING) is not
 * touched here. Returns the number of cancelled runs.
 */
export async function cancelQueuedRuns(tx: Tx, scope: RunScope, code: string): Promise<number> {
  const cancelled = await tx.$queryRaw<{ id: string }[]>`
    UPDATE research_run
       SET state = 'CANCELLED', failure_code = ${code}, completed_at = now(), updated_at = now()
     WHERE state = 'QUEUED' AND ${scopeSql(scope)}
    RETURNING id`;
  for (const { id } of cancelled) {
    await settleRun(tx, id, { outcome: 'release', reason: code });
    await tx.$executeRaw`
      UPDATE outbox_event SET cancelled_at = now()
       WHERE run_id = ${id}::uuid AND dispatched_at IS NULL AND cancelled_at IS NULL`;
  }
  return cancelled.length;
}

/**
 * Durable delivery suppression for runs in scope (docs/IDENTITY.md):
 * queued and running runs get the decision (their later reports are created
 * SUPPRESSED), and unfinished deliveries of all their runs get it too. Never
 * cleared. USER_SUSPENDED also makes polling request provider cancellation;
 * TASK_DELETED only suppresses delivery. Returns the suppressed deliveries.
 */
export async function suppressRunDeliveries(
  tx: Tx,
  scope: RunScope,
  reason: 'USER_SUSPENDED' | 'TASK_DELETED',
): Promise<number> {
  // Runs first: a completing worker holds the run row, so this waits for it and
  // the delivery statement below then sees the report it created.
  await tx.$executeRaw`
    UPDATE research_run
       SET delivery_suppressed_at = COALESCE(delivery_suppressed_at, now()),
           delivery_suppression_reason = COALESCE(delivery_suppression_reason, ${reason})
     WHERE ${scopeSql(scope)} AND state IN ('QUEUED', 'RUNNING')`;
  const code = reason === 'USER_SUSPENDED' ? 'RECIPIENT_SUSPENDED' : 'TASK_DELETED';
  return tx.$executeRaw`
    UPDATE delivery
       SET suppressed_at = COALESCE(suppressed_at, now()),
           state = CASE WHEN state = 'SENDING' THEN state ELSE 'SUPPRESSED' END,
           last_error_code = CASE WHEN state = 'SENDING' THEN last_error_code ELSE ${code} END,
           updated_at = now()
     WHERE state IN ('PENDING', 'RETRYABLE_FAILURE', 'SENDING')
       AND run_id IN (SELECT id FROM research_run WHERE ${scopeSql(scope)})`;
}
