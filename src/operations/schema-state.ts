import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Migration state of the application schema (TRB-100, docs/OPERATIONS.md),
 * compared with the migrations shipped in this build (`prisma/migrations`,
 * copied into the image). Read-only: never applies, resolves or edits a
 * migration.
 */
export interface SchemaState {
  /** Shipped with this build but not successfully applied to the database. */
  pending: string[];
  /** Started and neither finished nor rolled back (a failed or interrupted migration). */
  failed: string[];
  /** Applied to the database but unknown to this build (the database is newer). */
  unknown: string[];
  applied: number;
  latestApplied: string | null;
  shipped: number;
}

interface Queryable {
  $queryRawUnsafe<T>(query: string): Promise<T>;
}

/** The migrations directory of this build: <app>/prisma/migrations, beside dist/ or src/. */
export const MIGRATIONS_DIR = resolve(__dirname, '..', '..', 'prisma', 'migrations');

const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/;

/** Names of the migrations shipped with this build, in order. Throws when the directory is missing. */
export function shippedMigrations(dir = MIGRATIONS_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && MIGRATION_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function readSchemaState(
  db: Queryable,
  shipped = shippedMigrations(),
): Promise<SchemaState> {
  const [table] = await db.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists`,
  );
  // A fresh database has no migrations table yet: everything is pending.
  const rows = table?.exists
    ? await db.$queryRawUnsafe<{ name: string; finished: boolean; rolledBack: boolean }[]>(
        `SELECT migration_name AS name, finished_at IS NOT NULL AS finished,
                rolled_back_at IS NOT NULL AS "rolledBack"
           FROM public._prisma_migrations ORDER BY migration_name`,
      )
    : [];
  const applied = new Set(rows.filter((r) => r.finished && !r.rolledBack).map((r) => r.name));
  const failed = [
    ...new Set(rows.filter((r) => !r.finished && !r.rolledBack).map((r) => r.name)),
  ].filter((name) => !applied.has(name));
  const known = new Set(shipped);
  const appliedNames = [...applied].sort();
  return {
    pending: shipped.filter((name) => !applied.has(name)),
    failed,
    unknown: appliedNames.filter((name) => !known.has(name)),
    applied: applied.size,
    latestApplied: appliedNames.at(-1) ?? null,
    shipped: shipped.length,
  };
}

/** Every shipped migration is applied and none has failed; a newer database is allowed (rollback). */
export function schemaReady(state: SchemaState): boolean {
  return state.pending.length === 0 && state.failed.length === 0;
}
