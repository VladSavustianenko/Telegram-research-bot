import { parse as parsePgConnectionString } from 'pg-connection-string';
import { describe, expect, it } from 'vitest';
import {
  assertSafeTestServerUrl,
  disposableDatabaseName,
  mayBeSameServer,
  parseDatabaseUrl,
  withDatabase,
} from './test-database';

// Pure validation: none of these tests opens a connection.

const devAppUrl = 'postgresql://trb:trb@localhost:5434/trb_dev';
const localTestUrl = 'postgresql://trb:trb@localhost:5433/postgres';

function errorOf(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected an error');
}

describe('assertSafeTestServerUrl', () => {
  it('accepts separate local dev and test ports', () => {
    const url = assertSafeTestServerUrl(localTestUrl, { DATABASE_URL: devAppUrl });
    expect(url.hostname).toBe('localhost');
    expect(url.port).toBe('5433');
  });

  it('refuses to run without TEST_DATABASE_URL', () => {
    expect(() => assertSafeTestServerUrl(undefined, {})).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it.each([
    ['host', 'postgresql://u:p@localhost:5433/postgres?host=remote.example.com&port=5432'],
    ['host only', 'postgresql://u:p@localhost:5433/postgres?host=remote.example.com'],
    ['port only', 'postgresql://u:p@localhost:5433/postgres?port=5434'],
    ['upper-case key', 'postgresql://u:p@localhost:5433/postgres?HOST=remote.example.com'],
    ['percent-encoded key', 'postgresql://u:p@localhost:5433/postgres?ho%73t=remote.example.com'],
    ['hostaddr', 'postgresql://u:p@localhost:5433/postgres?hostaddr=203.0.113.10'],
  ])('rejects endpoint-overriding query parameters (%s)', (_case, url) => {
    expect(() => assertSafeTestServerUrl(url, {})).toThrow(/must not set the ".+" query parameter/);
  });

  it('demonstrates why overrides are rejected: pg would connect elsewhere', () => {
    const parsed = parsePgConnectionString(
      'postgresql://u:p@localhost:5433/postgres?host=remote.example.com&port=5432',
    );
    expect(parsed).toMatchObject({ host: 'remote.example.com', port: '5432' });
  });

  it.each([
    [
      'localhost / 127.0.0.1',
      'postgresql://u:p@127.0.0.1:5433/postgres',
      'postgresql://u:p@localhost:5433/app',
    ],
    [
      'localhost / ::1',
      'postgresql://u:p@[::1]:5433/postgres',
      'postgresql://u:p@localhost:5433/app',
    ],
    [
      '127.0.0.1 / 127.0.0.2',
      'postgresql://u:p@127.0.0.2:5433/postgres',
      'postgresql://u:p@127.0.0.1:5433/app',
    ],
    [
      'IPv4 shorthand',
      'postgresql://u:p@127.1:5433/postgres',
      'postgresql://u:p@localhost:5433/app',
    ],
    [
      'IPv4-mapped IPv6',
      'postgresql://u:p@[::ffff:127.0.0.1]:5433/postgres',
      'postgresql://u:p@localhost:5433/app',
    ],
    [
      'upper case + trailing dot',
      'postgresql://u:p@LOCALHOST.:5433/postgres',
      'postgresql://u:p@localhost:5433/app',
    ],
    [
      'percent-encoded host',
      'postgresql://u:p@%6cocalhost:5433/postgres',
      'postgresql://u:p@localhost:5433/app',
    ],
  ])(
    'treats loopback aliases on the same port as the application server (%s)',
    (_case, test, app) => {
      expect(() => assertSafeTestServerUrl(test, { DATABASE_URL: app })).toThrow(/same server/);
    },
  );

  it('normalises an omitted port to 5432 on both sides', () => {
    expect(() =>
      assertSafeTestServerUrl('postgresql://u:p@localhost/postgres', {
        DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/app',
      }),
    ).toThrow(/same server/);
    expect(() =>
      assertSafeTestServerUrl('postgresql://u:p@localhost:5432/postgres', {
        DATABASE_URL: 'postgresql://u:p@localhost/app',
      }),
    ).toThrow(/same server/);
    const url = assertSafeTestServerUrl('postgresql://u:p@localhost/postgres', {
      DATABASE_URL: devAppUrl,
    });
    expect(url.port).toBe('5432');
  });

  it('treats an application URL without a port as possibly using PGPORT', () => {
    expect(() =>
      assertSafeTestServerUrl(localTestUrl, {
        DATABASE_URL: 'postgresql://u:p@localhost/app',
        PGPORT: '5433',
      }),
    ).toThrow(/same server/);
  });

  it('rejects a remote host unless explicitly allowed', () => {
    const remote = 'postgresql://u:p@db.example.com:5432/postgres';
    expect(() => assertSafeTestServerUrl(remote, {})).toThrow(/loopback/);
    expect(() =>
      assertSafeTestServerUrl(remote, { TEST_DATABASE_ALLOW_NON_LOCAL: 'true' }),
    ).not.toThrow();
  });

  it('keeps the application-server exclusion when a non-local test server is allowed', () => {
    expect(() =>
      assertSafeTestServerUrl('postgresql://u:p@DB.example.com/postgres', {
        TEST_DATABASE_ALLOW_NON_LOCAL: 'true',
        DATABASE_URL: 'postgresql://u:p@db.example.com:5432/app',
      }),
    ).toThrow(/same server/);
  });

  it('applies the same override policy to DATABASE_URL', () => {
    expect(() =>
      assertSafeTestServerUrl(localTestUrl, {
        DATABASE_URL: 'postgresql://u:p@localhost:5434/app?host=localhost&port=5433',
      }),
    ).toThrow(/DATABASE_URL must not set the "host" query parameter/);
  });

  it.each([
    ['Unix socket host', 'postgresql://u:p@%2Fvar%2Frun%2Fpostgresql:5433/postgres'],
    ['empty host', 'postgresql://u:p@/postgres'],
    ['wrong scheme', 'mysql://u:p@localhost:5433/postgres'],
    ['not a URL', 'u:p@localhost:5433'],
  ])('rejects %s', (_case, url) => {
    expect(() => assertSafeTestServerUrl(url, {})).toThrow(/TEST_DATABASE_URL/);
  });

  it('keeps credentials out of validation errors', () => {
    const secret = 'S3cr3t-pa55';
    const messages = [
      errorOf(() =>
        assertSafeTestServerUrl(`postgresql://u:${secret}@localhost:5433/db?host=x`, {}),
      ),
      errorOf(() => assertSafeTestServerUrl(`postgresql://u:${secret}@db.example.com/db`, {})),
      errorOf(() =>
        assertSafeTestServerUrl(`postgresql://u:${secret}@localhost:5433/db`, {
          DATABASE_URL: `postgresql://u:${secret}@127.0.0.1:5433/app`,
        }),
      ),
      errorOf(() => assertSafeTestServerUrl(`postgresql://u:${secret}@[::1/db`, {})),
    ].map((error) => error.message);
    for (const message of messages) {
      expect(message).not.toContain(secret);
    }
  });
});

describe('parseDatabaseUrl', () => {
  it.each([
    'postgresql://u:p@localhost:5433/postgres',
    'postgresql://u:p@127.0.0.1:5433/postgres?sslmode=disable',
    'postgres://u:p@[::1]:6543/db',
    'postgresql://u:p@db.example.com/db',
  ])('agrees with the pg parser on the endpoint of %s', (raw) => {
    const { url, endpoint } = parseDatabaseUrl(raw, 'URL', {});
    const pg = parsePgConnectionString(url.toString());
    expect(pg.host).toBe(endpoint.host);
    expect(Number(pg.port)).toBe(endpoint.ports[0]);
  });
});

describe('mayBeSameServer', () => {
  it('distinguishes different ports and different remote hosts', () => {
    const local = { host: 'localhost', ports: [5433], loopback: true };
    expect(mayBeSameServer(local, { host: '127.0.0.1', ports: [5434], loopback: true })).toBe(
      false,
    );
    expect(
      mayBeSameServer(
        { host: 'a.example.com', ports: [5432], loopback: false },
        { host: 'b.example.com', ports: [5432], loopback: false },
      ),
    ).toBe(false);
  });
});

describe('disposable database naming', () => {
  it('creates distinct names and replaces only the database path', () => {
    const names = new Set(Array.from({ length: 50 }, () => disposableDatabaseName()));
    expect(names.size).toBe(50);
    for (const name of names) expect(name).toMatch(/^trb_it_\d+_[0-9a-f]{8}$/);
    expect(withDatabase(new URL('postgresql://u:p@localhost:5433/postgres?x=1'), 'trb_it_1')).toBe(
      'postgresql://u:p@localhost:5433/trb_it_1?x=1',
    );
  });
});
