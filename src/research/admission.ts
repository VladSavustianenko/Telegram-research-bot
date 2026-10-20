import { randomUUID } from 'node:crypto';
import { exposureMicros, registerPricing, reserve } from '../accounting/ledger';
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
}

export type AdmissionSource =
  { kind: 'prompt'; prompt: string } | { kind: 'task'; taskId: string; revision: number };

/**
 * The single admission path for research (`/research` and a task's "Run now"),
 * inside the inbox transaction. Lock order: sender identity lock and user row
 * (taken by the caller) → task row → global admission lock. Under them it:
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
 */
export async function admitResearch(
  tx: Tx,
  config: Env,
  input: { user: AppUser; chatId: bigint; updateId: bigint; now: Date; source: AdmissionSource },
): Promise<AdmissionOutcome> {
  const { user, chatId } = input;
  const refuse = async (reason: string, text: string): Promise<AdmissionOutcome> => {
    await createStatusDelivery(tx, chatId, text);
    return { disposition: 'REJECTED', reason };
  };

  // The task (if any) supplies the prompt and zone, read under its row lock.
  let prompt: string;
  let timeZone: string | null = user.timeZone;
  let task: { id: string; revision: number } | null = null;
  if (input.source.kind === 'task') {
    const rows = await tx.$queryRaw<
      { id: string; revision: number; prompt: string; timeZone: string }[]
    >`
      SELECT id, revision, prompt, time_zone AS "timeZone" FROM task
       WHERE id = ${input.source.taskId}::uuid AND user_id = ${user.id}::uuid AND state <> 'DELETED'
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
      await createStatusDelivery(
        tx,
        chatId,
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
  if (userActive >= config.USER_ACTIVE_RUN_LIMIT) {
    return refuse('USER_ACTIVE_LIMIT', messages.userActiveLimit(config.USER_ACTIVE_RUN_LIMIT));
  }
  const { day, month } = periodsOf(input.now);
  const counted = {
    userId: user.id,
    admittedDay: day,
    // Runs cancelled before submission do not count against quotas.
    NOT: { state: 'CANCELLED' as const, submissionState: 'NOT_SUBMITTED' as const },
  };
  if ((await tx.researchRun.count({ where: counted })) >= config.USER_DAILY_RUN_LIMIT) {
    return refuse('DAILY_RUN_LIMIT', messages.dailyRunLimit(config.USER_DAILY_RUN_LIMIT));
  }
  if (
    (await tx.researchRun.count({ where: { ...counted, trigger: 'MANUAL' } })) >=
    config.USER_DAILY_MANUAL_RUN_LIMIT
  ) {
    return refuse(
      'DAILY_MANUAL_LIMIT',
      messages.dailyManualLimit(config.USER_DAILY_MANUAL_RUN_LIMIT),
    );
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
    if (userExposure + reservation > (config.USER_MONTHLY_BUDGET_USD ?? 0n)) {
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
      prompt,
      providerKind: snapshot.providerKind,
      taskId: task?.id ?? null,
      taskRevision: task?.revision ?? null,
      trigger: 'MANUAL',
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
  await createStatusDelivery(
    tx,
    chatId,
    messages.accepted(runId, snapshot.providerKind === 'fake'),
    runId,
  );
  return { disposition: 'RUN_ACCEPTED', reason: null, runId };
}
