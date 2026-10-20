import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import type { AppUser, Prisma } from '../generated/prisma/client';
import { userOperationDenial } from '../identity/authorization';
import { createDelivery, createStatusDelivery, type DeliveryPartInput } from './delivery-records';
import { denialMessage, messages } from './messages';

/** Runs the user may see: their own, excluding runs of deleted tasks (hidden from navigation). */
export const visibleRunsOf = (userId: string): Prisma.ResearchRunWhereInput => ({
  userId,
  OR: [{ taskId: null }, { task: { state: { not: 'DELETED' } } }],
});

/**
 * Explicit resend of a stored result (`/result <id>` and the history button).
 * Never starts research and never touches the run, its accounting or its
 * earlier deliveries: it creates a new RESEND delivery whose parts are copies
 * of the stored report parts (messages and the full-text document).
 * The lookup is scoped to the authenticated user's visible runs, so a foreign,
 * nonexistent or deleted-task run ID gets the same answer and creates no
 * RESEND delivery. When the automatic delivery's outcome is UNKNOWN, a notice
 * first says that the earlier message may already have arrived.
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
    where: { id: runId, ...visibleRunsOf(user.id) },
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
    select: {
      state: true,
      parts: {
        orderBy: { ordinal: 'asc' },
        select: { kind: true, html: true, fileName: true, fileContent: true },
      },
    },
  });
  if (!report) throw new Error('succeeded run without report delivery');
  if (report.state === 'UNKNOWN') {
    await createStatusDelivery(tx, chatId, messages.resendAfterUnknown(run.id), run.id);
  }
  await createDelivery(tx, {
    kind: 'RESEND',
    chatId,
    runId: run.id,
    parts: report.parts.map((part): DeliveryPartInput =>
      part.kind === 'DOCUMENT'
        ? {
            kind: 'DOCUMENT',
            html: part.html,
            fileName: part.fileName ?? '',
            fileContent: part.fileContent ?? '',
          }
        : { html: part.html },
    ),
  });
  return { disposition: 'RESULT_REQUESTED', reason: null, runId: run.id };
}
