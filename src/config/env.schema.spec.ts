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
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'log',
      DATABASE_CONNECT_TIMEOUT_MS: 5_000,
      DATABASE_STATEMENT_TIMEOUT_MS: 30_000,
      DATABASE_SHUTDOWN_TIMEOUT_MS: 5_000,
    });
    expect(problemsOf({ ...base, DATABASE_CONNECT_TIMEOUT_MS: '0' })).toEqual([
      'DATABASE_CONNECT_TIMEOUT_MS must be a positive integer',
    ]);
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

  it('accepts an optional http(s) Bot API root and rejects other values (TRB-080)', () => {
    expect(parseEnv(base).TELEGRAM_API_ROOT).toBeUndefined();
    expect(parseEnv({ ...base, TELEGRAM_API_ROOT: '' }).TELEGRAM_API_ROOT).toBeUndefined();
    expect(
      parseEnv({ ...base, TELEGRAM_API_ROOT: 'http://localhost:8081' }).TELEGRAM_API_ROOT,
    ).toBe('http://localhost:8081');
    expect(problemsOf({ ...base, TELEGRAM_API_ROOT: 'ftp://bot.example' })).toEqual([
      'TELEGRAM_API_ROOT must be an http(s) URL',
    ]);
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

describe('feature modes (TRB-020)', () => {
  it('keeps Telegram and research disabled by default', () => {
    expect(parseEnv(base)).toMatchObject({ TELEGRAM_MODE: 'disabled', RESEARCH_MODE: 'disabled' });
  });

  it('requires credentials, model and finite bounds for live research, naming each variable', () => {
    expect([...problemsOf({ ...base, RESEARCH_MODE: 'live' })].sort()).toEqual([
      'OPENAI_API_KEY is required when RESEARCH_MODE=live',
      'OPENAI_MODEL is required when RESEARCH_MODE=live',
      'OUTPUT_TOKEN_LIMIT is required when RESEARCH_MODE=live',
      'RUN_DEADLINE_SECONDS is required when RESEARCH_MODE=live',
      'TOOL_CALL_LIMIT is required when RESEARCH_MODE=live',
    ]);
  });

  it('rejects unenforceable or unsupported live settings without echoing secrets', () => {
    const problems = problemsOf({
      ...base,
      RESEARCH_MODE: 'live',
      OPENAI_API_KEY: 'sk-live-secret-value',
      OPENAI_MODEL: 'm',
      OUTPUT_TOKEN_LIMIT: '8',
      TOOL_CALL_LIMIT: '2',
      RUN_DEADLINE_SECONDS: '3600',
      RESEARCH_CONCURRENCY: '2',
    });
    expect(problems.map((problem) => problem.split(' ')[0]).sort()).toEqual([
      'OUTPUT_TOKEN_LIMIT',
      'RESEARCH_CONCURRENCY',
      'RUN_DEADLINE_SECONDS',
    ]);
    expect(problems.join('\n')).not.toContain('sk-live-secret-value');
  });

  it('requires token, administrators and a webhook secret for Telegram modes', () => {
    expect([...problemsOf({ ...base, TELEGRAM_MODE: 'webhook' })].sort()).toEqual([
      'ADMIN_TELEGRAM_IDS is required when TELEGRAM_MODE=webhook',
      'TELEGRAM_BOT_TOKEN is required when TELEGRAM_MODE=webhook',
      'TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_MODE=webhook',
    ]);
    expect(
      problemsOf({
        ...base,
        NODE_ENV: 'production',
        TELEGRAM_MODE: 'polling',
        TELEGRAM_BOT_TOKEN: 't',
        ADMIN_TELEGRAM_IDS: '1',
      }),
    ).toEqual(['TELEGRAM_MODE polling is for development only; use webhook in production']);
  });

  it('validates the research time zone', () => {
    expect(problemsOf({ ...base, RESEARCH_TIME_ZONE: 'Mars/Base' })[0]).toMatch(
      /^RESEARCH_TIME_ZONE /,
    );
    expect(parseEnv({ ...base, RESEARCH_TIME_ZONE: 'America/New_York' }).RESEARCH_TIME_ZONE).toBe(
      'America/New_York',
    );
  });
});

describe('queue execution settings (TRB-060)', () => {
  it('uses a separate pg-boss schema and conservative retry defaults', () => {
    expect(parseEnv(base)).toMatchObject({
      QUEUE_SCHEMA: 'pgboss',
      RESEARCH_CAPACITY_RETRY_SECONDS: 15,
      RESEARCH_QUEUE_MAX_WAIT_SECONDS: 3_600,
      RESEARCH_SUBMISSION_RETRY_LIMIT: 0,
      RESEARCH_SUBMISSION_RETRY_DELAY_SECONDS: 30,
    });
  });

  it('rejects unsafe queue and retry settings', () => {
    expect(
      problemsOf({
        ...base,
        QUEUE_SCHEMA: 'public',
        RESEARCH_SUBMISSION_RETRY_LIMIT: '3',
        RESEARCH_SUBMISSION_RETRY_DELAY_SECONDS: '301',
        OPENAI_HTTP_TIMEOUT_MS: '30001',
      }).map((problem) => problem.split(' ')[0]),
    ).toEqual([
      'QUEUE_SCHEMA',
      'RESEARCH_SUBMISSION_RETRY_LIMIT',
      'RESEARCH_SUBMISSION_RETRY_DELAY_SECONDS',
      'OPENAI_HTTP_TIMEOUT_MS',
    ]);
    expect(problemsOf({ ...base, QUEUE_SCHEMA: 'Bad-Name' })).toEqual([
      'QUEUE_SCHEMA must be a lower-case PostgreSQL identifier',
    ]);
    expect(problemsOf({ ...base, RESEARCH_SUBMISSION_RETRY_LIMIT: '-1' })).toEqual([
      'RESEARCH_SUBMISSION_RETRY_LIMIT must be a non-negative integer',
    ]);
    expect(
      parseEnv({ ...base, RESEARCH_SUBMISSION_RETRY_LIMIT: '2' }).RESEARCH_SUBMISSION_RETRY_LIMIT,
    ).toBe(2);
  });
});
