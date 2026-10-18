import { describe, expect, it } from 'vitest';
import { assertSafeTestServerUrl, disposableDatabaseName, withDatabase } from './test-database';

describe('assertSafeTestServerUrl', () => {
  const local = 'postgresql://trb:trb@localhost:5433/postgres';

  it('accepts a loopback test server', () => {
    expect(assertSafeTestServerUrl(local, {}).port).toBe('5433');
  });

  it('refuses to run without TEST_DATABASE_URL', () => {
    expect(() => assertSafeTestServerUrl(undefined, {})).toThrow(/TEST_DATABASE_URL is not set/);
  });

  it('refuses a remote host unless explicitly allowed', () => {
    const remote = 'postgresql://u:p@db.example.com:5432/postgres';
    expect(() => assertSafeTestServerUrl(remote, {})).toThrow(/loopback/);
    expect(() =>
      assertSafeTestServerUrl(remote, { TEST_DATABASE_ALLOW_NON_LOCAL: 'true' }),
    ).not.toThrow();
  });

  it('refuses the server used by DATABASE_URL', () => {
    expect(() =>
      assertSafeTestServerUrl('postgresql://u:p@localhost/postgres', {
        DATABASE_URL: 'postgresql://u:p@localhost:5432/trb_dev',
      }),
    ).toThrow(/same server/);
  });
});

describe('disposable database naming', () => {
  it('creates distinct names and replaces only the database path', () => {
    expect(disposableDatabaseName()).not.toBe(disposableDatabaseName());
    expect(withDatabase(new URL('postgresql://u:p@localhost:5433/postgres?x=1'), 'trb_it_1')).toBe(
      'postgresql://u:p@localhost:5433/trb_it_1?x=1',
    );
  });
});
