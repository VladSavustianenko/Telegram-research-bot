import { randomBytes } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

const DEFAULT_POSTGRES_PORT = 5432;

/**
 * Query parameters that the pg connection-string parser (or libpq-style
 * parsers such as Prisma's schema engine) use to override the endpoint in the
 * URL authority. URLs containing them are rejected so that the validated host
 * and port are the ones the driver actually connects to.
 */
const ENDPOINT_OVERRIDE_PARAMS = new Set(['host', 'hostaddr', 'port', 'service', 'servicefile']);

export interface DatabaseEndpoint {
  /** Canonical host name or IP address (no brackets, lower case). */
  host: string;
  /** Ports the driver may connect to: the URL port, or the defaults when it is omitted. */
  ports: readonly number[];
  loopback: boolean;
}

export interface ParsedDatabaseUrl {
  /** URL with an explicit port, used for every test connection. */
  url: URL;
  endpoint: DatabaseEndpoint;
}

/**
 * Parses a PostgreSQL URL under a strict policy and returns the effective
 * endpoint. Errors name the variable only and never include the URL, which may
 * contain credentials.
 */
export function parseDatabaseUrl(
  rawUrl: string,
  name: string,
  env: NodeJS.ProcessEnv,
): ParsedDatabaseUrl {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${name} must be a postgres:// URL`);
  }
  for (const key of url.searchParams.keys()) {
    if (ENDPOINT_OVERRIDE_PARAMS.has(key.toLowerCase())) {
      throw new Error(
        `${name} must not set the "${key}" query parameter; put the host and port in the URL authority`,
      );
    }
  }
  const host = canonicalHost(url.hostname, name);

  // pg uses the URL port, then PGPORT, then 5432. Without an explicit port the
  // endpoint is ambiguous, so every candidate is considered.
  const ports = url.port
    ? [Number(url.port)]
    : [...new Set([DEFAULT_POSTGRES_PORT, ...pgPortFromEnv(env)])];
  const normalized = new URL(url.toString());
  normalized.port = String(url.port ? Number(url.port) : DEFAULT_POSTGRES_PORT);

  return { url: normalized, endpoint: { host, ports, loopback: isLoopback(host) } };
}

/**
 * Validates TEST_DATABASE_URL before destructive test setup. The server must be
 * loopback unless TEST_DATABASE_ALLOW_NON_LOCAL=true, and must never be (or
 * possibly be) the server used by DATABASE_URL. Returns the URL with an
 * explicit port, which callers must use for all connections.
 */
export function assertSafeTestServerUrl(rawUrl: string | undefined, env: NodeJS.ProcessEnv): URL {
  if (!rawUrl) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start the disposable test database (npm run db:up) ' +
        'and set TEST_DATABASE_URL, see .env.example.',
    );
  }
  const test = parseDatabaseUrl(rawUrl, 'TEST_DATABASE_URL', env);
  // Test connections always use the explicit port, so only that one matters.
  const testEndpoint = { ...test.endpoint, ports: [Number(test.url.port)] };

  if (!testEndpoint.loopback && env['TEST_DATABASE_ALLOW_NON_LOCAL'] !== 'true') {
    throw new Error(
      'TEST_DATABASE_URL must point at a loopback host. Set TEST_DATABASE_ALLOW_NON_LOCAL=true ' +
        'only for a dedicated disposable test server.',
    );
  }
  const appUrl = env['DATABASE_URL'];
  if (appUrl) {
    const app = parseDatabaseUrl(appUrl, 'DATABASE_URL', env);
    if (mayBeSameServer(testEndpoint, app.endpoint)) {
      throw new Error('TEST_DATABASE_URL must not point at the same server as DATABASE_URL');
    }
  }
  return test.url;
}

/**
 * Conservative comparison: endpoints may be the same server when a port
 * matches and the hosts are equal or both are loopback aliases. Different DNS
 * names that resolve to the same remote server are not detected.
 */
export function mayBeSameServer(a: DatabaseEndpoint, b: DatabaseEndpoint): boolean {
  const portOverlap = a.ports.some((port) => b.ports.includes(port));
  return portOverlap && (a.host === b.host || (a.loopback && b.loopback));
}

function pgPortFromEnv(env: NodeJS.ProcessEnv): number[] {
  const port = Number(env['PGPORT']);
  return Number.isInteger(port) && port > 0 ? [port] : [];
}

/** Canonicalises a host the way pg passes it to the resolver (percent-decoded, WHATWG IP forms). */
function canonicalHost(rawHostname: string, name: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawHostname.replace(/^\[(.*)\]$/, '$1')).toLowerCase();
  } catch {
    throw new Error(`${name} has an invalid host`);
  }
  if (!decoded) {
    // pg would fall back to PGHOST or localhost.
    throw new Error(`${name} must include an explicit host`);
  }
  if (decoded.includes('/')) {
    // pg treats a host starting with "/" as a Unix socket directory.
    throw new Error(`${name} must use a TCP host, not a Unix socket`);
  }
  try {
    // The http parser canonicalises IPv4 shorthand (127.1, 0x7f.0.0.1) and IPv6 forms.
    const host = new URL(`http://${isIPv6(decoded) ? `[${decoded}]` : decoded}`).hostname;
    // A trailing dot names the same DNS host ("localhost." is localhost).
    return host.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  } catch {
    throw new Error(`${name} has an invalid host`);
  }
}

function isLoopback(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIPv4(host)) return host.startsWith('127.') || host === '0.0.0.0';
  if (isIPv6(host)) {
    if (host === '::1' || host === '::') return true;
    // IPv4-mapped addresses, canonicalised as ::ffff:7f00:1 for 127.0.0.1.
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mapped) {
      const high = parseInt(mapped[1] ?? '', 16);
      const low = parseInt(mapped[2] ?? '', 16);
      return high >> 8 === 127 || (high === 0 && low === 0);
    }
  }
  return false;
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
