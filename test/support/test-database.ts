import { randomBytes } from 'node:crypto';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Guards against running destructive test setup against a non-test server.
 * TEST_DATABASE_URL must point at a disposable server (docker compose
 * `postgres-test` or the CI service). Non-loopback hosts need an explicit opt-in.
 */
export function assertSafeTestServerUrl(rawUrl: string | undefined, env: NodeJS.ProcessEnv): URL {
  if (!rawUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start the disposable test database (npm run db:up) ' +
        'and set TEST_DATABASE_URL, see .env.example.',
    );
  }
  const url = new URL(rawUrl);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('TEST_DATABASE_URL must be a postgres:// URL');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) && env['TEST_DATABASE_ALLOW_NON_LOCAL'] !== 'true') {
    throw new Error(
      'TEST_DATABASE_URL must point at a loopback host. Set TEST_DATABASE_ALLOW_NON_LOCAL=true ' +
        'only for a dedicated disposable test server.',
    );
  }
  const appUrl = env['DATABASE_URL'];
  if (appUrl && sameServer(new URL(appUrl), url)) {
    throw new Error('TEST_DATABASE_URL must not point at the same server as DATABASE_URL');
  }
  return url;
}

function sameServer(a: URL, b: URL): boolean {
  return a.hostname === b.hostname && (a.port || '5432') === (b.port || '5432');
}

/** Unique, recognisable name for one test run's database. */
export function disposableDatabaseName(): string {
  return `trb_it_${Date.now()}_${randomBytes(4).toString('hex')}`;
}

export function withDatabase(serverUrl: URL, database: string): string {
  const url = new URL(serverUrl.toString());
  url.pathname = `/${database}`;
  return url.toString();
}
