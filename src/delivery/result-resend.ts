import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import type { AppUser } from '../generated/prisma/client';
import { userOperationDenial } from '../identity/authorization';
import { createDelivery, createStatusDelivery } from './delivery-records';
import { denialMessage, messages } from './messages';

/**
 * Explicit resend of a stored result (`/result <id>`). Never starts research.
 * The lookup is scoped to the authenticated user's own runs, so a foreign and
 * a nonexistent run ID get the same answer and create no RESEND delivery.
 */
export async function requestResultResend(
  tx: Tx,
  config: Env,
  input: { user: AppUser; runId: string; chatId: bigint },
): Promise<{
  disposition: 'RESULT_REQUESTED' | 'REJECTED';
  reason: string | null;
  runId?: string;
}> {
  const { user, runId, chatId } = input;
  const denial = userOperationDenial(user, config);
  if (denial) {
    await createStatusDelivery(tx, chatId, denialMessage(denial));
    return { disposition: 'REJECTED', reason: denial };
  }
  const run = await tx.researchRun.findFirst({
    where: { id: runId, userId: user.id },
    select: { id: true, state: true, failureCode: true, providerKind: true, reconciledAt: true },
  });
  if (!run) {
    await createStatusDelivery(tx, chatId, messages.runNotFound);
    return { disposition: 'RESULT_REQUESTED', reason: 'RUN_NOT_FOUND' };
  }
  if (run.state !== 'SUCCEEDED') {
    const code = run.failureCode ?? 'UNKNOWN';
    const text =
      run.state === 'QUEUED'
        ? messages.runQueued(run.id)
        : run.state === 'RUNNING'
          ? messages.runRunning(run.id)
          : run.state === 'CANCELLED'
            ? messages.runCancelled(run.id, code)
            : run.state === 'UNCERTAIN'
              ? run.reconciledAt
                ? messages.runUncertainReconciled(run.id, code)
                : messages.runUncertain(run.id, code, run.providerKind === 'fake')
              : messages.runFailed(run.id, code);
    await createStatusDelivery(tx, chatId, text, run.id);
    return { disposition: 'RESULT_REQUESTED', reason: `RUN_${run.state}`, runId: run.id };
  }
  const report = await tx.delivery.findFirst({
    where: { runId: run.id, kind: 'REPORT' },
    select: { parts: { orderBy: { ordinal: 'asc' }, select: { html: true } } },
  });
  if (!report) throw new Error('succeeded run without report delivery');
  await createDelivery(tx, {
    kind: 'RESEND',
    chatId,
    runId: run.id,
    parts: report.parts.map((part) => part.html),
  });
  return { disposition: 'RESULT_REQUESTED', reason: null, runId: run.id };
}
