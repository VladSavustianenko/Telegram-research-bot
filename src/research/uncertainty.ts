import type { Tx } from '../database/prisma-errors';
import type { PrismaService } from '../database/prisma.service';

/**
 * Fail-closed policy (TRB-020 prototype): while a live (provider_kind
 * "openai") run is UNCERTAIN and not reconciled by an operator, a billed
 * provider request may still be active. No new live work is admitted or
 * submitted until reconciliation. Simulated (fake) uncertainty never blocks.
 *
 * The SQL fragment is duplicated in the worker's claim statement, which is
 * the concurrency-safe enforcement point; this helper serves admission UX and
 * defence-in-depth checks.
 */
export async function hasUnresolvedLiveUncertainty(client: Tx | PrismaService): Promise<boolean> {
  const rows = await client.$queryRaw<{ blocked: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM research_run
       WHERE state = 'UNCERTAIN' AND provider_kind = 'openai' AND reconciled_at IS NULL
    ) AS blocked`;
  return rows[0]?.blocked === true;
}
