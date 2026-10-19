import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import { createStatusDelivery } from '../delivery/delivery-records';
import { denialMessage, messages } from '../delivery/messages';
import type { AppUser } from '../generated/prisma/client';
import { researchAdmissionDenial } from '../identity/authorization';
import { snapshotRunConfig } from './request-builder';
import { hasUnresolvedLiveUncertainty } from './uncertainty';

/** Postgres advisory lock key serialising research admission (queue bound). */
const ADMISSION_LOCK_KEY = 20_020;

export interface AdmissionOutcome {
  disposition: 'RUN_ACCEPTED' | 'REPLIED' | 'REJECTED';
  reason: string | null;
  runId?: string;
}

/**
 * Admits one research run for the authenticated user, inside the inbox
 * transaction (the caller holds the user's row lock, so a concurrent
 * suspension is serialised with admission). Authorization is checked here as
 * well as by the caller: live research requires an administrator, and a
 * refused live request is never replaced by simulated research.
 */
export async function admitResearch(
  tx: Tx,
  config: Env,
  input: { user: AppUser; chatId: bigint; updateId: bigint; prompt: string },
): Promise<AdmissionOutcome> {
  const { user, chatId } = input;
  const snapshot = snapshotRunConfig(config, user.timeZone);
  if (!snapshot) {
    await createStatusDelivery(tx, chatId, messages.researchDisabled);
    return { disposition: 'REPLIED', reason: 'RESEARCH_DISABLED' };
  }
  const denial = researchAdmissionDenial(user, snapshot.providerKind, config);
  if (denial) {
    await createStatusDelivery(tx, chatId, denialMessage(denial));
    return { disposition: 'REJECTED', reason: denial };
  }

  // Serialised so the queue bound holds under concurrency.
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${ADMISSION_LOCK_KEY})`;
  const active = await tx.researchRun.count({ where: { state: { in: ['QUEUED', 'RUNNING'] } } });
  if (active >= config.RESEARCH_QUEUE_LIMIT) {
    await createStatusDelivery(tx, chatId, messages.queueFull(config.RESEARCH_QUEUE_LIMIT));
    return { disposition: 'REJECTED', reason: 'QUEUE_FULL' };
  }
  // Fail-closed: no new live work while a billed request may still be unresolved.
  // Best-effort here; the worker's claim statement is the authoritative gate.
  if (snapshot.providerKind === 'openai' && (await hasUnresolvedLiveUncertainty(tx))) {
    await createStatusDelivery(tx, chatId, messages.liveBlocked);
    return { disposition: 'REJECTED', reason: 'LIVE_BLOCKED_UNCERTAIN' };
  }

  const runId = randomUUID();
  await tx.researchRun.create({
    data: {
      id: runId,
      userId: user.id,
      requestedByTelegramUserId: user.telegramUserId,
      chatId,
      sourceUpdateId: input.updateId,
      prompt: input.prompt,
      providerKind: snapshot.providerKind,
      requestSnapshot: { config: { ...snapshot } },
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
