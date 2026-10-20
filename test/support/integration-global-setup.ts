import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { PgBoss } from 'pg-boss';
import type { TestProject } from 'vitest/node';
import { assertSafeTestServerUrl, disposableDatabaseName, withDatabase } from './test-database';

declare module 'vitest' {
  interface ProvidedContext {
    databaseUrl: string;
  }
}

/** Creates a fresh database, applies Prisma migrations, and drops it after the run. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  try {
    process.loadEnvFile();
  } catch {
    // .env is optional; CI sets variables directly.
  }
  const serverUrl = assertSafeTestServerUrl(process.env['TEST_DATABASE_URL'], process.env);
  const database = disposableDatabaseName();
  const databaseUrl = withDatabase(serverUrl, database);

  await withAdminClient(serverUrl, (client) => client.query(`CREATE DATABASE "${database}"`));

  const migrate = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    { env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8' },
  );
  if (migrate.status !== 0) {
    await dropDatabase(serverUrl, database);
    throw new Error(`prisma migrate deploy failed:\n${migrate.stdout}\n${migrate.stderr}`);
  }

  // pg-boss installs its own schema, as the application does at startup (docs/QUEUE.md).
  const boss = new PgBoss({ connectionString: databaseUrl, supervise: false, schedule: false });
  boss.on('error', () => undefined);
  try {
    await boss.start();
  } finally {
    await boss.stop({ graceful: false });
  }

  project.provide('databaseUrl', databaseUrl);
  return () => dropDatabase(serverUrl, database);
}

async function dropDatabase(serverUrl: URL, database: string): Promise<void> {
  await withAdminClient(serverUrl, (client) =>
    client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`),
  );
}

async function withAdminClient(
  serverUrl: URL,
  action: (client: Client) => Promise<unknown>,
): Promise<void> {
  const client = new Client({ connectionString: withDatabase(serverUrl, 'postgres') });
  await client.connect();
  try {
    await action(client);
  } finally {
    await client.end();
  }
}
