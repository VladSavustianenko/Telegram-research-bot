import type { Tx } from '../database/prisma-errors';
import type { PrismaService } from '../database/prisma.service';
import { Prisma } from '../generated/prisma/client';

/** Admission's execution event: the run's admission evidence and its first wake-up. */
export const EXECUTE_EVENT = 'RESEARCH_EXECUTE';
/** Any later wake-up of a run (deferral, retry, recovery, shutdown hand-over). */
export const WAKE_EVENT = 'RESEARCH_WAKE';

/** Run states after which no job may advance the run. */
export const TERMINAL_RUN_STATES = ['SUCCEEDED', 'FAILED', 'UNCERTAIN', 'CANCELLED'] as const;

/**
 * Durable wake-up requests (docs/QUEUE.md). A wake-up is an outbox event that
 * the dispatcher publishes to pg-boss when it is due; the job it becomes only
 * asks a worker to inspect and advance the run, which rechecks everything in
 * the database. Each run has at most one undispatched event: a new request
 * merges into it and the earlier time wins. Written in the caller's
 * transaction, so it commits atomically with the business change it follows.
 */
export async function wakeRun(
  tx: Tx | PrismaService,
  runId: string,
  reason: string,
  when: { delaySeconds: number } | { at: Date } = { delaySeconds: 0 },
): Promise<void> {
  const at =
    'at' in when
      ? Prisma.sql`${when.at}::timestamptz`
      : Prisma.sql`now() + ${when.delaySeconds} * interval '1 second'`;
  await tx.$executeRaw`
    INSERT INTO outbox_event (id, operation_key, type, run_id, payload, available_at)
    VALUES (gen_random_uuid(), ${WAKE_EVENT} || ':' || gen_random_uuid(), ${WAKE_EVENT},
            ${runId}::uuid, jsonb_build_object('runId', ${runId}::text, 'reason', ${reason}::text), ${at})
    ON CONFLICT (run_id) WHERE dispatched_at IS NULL AND cancelled_at IS NULL
    DO UPDATE SET available_at = LEAST(outbox_event.available_at, EXCLUDED.available_at)`;
}

/**
 * Wakes every queued run that may start now (after a run finished and freed
 * capacity). Bounded by RESEARCH_QUEUE_LIMIT; each woken job claims the fairest
 * eligible run, so the order of the wake-ups does not matter.
 */
export async function wakeQueuedRuns(tx: Tx, reason: string): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO outbox_event (id, operation_key, type, run_id, payload, available_at)
    SELECT gen_random_uuid(), ${WAKE_EVENT} || ':' || gen_random_uuid(), ${WAKE_EVENT}, q.id,
           jsonb_build_object('runId', q.id::text, 'reason', ${reason}::text), now()
      FROM research_run q
     WHERE q.state = 'QUEUED' AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= now())
    ON CONFLICT (run_id) WHERE dispatched_at IS NULL AND cancelled_at IS NULL
    DO UPDATE SET available_at = LEAST(outbox_event.available_at, EXCLUDED.available_at)`;
}
