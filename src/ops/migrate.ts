import 'reflect-metadata';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PgBoss } from 'pg-boss';
import { ConfigValidationError } from '../config/env.schema';
import { loadConfig } from '../config/load-config';
import { PrismaService } from '../database/prisma.service';
import { readSchemaState, schemaReady } from '../operations/schema-state';

/**
 * Deployment migration step (TRB-100, docs/OPERATIONS.md). Railway runs it as
 * the pre-deploy command, in a separate container of the new image, before the
 * new deployment starts:
 *   node dist/ops/migrate.js
 * 1. validates the full configuration (an invalid one fails the deployment
 *    before the schema changes);
 * 2. applies pending Prisma migrations with `prisma migrate deploy` only
 *    (never migrate dev, db push, reset or resolve);
 * 3. installs or upgrades the pg-boss schema (QUEUE_SCHEMA) under pg-boss's
 *    own advisory lock, without starting workers or maintenance;
 * 4. verifies that every shipped migration is applied.
 * Exits non-zero on any failure, which stops the deployment. Prints no
 * connection string or secret (Prisma prints the database host and name).
 */
async function main(): Promise<number> {
  const config = loadConfig();

  process.stdout.write('[migrate] prisma migrate deploy\n');
  const prismaCli = resolve(require.resolve('prisma/package.json'), '..', 'build', 'index.js');
  // The application root (prisma.config.ts, prisma/), whatever the current directory is.
  const appRoot = resolve(__dirname, '..', '..');
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: process.env,
    cwd: appRoot,
  });
  if (result.status !== 0) {
    process.stderr.write(`[migrate] prisma migrate deploy failed (exit ${result.status})\n`);
    return 1;
  }

  process.stdout.write(`[migrate] pg-boss schema "${config.QUEUE_SCHEMA}"\n`);
  const boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    schema: config.QUEUE_SCHEMA,
    application_name: 'trb-migrate',
    max: 1,
    connectionTimeoutMillis: config.DATABASE_CONNECT_TIMEOUT_MS,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
    registerInstance: false,
    openTelemetry: { enabled: false },
  });
  boss.on('error', () => undefined);
  await boss.start();
  await boss.stop({ graceful: false });

  const prisma = new PrismaService(config);
  try {
    const state = await readSchemaState(prisma);
    const [queue] = await prisma.$queryRawUnsafe<{ version: number }[]>(
      `SELECT version FROM "${config.QUEUE_SCHEMA}".version`,
    );
    process.stdout.write(
      `[migrate] ${JSON.stringify({ ...state, queueSchemaVersion: queue?.version ?? null })}\n`,
    );
    if (!schemaReady(state)) {
      process.stderr.write('[migrate] schema incomplete after migrate deploy\n');
      return 1;
    }
    return 0;
  } finally {
    await prisma.onApplicationShutdown();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (error instanceof ConfigValidationError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      // Error messages can contain connection details; print the class and code only.
      const code = (error as { code?: unknown }).code;
      process.stderr.write(
        `[migrate] failed: ${error instanceof Error ? error.name : 'unknown error'}${typeof code === 'string' ? ` (${code})` : ''}\n`,
      );
    }
    process.exit(1);
  },
);
