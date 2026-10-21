import { randomUUID } from 'node:crypto';
import { exposureMicros, registerPricing, reserve } from '../accounting/ledger';
import { effectiveLimits } from '../accounting/limits';
import { livePolicy, periodsOf, type ReservationPolicy } from '../accounting/pricing';
import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import { createStatusDelivery } from '../delivery/delivery-records';
import { denialMessage, messages } from '../delivery/messages';
import type { AppUser } from '../generated/prisma/client';
import { researchAdmissionDenial } from '../identity/authorization';
import { snapshotRunConfig } from './request-builder';
import { hasUnresolvedLiveUncertainty } from './uncertainty';
import { EXECUTE_EVENT } from './wake';

/**
 * Postgres advisory lock key serialising research admission and retry
 * authorization (all capacity and budget checks).
 */
export const ADMISSION_LOCK_KEY = 20_020;
export { EXECUTE_EVENT };

export interface AdmissionOutcome {
  disposition: 'RUN_ACCEPTED' | 'REPLIED' | 'REJECTED';
  reason: string | null;
  runId?: string;
  /** Quiet admissions: the reply that was not sent (the caller decides). */
  message?: string;
}

export type AdmissionSource =
  | { kind: 'prompt'; prompt: string }
  | { kind: 'task'; taskId: string; revision: number }
  /** A planned occurrence of an active task (TRB-070 scheduler). */
  | { kind: 'schedule'; taskId: string; revision: number; occurrenceAt: Date };

/**
 * The single admission path for research (`/research`, a task's "Run now" and
 * scheduled occurrences), inside the caller's transaction. Lock order: the
 * owner's identity lock and user row (taken by the caller: the inbox, or the
 * scheduler) → task row → global admission lock. Under them it:
 *  1. authorizes (live research stays administrator-only);
 *  2. checks the task's owner, state and revision, and returns an active run of
 *     the task instead of starting another;
 *  3. enforces queue and per-user active-run capacity;
 *  4. enforces the user's daily run quotas (UTC day);
 *  5. for live runs: refuses while a live run is unresolved, requires complete
 *     accounting configuration and checks user and global monthly budgets
 *     against current exposure plus the new reservation;
 *  6. creates the run with its immutable snapshot, the reservation and its
 *     ledger entry, the execution outbox event and the acknowledgement. The
 *     outbox dispatcher later publishes the event to pg-boss (docs/QUEUE.md).
 * A rejection creates no run, reservation or outbox event (only a reply).
 * With `quiet` (scheduled occurrences) no reply or acknowledgement is written:
 * the text is returned and the scheduler decides whether to send it.
 */
export async function admitResearch(
  tx: Tx,
  config: Env,
  input: {
    user: AppUser;
    chatId: bigint;
    /** The Telegram update of a manual request; null for scheduled occurrences. */
    updateId: bigint | null;
    now: Date;
    source: AdmissionSource;
    quiet?: boolean;
  },
): Promise<AdmissionOutcome> {
  const { user, chatId } = input;
  const say = (text: string, runId?: string) =>
    input.quiet
      ? Promise.resolve()
      : createStatusDelivery(tx, chatId, text, runId).then(() => undefined);
  const refuse = async (reason: string, text: string): Promise<AdmissionOutcome> => {
    await say(text);
    return { disposition: 'REJECTED', reason, ...(input.quiet ? { message: text } : {}) };
  };
  const scheduled = input.source.kind === 'schedule' ? input.source : null;
  // The user row is held by the caller (identity lock, then the row), so a limit
  // change committed before this admission is seen, and a later one waits for it.
  const limits = effectiveLimits(user, config);

  // The task (if any) supplies the prompt and zone, read under its row lock.
  let prompt: string;
  let timeZone: string | null = user.timeZone;
  let task: { id: string; revision: number } | null = null;
  if (input.source.kind === 'task' || input.source.kind === 'schedule') {
    // Manual runs are allowed for paused tasks (SPEC §4); scheduled ones only for active tasks.
    const rows = await tx.$queryRaw<
      { id: string; revision: number; prompt: string; timeZone: string }[]
    >`
      SELECT id, revision, prompt, time_zone AS "timeZone" FROM task
       WHERE id = ${input.source.taskId}::uuid AND user_id = ${user.id}::uuid AND state <> 'DELETED'
         AND (${scheduled === null} OR state = 'ACTIVE')
       FOR UPDATE`;
    const row = rows[0];
    if (!row) return refuse('TASK_NOT_FOUND', messages.taskNotFound);
    if (row.revision !== input.source.revision) return refuse('TASK_STALE', messages.taskChanged);
    const active = await tx.researchRun.findFirst({
      where: { taskId: row.id, state: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true, state: true },
    });
    if (active) {
      // Repeated "Run now": the existing run's status, no new quota or reservation.
      // A scheduled occurrence records the overlap instead (the run is not reused).
      await say(
        active.state === 'QUEUED' ? messages.runQueued(active.id) : messages.runRunning(active.id),
        active.id,
      );
      return { disposition: 'REPLIED', reason: 'TASK_RUN_ACTIVE', runId: active.id };
    }
    prompt = row.prompt;
    timeZone = row.timeZone;
    task = { id: row.id, revision: row.revision };
  } else {
    prompt = input.source.prompt;
  }

  const snapshot = snapshotRunConfig(config, timeZone);
  if (!snapshot) return refuse('RESEARCH_DISABLED', messages.researchDisabled);
  const denial = researchAdmissionDenial(user, snapshot.providerKind, config);
  if (denial) return refuse(denial, denialMessage(denial));

  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${ADMISSION_LOCK_KEY})`;
  const active = await tx.researchRun.count({ where: { state: { in: ['QUEUED', 'RUNNING'] } } });
  if (active >= config.RESEARCH_QUEUE_LIMIT) {
    return refuse('QUEUE_FULL', messages.queueFull(config.RESEARCH_QUEUE_LIMIT));
  }
  const userActive = await tx.researchRun.count({
    where: { userId: user.id, state: { in: ['QUEUED', 'RUNNING'] } },
  });
  if (userActive >= limits.activeRuns) {
    return refuse('USER_ACTIVE_LIMIT', messages.userActiveLimit(limits.activeRuns));
  }
  const { day, month } = periodsOf(input.now);
  const counted = {
    userId: user.id,
    admittedDay: day,
    // Runs cancelled before submission do not count against quotas.
    NOT: { state: 'CANCELLED' as const, submissionState: 'NOT_SUBMITTED' as const },
  };
  if ((await tx.researchRun.count({ where: counted })) >= limits.dailyRuns) {
    return refuse('DAILY_RUN_LIMIT', messages.dailyRunLimit(limits.dailyRuns));
  }
  // The manual-run quota applies to manual sources only (/research, Run now);
  // scheduled occurrences count against the total daily quota above.
  if (
    !scheduled &&
    (await tx.researchRun.count({ where: { ...counted, trigger: 'MANUAL' } })) >=
      limits.dailyManualRuns
  ) {
    return refuse('DAILY_MANUAL_LIMIT', messages.dailyManualLimit(limits.dailyManualRuns));
  }

  let policy: ReservationPolicy | null = null;
  if (snapshot.providerKind === 'openai') {
    // Fail-closed: no new live work while a billed request may still be unresolved.
    if (await hasUnresolvedLiveUncertainty(tx))
      return refuse('LIVE_BLOCKED_UNCERTAIN', messages.liveBlocked);
    const resolved = livePolicy(config);
    if (!resolved.ok)
      return refuse(`LIVE_ACCOUNTING_${resolved.problem}`, messages.liveAccountingNotConfigured);
    policy = resolved.policy;
    if (!(await registerPricing(tx, policy))) {
      return refuse(
        'LIVE_ACCOUNTING_PRICING_VERSION_CONFLICT',
        messages.liveAccountingNotConfigured,
      );
    }
    const reservation = BigInt(policy.reservedMicros);
    const [userExposure, globalExposure] = [
      await exposureMicros(tx, month, user.id),
      await exposureMicros(tx, month),
    ];
    if (userExposure + reservation > (limits.monthlyBudgetMicros ?? 0n)) {
      return refuse('USER_BUDGET_EXHAUSTED', messages.budgetExhausted('user', month));
    }
    if (globalExposure + reservation > (config.GLOBAL_MONTHLY_BUDGET_USD ?? 0n)) {
      return refuse('GLOBAL_BUDGET_EXHAUSTED', messages.budgetExhausted('global', month));
    }
  }

  const runId = randomUUID();
  await tx.researchRun.create({
    data: {
      id: runId,
      userId: user.id,
      requestedByTelegramUserId: user.telegramUserId,
      chatId,
      sourceUpdateId: input.updateId,
      occurrenceAt: scheduled?.occurrenceAt ?? null,
      prompt,
      providerKind: snapshot.providerKind,
      taskId: task?.id ?? null,
      taskRevision: task?.revision ?? null,
      trigger: scheduled ? 'SCHEDULED' : 'MANUAL',
      admittedDay: day,
      admittedMonth: month,
      requestSnapshot: {
        config: { ...snapshot },
        ...(task ? { task } : {}),
        ...(policy
          ? {
              accounting: {
                pricingVersion: policy.pricingVersion,
                policyVersion: policy.policyVersion,
                reservedMicros: policy.reservedMicros,
              },
            }
          : {}),
      },
    },
  });
  if (policy) await reserve(tx, { runId, userId: user.id, month, policy });
  await tx.outboxEvent.create({
    data: {
      operationKey: `${EXECUTE_EVENT}:${runId}`,
      type: EXECUTE_EVENT,
      runId,
      payload: { runId },
    },
  });
  // A scheduled run is not acknowledged: its report (or failure) is the message.
  await say(messages.accepted(runId, snapshot.providerKind === 'fake'), runId);
  return { disposition: 'RUN_ACCEPTED', reason: null, runId };
}
