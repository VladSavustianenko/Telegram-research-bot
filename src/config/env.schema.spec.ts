import { describe, expect, it } from 'vitest';
import { ConfigValidationError, parseEnv } from './env.schema';

const base = { DATABASE_URL: 'postgresql://user:pass@localhost:5432/app' };

function problemsOf(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    parseEnv(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.problems;
    throw error;
  }
  throw new Error('expected validation to fail');
}

describe('parseEnv', () => {
  it('accepts the minimal foundation configuration and applies defaults', () => {
    const env = parseEnv(base);
    expect(env).toMatchObject({ NODE_ENV: 'development', PORT: 3000, LOG_LEVEL: 'log' });
    expect(env.OPENAI_MODEL).toBeUndefined();
  });

  it('reports a missing DATABASE_URL by name', () => {
    expect(problemsOf({})).toContain('DATABASE_URL is required');
  });

  it('reports every invalid variable at once', () => {
    const problems = problemsOf({ DATABASE_URL: 'mysql://x', PORT: '70000', NODE_ENV: 'prod' });
    expect(problems.map((problem) => problem.split(' ')[0]).sort()).toEqual([
      'DATABASE_URL',
      'NODE_ENV',
      'PORT',
    ]);
  });

  it('never echoes configured values in error messages', () => {
    const leakedSecret = 'sk-very-secret value!';
    const error = (() => {
      try {
        parseEnv({
          DATABASE_URL: `postgresql://user:${leakedSecret}@`,
          TELEGRAM_WEBHOOK_SECRET: leakedSecret,
          USER_MONTHLY_BUDGET_USD: leakedSecret,
        });
      } catch (caught) {
        return caught as Error;
      }
      throw new Error('expected validation to fail');
    })();
    expect(error).toBeInstanceOf(ConfigValidationError);
    expect(error.message).not.toContain('very-secret');
    expect(error.message).toContain('TELEGRAM_WEBHOOK_SECRET');
  });

  it('treats empty template values as not set', () => {
    const env = parseEnv({ ...base, OPENAI_API_KEY: '', PORT: '', USER_MONTHLY_BUDGET_USD: '' });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.PORT).toBe(3000);
    expect(env.USER_MONTHLY_BUDGET_USD).toBeUndefined();
  });

  it('converts USD amounts to integer micro-USD without floating point', () => {
    const env = parseEnv({
      ...base,
      USER_MONTHLY_BUDGET_USD: '0.1',
      GLOBAL_MONTHLY_BUDGET_USD: '25',
      RUN_MAX_ESTIMATED_COST_USD: '0.000001',
    });
    expect(env.USER_MONTHLY_BUDGET_USD).toBe(100_000n);
    expect(env.GLOBAL_MONTHLY_BUDGET_USD).toBe(25_000_000n);
    expect(env.RUN_MAX_ESTIMATED_COST_USD).toBe(1n);
  });

  it.each(['-1', '1.0000001', '1e3', 'abc'])('rejects malformed USD amount %s', (value) => {
    expect(problemsOf({ ...base, USER_MONTHLY_BUDGET_USD: value })[0]).toMatch(
      /^USER_MONTHLY_BUDGET_USD /,
    );
  });

  it('keeps administrator Telegram IDs as bigint-compatible strings', () => {
    const env = parseEnv({ ...base, ADMIN_TELEGRAM_IDS: ' 123, 9223372036854775807 ,' });
    expect(env.ADMIN_TELEGRAM_IDS).toEqual(['123', '9223372036854775807']);
    expect(problemsOf({ ...base, ADMIN_TELEGRAM_IDS: '123,@admin' })[0]).toMatch(
      /^ADMIN_TELEGRAM_IDS /,
    );
  });

  it('requires an https public URL in production', () => {
    expect(
      problemsOf({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://example.com' }),
    ).toEqual(['PUBLIC_BASE_URL must use https in production (Telegram webhooks require HTTPS)']);
    expect(() =>
      parseEnv({ ...base, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://example.com' }),
    ).not.toThrow();
  });
});
