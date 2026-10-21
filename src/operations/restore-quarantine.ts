import { settleRun, type SettlementResult } from '../accounting/ledger';
import type { Tx } from '../database/prisma-errors';
import type { PrismaService } from '../database/prisma.service';
import { cancelDeliveryEvents, wakeNextInChat } from '../delivery/delivery-records';
import { recordAudit } from '../identity/audit';
import { lockUserForShare } from '../identity/users';
import type { ProviderUsage } from '../research/provider/provider.types';

/**
 * Restore quarantine (TRB-100 review fix, docs/OPERATIONS.md, section 11.3).
 *
 * After restoring an older backup, a run that is QUEUED or RUNNING in the copy
 * may already have been submitted to the provider after the backup, and a
 * delivery that is waiting may already have been sent. Neither can be known
 * from the database. This module lets the operator neutralize selected records
 * while the operational hold keeps every application process idle:
 *
 * - **Run** (QUEUED or RUNNING) → UNCERTAIN with `RESTORE_QUARANTINED`. Its
 *   response ID, attempts, usage and pricing snapshot are kept; the open
 *   attempt (if one was recorded) is closed as UNCERTAIN; a RESERVED
 *   reservation becomes UNRESOLVED with its full exposure retained (never
 *   released: the request may exist); pending execution events are
 *   cancelled; the lease is fenced. Workers treat the run as finished, so it
 *   is never submitted or polled again. Live runs then block live research
 *   like any unreconciled UNCERTAIN run, until the operator records the
 *   provider finding (`ops:reconcile`, e.g. PROVIDER_REQUEST_ABSENT for a
 *   confirmed non-execution) and the cost (`ops:accounting`, an explicit
 *   amount, 0 only when stated).
 * - **Delivery** (PENDING, RETRYABLE_FAILURE or SENDING) → SUPPRESSED with
 *   `RESTORE_QUARANTINED` and a durable suppression decision. Confirmed parts
 *   keep their message IDs and content; every unconfirmed part becomes UNKNOWN
 *   (it may have been sent after the backup), never "unsent". Wake-ups are
 *   cancelled and the next delivery in the chat is woken, so later messages
 *   are not blocked.
 *
 * Mutations need the hold (locked for share, so it cannot be cleared
 * concurrently), no live research or delivery lease (no process executing),
 * an operator name and a reason. All selected records change in one
 * transaction, each with an audit event; any error rolls everything back.
 * Repeating a completed decision changes nothing and writes no audit event.
 * Nothing here contacts OpenAI or Telegram.
 */

export const RESTORE_QUARANTINED = 'RESTORE_QUARANTINED';

export type Target = { kind: 'run' | 'delivery'; id: string };

export type PlanAction = 'QUARANTINE' | 'ALREADY_QUARANTINED' | 'NOT_APPLICABLE';

export interface PlanItem {
  kind: 'run' | 'delivery';
  id: string;
  action: PlanAction;
  current: Record<string, string | number | boolean | null>;
  /** What applying would do (or did); empty when nothing changes. */
  changes: string[];
  /** After apply: accounting transition of the run's reservation. */
  accounting?: SettlementResult;
}

export class QuarantineError extends Error {
  constructor(readonly code: string) {
    super(`Restore quarantine refused: ${code}`);
    this.name = 'QuarantineError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_RUN = new Set(['QUEUED', 'RUNNING']);
const WAITING_DELIVERY = new Set(['PENDING', 'RETRYABLE_FAILURE', 'SENDING']);

interface RunRow {
  id: string;
  userId: string | null;
  state: string;
  failureCode: string | null;
  submissionState: string;
  providerKind: string;
  providerResponseId: string | null;
  providerModel: string | null;
  usage: unknown;
  toolCallCount: number | null;
  currentAttemptNo: number;
  reservation: string | null;
  pendingEvents: number;
}

interface DeliveryRow {
  id: string;
  runId: string | null;
  kind: string;
  chatId: bigint;
  state: string;
  lastErrorCode: string | null;
  parts: number;
  sentParts: number;
  unconfirmedParts: number;
}

function validTargets(targets: readonly Target[]): void {
  if (targets.length === 0) throw new QuarantineError('NO_TARGETS');
  for (const target of targets) {
    if (!UUID.test(target.id)) throw new QuarantineError(`INVALID_ID:${target.id.slice(0, 40)}`);
  }
}

async function readRun(db: Tx | PrismaService, id: string, lock: boolean): Promise<RunRow | null> {
  const rows = lock
    ? await db.$queryRaw<RunRow[]>`
        SELECT id FROM research_run WHERE id = ${id}::uuid FOR UPDATE`
    : [];
  if (lock && rows.length === 0) return null;
  const [row] = await db.$queryRaw<RunRow[]>`
    SELECT r.id, r.user_id AS "userId", r.state::text AS state, r.failure_code AS "failureCode",
           r.submission_state::text AS "submissionState", r.provider_kind AS "providerKind",
           r.provider_response_id AS "providerResponseId", r.provider_model AS "providerModel",
           r.usage, r.tool_call_count AS "toolCallCount", r.current_attempt_no AS "currentAttemptNo",
           (SELECT b.status::text FROM budget_reservation b
             WHERE b.run_id = r.id ORDER BY b.attempt_no DESC LIMIT 1) AS reservation,
           (SELECT count(*)::int FROM outbox_event o
             WHERE o.run_id = r.id AND o.dispatched_at IS NULL AND o.cancelled_at IS NULL)
             AS "pendingEvents"
      FROM research_run r WHERE r.id = ${id}::uuid`;
  return row ?? null;
}

async function readDelivery(
  db: Tx | PrismaService,
  id: string,
  lock: boolean,
): Promise<DeliveryRow | null> {
  if (lock) {
    const locked = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM delivery WHERE id = ${id}::uuid FOR UPDATE`;
    if (locked.length === 0) return null;
  }
  const [row] = await db.$queryRaw<DeliveryRow[]>`
    SELECT d.id, d.run_id AS "runId", d.kind::text AS kind, d.chat_id AS "chatId",
           d.state::text AS state, d.last_error_code AS "lastErrorCode",
           (SELECT count(*)::int FROM delivery_part p WHERE p.delivery_id = d.id) AS parts,
           (SELECT count(*)::int FROM delivery_part p
             WHERE p.delivery_id = d.id AND p.state = 'SENT') AS "sentParts",
           (SELECT count(*)::int FROM delivery_part p
             WHERE p.delivery_id = d.id AND p.state IN ('PENDING', 'SENDING')) AS "unconfirmedParts"
      FROM delivery d WHERE d.id = ${id}::uuid`;
  return row ?? null;
}

function planRun(run: RunRow): PlanItem {
  const current = {
    state: run.state,
    submissionState: run.submissionState,
    providerKind: run.providerKind,
    hasResponseId: run.providerResponseId !== null,
    attemptNo: run.currentAttemptNo,
    reservation: run.reservation,
    pendingEvents: run.pendingEvents,
  };
  if (run.state === 'UNCERTAIN' && run.failureCode === RESTORE_QUARANTINED) {
    return { kind: 'run', id: run.id, action: 'ALREADY_QUARANTINED', current, changes: [] };
  }
  if (!ACTIVE_RUN.has(run.state)) {
    return { kind: 'run', id: run.id, action: 'NOT_APPLICABLE', current, changes: [] };
  }
  const changes = [
    `state ${run.state} -> UNCERTAIN (${RESTORE_QUARANTINED}); never submitted or polled again`,
    run.providerResponseId
      ? 'response ID kept as reconciliation evidence'
      : 'no response ID recorded: a request may still exist (unknown)',
  ];
  if (run.submissionState !== 'NOT_SUBMITTED') changes.push('open attempt closed as UNCERTAIN');
  if (run.reservation === 'RESERVED') {
    changes.push('reservation RESERVED -> UNRESOLVED, full exposure retained');
  }
  if (run.pendingEvents > 0)
    changes.push(`${run.pendingEvents} pending execution event(s) cancelled`);
  if (run.providerKind === 'openai') {
    changes.push('blocks live research until ops:reconcile records the provider finding');
  }
  return { kind: 'run', id: run.id, action: 'QUARANTINE', current, changes };
}

function planDelivery(delivery: DeliveryRow): PlanItem {
  const current = {
    state: delivery.state,
    kind: delivery.kind,
    runId: delivery.runId,
    parts: delivery.parts,
    sentParts: delivery.sentParts,
    unconfirmedParts: delivery.unconfirmedParts,
  };
  if (delivery.state === 'SUPPRESSED' && delivery.lastErrorCode === RESTORE_QUARANTINED) {
    return {
      kind: 'delivery',
      id: delivery.id,
      action: 'ALREADY_QUARANTINED',
      current,
      changes: [],
    };
  }
  if (!WAITING_DELIVERY.has(delivery.state)) {
    return { kind: 'delivery', id: delivery.id, action: 'NOT_APPLICABLE', current, changes: [] };
  }
  const changes = [
    `state ${delivery.state} -> SUPPRESSED (${RESTORE_QUARANTINED}); never sent automatically`,
  ];
  if (delivery.unconfirmedParts > 0) {
    changes.push(
      `${delivery.unconfirmedParts} unconfirmed part(s) -> UNKNOWN (may have been sent)`,
    );
  }
  if (delivery.sentParts > 0) changes.push(`${delivery.sentParts} confirmed part(s) unchanged`);
  changes.push('wake-ups cancelled; the next delivery in the chat may proceed');
  return { kind: 'delivery', id: delivery.id, action: 'QUARANTINE', current, changes };
}

/** Read-only: what applying would do. Unknown IDs are reported, not guessed. */
export async function previewQuarantine(
  prisma: PrismaService,
  targets: readonly Target[],
): Promise<PlanItem[]> {
  validTargets(targets);
  const plan: PlanItem[] = [];
  for (const target of targets) {
    if (target.kind === 'run') {
      const run = await readRun(prisma, target.id, false);
      if (!run) throw new QuarantineError(`RUN_NOT_FOUND:${target.id}`);
      plan.push(planRun(run));
    } else {
      const delivery = await readDelivery(prisma, target.id, false);
      if (!delivery) throw new QuarantineError(`DELIVERY_NOT_FOUND:${target.id}`);
      plan.push(planDelivery(delivery));
    }
  }
  return plan;
}

/** Fails unless the hold is set (and keeps it from being cleared) and nothing is executing. */
async function requireQuarantine(tx: Tx): Promise<void> {
  const hold = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM operational_hold WHERE id = 'execution' FOR SHARE`;
  if (hold.length === 0) throw new QuarantineError('HOLD_REQUIRED');
  const [live] = await tx.$queryRaw<{ research: number; delivery: number }[]>`
    SELECT (SELECT count(*)::int FROM research_run
             WHERE state = 'RUNNING' AND lease_until > now()) AS research,
           (SELECT count(*)::int FROM delivery
             WHERE state = 'SENDING' AND lease_until > now()) AS delivery`;
  if ((live?.research ?? 0) > 0 || (live?.delivery ?? 0) > 0) {
    throw new QuarantineError('NOT_QUIESCED');
  }
}

async function quarantineRun(
  tx: Tx,
  id: string,
  decision: { operator: string; reason: string },
): Promise<PlanItem> {
  const before = await readRun(tx, id, false);
  if (!before) throw new QuarantineError(`RUN_NOT_FOUND:${id}`);
  // Lock order: owner, then the run, then (in settleRun) the reservation.
  if (before.userId) await lockUserForShare(tx, before.userId);
  const run = await readRun(tx, id, true);
  if (!run) throw new QuarantineError(`RUN_NOT_FOUND:${id}`);
  const item = planRun(run);
  if (item.action !== 'QUARANTINE') return item;

  const moved = await tx.$executeRaw`
    UPDATE research_run
       SET state = 'UNCERTAIN', failure_code = ${RESTORE_QUARANTINED}, completed_at = now(),
           lease_owner = NULL, lease_until = NULL, fencing_token = fencing_token + 1,
           next_attempt_at = NULL, updated_at = now()
     WHERE id = ${id}::uuid AND state IN ('QUEUED', 'RUNNING')`;
  if (moved !== 1) throw new QuarantineError(`CONCURRENT_CHANGE:${id}`);
  // Only an attempt that was recorded is closed; none is invented for a run never seen submitted.
  await tx.$executeRaw`
    UPDATE research_attempt
       SET outcome = 'UNCERTAIN', failure_code = ${RESTORE_QUARANTINED},
           completed_at = COALESCE(completed_at, now()), updated_at = now()
     WHERE run_id = ${id}::uuid AND attempt_no = ${run.currentAttemptNo} AND outcome IS NULL`;
  // The request may exist: the reservation is kept as UNRESOLVED (never released).
  const accounting = await settleRun(tx, id, {
    outcome: 'unresolved',
    reason: RESTORE_QUARANTINED,
    usage: (run.usage as ProviderUsage | null) ?? null,
    returnedModel: run.providerModel,
    observedSearchItems: run.toolCallCount ?? 0,
  });
  await tx.$executeRaw`
    UPDATE outbox_event SET cancelled_at = now()
     WHERE run_id = ${id}::uuid AND dispatched_at IS NULL AND cancelled_at IS NULL`;
  await recordAudit(tx, {
    kind: 'RESTORE_RUN_QUARANTINED',
    subjectUserId: run.userId,
    details: {
      operator: decision.operator,
      reason: decision.reason,
      runId: id,
      previousState: run.state,
      submissionState: run.submissionState,
      providerKind: run.providerKind,
      hasResponseId: run.providerResponseId !== null,
      attemptNo: run.currentAttemptNo,
      accounting,
      cancelledEvents: run.pendingEvents,
    },
  });
  return { ...item, accounting };
}

async function quarantineDelivery(
  tx: Tx,
  id: string,
  decision: { operator: string; reason: string },
): Promise<PlanItem> {
  const delivery = await readDelivery(tx, id, true);
  if (!delivery) throw new QuarantineError(`DELIVERY_NOT_FOUND:${id}`);
  const item = planDelivery(delivery);
  if (item.action !== 'QUARANTINE') return item;

  // Unconfirmed parts may have been sent after the backup: UNKNOWN, never "unsent".
  const unknown = await tx.deliveryPart.updateMany({
    where: { deliveryId: id, state: { in: ['PENDING', 'SENDING'] } },
    data: { state: 'UNKNOWN', errorCode: RESTORE_QUARANTINED },
  });
  const moved = await tx.$executeRaw`
    UPDATE delivery
       SET state = 'SUPPRESSED', suppressed_at = COALESCE(suppressed_at, now()),
           last_error_code = ${RESTORE_QUARANTINED}, lease_owner = NULL, lease_until = NULL,
           fencing_token = fencing_token + 1, updated_at = now()
     WHERE id = ${id}::uuid AND state IN ('PENDING', 'RETRYABLE_FAILURE', 'SENDING')`;
  if (moved !== 1) throw new QuarantineError(`CONCURRENT_CHANGE:${id}`);
  await cancelDeliveryEvents(tx, id);
  await wakeNextInChat(tx, delivery.chatId);
  const [owner] = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM app_user WHERE private_chat_id = ${delivery.chatId} LIMIT 1`;
  await recordAudit(tx, {
    kind: 'RESTORE_DELIVERY_SUPPRESSED',
    subjectUserId: owner?.id ?? null,
    details: {
      operator: decision.operator,
      reason: decision.reason,
      deliveryId: id,
      runId: delivery.runId,
      previousState: delivery.state,
      confirmedParts: delivery.sentParts,
      partsMadeUnknown: unknown.count,
    },
  });
  return item;
}

/**
 * Applies the quarantine to every selected record in one transaction (see the
 * module comment). Throws QuarantineError (nothing changed) when the hold is
 * missing, a process is executing, an ID is unknown or the input is invalid.
 */
export async function applyQuarantine(
  prisma: PrismaService,
  input: { targets: readonly Target[]; operator: string; reason: string },
): Promise<PlanItem[]> {
  validTargets(input.targets);
  const operator = input.operator.trim();
  const reason = input.reason.trim();
  if (!operator || operator.length > 100) throw new QuarantineError('INVALID_OPERATOR');
  if (!reason || reason.length > 500) throw new QuarantineError('INVALID_REASON');
  return prisma.$transaction(async (tx) => {
    await requireQuarantine(tx);
    const result: PlanItem[] = [];
    // Runs before deliveries: the established order (run, then delivery rows).
    for (const target of input.targets.filter((t) => t.kind === 'run')) {
      result.push(await quarantineRun(tx, target.id, { operator, reason }));
    }
    for (const target of input.targets.filter((t) => t.kind === 'delivery')) {
      result.push(await quarantineDelivery(tx, target.id, { operator, reason }));
    }
    return result;
  });
}

/** Restored records that may still act on reopening: candidates for review. Read-only. */
export async function listCandidates(prisma: PrismaService) {
  const runs = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT r.id, r.state::text AS state, r.submission_state::text AS "submissionState",
           r.provider_kind AS "providerKind", r."trigger"::text AS trigger, r.task_id AS "taskId",
           r.requested_by_telegram_user_id::text AS "requestedBy",
           r.provider_response_id AS "providerResponseId", r.created_at AS "createdAt",
           r.submitted_at AS "submittedAt", r.lease_until AS "leaseUntil",
           (SELECT b.status::text FROM budget_reservation b
             WHERE b.run_id = r.id ORDER BY b.attempt_no DESC LIMIT 1) AS reservation
      FROM research_run r WHERE r.state IN ('QUEUED', 'RUNNING') ORDER BY r.created_at`;
  const deliveries = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT d.id, d.kind::text AS kind, d.state::text AS state, d.chat_id::text AS "chatId",
           d.run_id AS "runId", d.created_at AS "createdAt", d.attempts,
           (SELECT count(*)::int FROM delivery_part p WHERE p.delivery_id = d.id) AS parts,
           (SELECT count(*)::int FROM delivery_part p
             WHERE p.delivery_id = d.id AND p.state = 'SENT') AS "sentParts"
      FROM delivery d WHERE d.state IN ('PENDING', 'RETRYABLE_FAILURE', 'SENDING')
     ORDER BY d.seq`;
  const tasks = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT id, schedule_kind::text AS "scheduleKind", next_run_at AS "nextRunAt"
      FROM task WHERE state = 'ACTIVE' AND schedule_kind <> 'MANUAL' ORDER BY next_run_at`;
  return { runs, deliveries, scheduledTasks: tasks };
}
