import type { PrismaService } from '../database/prisma.service';
import { wakeQueuedRuns } from './wake';

export const RESOLUTIONS = [
  'PROVIDER_CONFIRMED_TERMINAL',
  'PROVIDER_REQUEST_ABSENT',
  'OPERATOR_ACCEPTED_RISK',
] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export interface ReconcileInput {
  runId: string;
  operator: string;
  resolution: Resolution;
  note: string;
}

export class ReconciliationError extends Error {
  constructor(readonly code: string) {
    super(`Reconciliation refused: ${code}`);
    this.name = 'ReconciliationError';
  }
}

export interface UnresolvedRun {
  id: string;
  providerKind: string;
  failureCode: string | null;
  providerResponseId: string | null;
  providerStatus: string | null;
  submittedAt: Date | null;
  completedAt: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** UNCERTAIN runs not yet reconciled (live ones block live work). Read-only. */
export function listUnresolved(prisma: PrismaService): Promise<UnresolvedRun[]> {
  return prisma.researchRun.findMany({
    where: { state: 'UNCERTAIN', reconciledAt: null },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      providerKind: true,
      failureCode: true,
      providerResponseId: true,
      providerStatus: true,
      submittedAt: true,
      completedAt: true,
    },
  });
}

/**
 * Records an operator's decision about an UNCERTAIN run and lifts the
 * fail-closed block it causes. It only appends an audit row and sets
 * reconciled_at: the run stays UNCERTAIN with its failure code, response ID and
 * usage, and is never resubmitted. Workers cannot call this, and a stale worker
 * cannot alter the run afterwards (its fenced writes require state RUNNING).
 * Queued runs are woken in the same transaction, so live work that waited for
 * the block to lift is inspected at once.
 */
export async function reconcileUncertainRun(
  prisma: PrismaService,
  input: ReconcileInput,
): Promise<{ runId: string; reconciliationId: string }> {
  if (!UUID.test(input.runId)) throw new ReconciliationError('INVALID_RUN_ID');
  if (!RESOLUTIONS.includes(input.resolution)) throw new ReconciliationError('INVALID_RESOLUTION');
  const operator = input.operator.trim();
  const note = input.note.trim();
  if (!operator || operator.length > 100) throw new ReconciliationError('INVALID_OPERATOR');
  if (!note || note.length > 2_000) throw new ReconciliationError('INVALID_NOTE');

  return prisma.$transaction(async (tx) => {
    const [run] = await tx.$queryRaw<
      {
        id: string;
        state: string;
        provider_kind: string;
        reconciled_at: Date | null;
        failure_code: string | null;
        submission_state: string;
        provider_response_id: string | null;
        provider_status: string | null;
        usage: unknown;
        submitted_at: Date | null;
        completed_at: Date | null;
      }[]
    >`SELECT id, state, provider_kind, reconciled_at, failure_code, submission_state,
             provider_response_id, provider_status, usage, submitted_at, completed_at
        FROM research_run WHERE id = ${input.runId}::uuid FOR UPDATE`;
    if (!run) throw new ReconciliationError('RUN_NOT_FOUND');
    if (run.state !== 'UNCERTAIN') throw new ReconciliationError(`RUN_NOT_UNCERTAIN:${run.state}`);
    if (run.reconciled_at) throw new ReconciliationError('ALREADY_RECONCILED');

    const evidence = {
      providerKind: run.provider_kind,
      failureCode: run.failure_code,
      submissionState: run.submission_state,
      providerResponseId: run.provider_response_id,
      providerStatus: run.provider_status,
      usage: run.usage ?? null,
      submittedAt: run.submitted_at?.toISOString() ?? null,
      completedAt: run.completed_at?.toISOString() ?? null,
    };
    const record = await tx.researchReconciliation.create({
      data: {
        runId: run.id,
        operator,
        resolution: input.resolution,
        note,
        evidence: evidence,
      },
      select: { id: true },
    });
    const updated = await tx.researchRun.updateMany({
      where: { id: run.id, state: 'UNCERTAIN', reconciledAt: null },
      data: { reconciledAt: new Date() },
    });
    if (updated.count !== 1) throw new ReconciliationError('CONCURRENT_CHANGE');
    await wakeQueuedRuns(tx, 'RECONCILED');
    return { runId: run.id, reconciliationId: record.id };
  });
}
