import type { PrismaService } from '../database/prisma.service';

/**
 * Durable execution hold (TRB-100, docs/OPERATIONS.md, "Restore"). While the
 * single `operational_hold` row exists, an application process starts no
 * ingress processing, scheduler, dispatcher, worker, polling or retention
 * pass. It is set by the operator on a restored or suspect database before any
 * application process connects to it, and cleared only after reconciliation.
 * Stored in the database itself, so it applies to every process and every
 * deployment that uses this database, whatever their environment says.
 */
export interface Hold {
  reason: string;
  setBy: string;
  createdAt: Date;
}

const HOLD_ID = 'execution';

type Db = Pick<PrismaService, 'operationalHold'>;

export async function readHold(db: Db): Promise<Hold | null> {
  const row = await db.operationalHold.findUnique({ where: { id: HOLD_ID } });
  return row ? { reason: row.reason, setBy: row.setBy, createdAt: row.createdAt } : null;
}

/** Idempotent: an existing hold is kept unchanged. Returns whether this call created it. */
export async function setHold(
  db: Db,
  input: { reason: string; setBy: string },
): Promise<{ created: boolean; hold: Hold }> {
  const existing = await readHold(db);
  if (existing) return { created: false, hold: existing };
  try {
    const row = await db.operationalHold.create({
      data: { id: HOLD_ID, reason: input.reason, setBy: input.setBy },
    });
    return {
      created: true,
      hold: { reason: row.reason, setBy: row.setBy, createdAt: row.createdAt },
    };
  } catch (error) {
    const concurrent = await readHold(db);
    if (concurrent) return { created: false, hold: concurrent };
    throw error;
  }
}

/** Removes the hold. Returns false when there was none. */
export async function clearHold(db: Db): Promise<boolean> {
  const { count } = await db.operationalHold.deleteMany({ where: { id: HOLD_ID } });
  return count > 0;
}
