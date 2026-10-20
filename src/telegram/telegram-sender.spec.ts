import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it } from 'vitest';
import {
  compactId,
  expandId,
  historyCallbackData,
  parseCallbackData,
  resendCallbackData,
  runCallbackData,
  taskCallbackData,
} from './callback-data';
import { classifyTelegramError } from './telegram-sender';

const apiError = (error_code: number, description: string, retry_after?: number) =>
  new GrammyError(
    'Call failed',
    {
      ok: false,
      error_code,
      description,
      ...(retry_after === undefined ? {} : { parameters: { retry_after } }),
    },
    'sendMessage',
    {},
  );

describe('classifyTelegramError (TRB-080 retry classification)', () => {
  it('treats flood control as a confirmed, retryable refusal with Retry-After', () => {
    expect(
      classifyTelegramError(apiError(429, 'Too Many Requests: retry after 17', 17)),
    ).toMatchObject({
      code: 'TELEGRAM_429',
      certainty: 'not_sent',
      permanent: false,
      retryAfterSeconds: 17,
    });
  });

  it('recognizes a confirmed blocked or deactivated chat, and nothing else, as unavailable', () => {
    expect(
      classifyTelegramError(apiError(403, 'Forbidden: bot was blocked by the user')),
    ).toMatchObject({
      certainty: 'not_sent',
      permanent: true,
      destinationUnavailable: 'BOT_BLOCKED',
    });
    expect(classifyTelegramError(apiError(403, 'Forbidden: user is deactivated'))).toMatchObject({
      destinationUnavailable: 'USER_DEACTIVATED',
    });
    const other = classifyTelegramError(apiError(403, 'Forbidden: bot is not a member'));
    expect(other).toMatchObject({ permanent: true });
    expect(other.destinationUnavailable).toBeUndefined();
  });

  it('never infers blocking from rate limits, server errors, timeouts or bad requests', () => {
    const cases = [
      apiError(429, 'Too Many Requests', 3),
      apiError(500, 'Internal Server Error'),
      apiError(502, 'Bad Gateway'),
      apiError(400, "Bad Request: can't parse entities"),
      new HttpError('Network request failed', new Error('timeout')),
    ];
    for (const error of cases) {
      expect(classifyTelegramError(error).destinationUnavailable).toBeUndefined();
    }
  });

  it('retries a 5xx answer of the Bot API (ok=false: not created) and gives up on other 4xx', () => {
    expect(classifyTelegramError(apiError(502, 'Bad Gateway'))).toMatchObject({
      certainty: 'not_sent',
      permanent: false,
    });
    expect(classifyTelegramError(apiError(400, 'Bad Request: message is too long'))).toMatchObject({
      certainty: 'not_sent',
      permanent: true,
    });
  });

  it('treats timeouts, resets and unreadable answers as unknown, except a never-opened connection', () => {
    for (const cause of [
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
      { status: 502, statusText: 'Bad Gateway' }, // a gateway page instead of the API's JSON
      new SyntaxError('Unexpected token <'),
    ]) {
      expect(classifyTelegramError(new HttpError('failed', cause))).toMatchObject({
        code: 'TELEGRAM_NETWORK',
        certainty: 'unknown',
      });
    }
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
      expect(
        classifyTelegramError(new HttpError('failed', Object.assign(new Error(code), { code }))),
      ).toMatchObject({ code: 'TELEGRAM_CONNECT_FAILED', certainty: 'not_sent', permanent: false });
    }
    expect(classifyTelegramError(new Error('boom'))).toMatchObject({ certainty: 'unknown' });
  });
});

describe('history callback data (TRB-080)', () => {
  const run = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
  const task = '11111111-2222-4333-8444-555555555555';

  it('round-trips compact IDs and rejects non-canonical forms', () => {
    expect(expandId(compactId(run))).toBe(run);
    expect(compactId(task)).toHaveLength(22);
    expect(expandId('A'.repeat(21))).toBeNull();
    expect(expandId('*'.repeat(22))).toBeNull();
    // 22 base64url characters carry 132 bits: unused low bits must be zero.
    expect(expandId(`${compactId(run).slice(0, 21)}_`)).toBeNull();
  });

  it('fits every history, run and resend button into 64 bytes and parses it back', () => {
    const scopes = ['all', { taskId: task }] as const;
    for (const scope of scopes) {
      for (const data of [
        historyCallbackData(scope),
        historyCallbackData(scope, { direction: 'older', runId: run }),
        historyCallbackData(scope, { direction: 'newer', runId: run }),
        runCallbackData(run, scope),
      ]) {
        expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
        expect(parseCallbackData(data)).not.toBeNull();
      }
    }
    expect(parseCallbackData(resendCallbackData(run))).toEqual({ kind: 'resend', runId: run });
    expect(parseCallbackData(runCallbackData(run, { taskId: task }))).toEqual({
      kind: 'run',
      runId: run,
      scope: { taskId: task },
    });
    expect(Buffer.byteLength(taskCallbackData(task, 999_999_999, 'lr'))).toBeLessThanOrEqual(64);
  });

  it('rejects malformed history callbacks', () => {
    for (const data of [
      'h:',
      'h:**',
      'h:*:x:AAAAAAAAAAAAAAAAAAAAAA',
      'h:*:o:',
      `r:${compactId(run)}`,
      'r:!!!!!!!!!!!!!!!!!!!!!!:*',
      'rs:short',
      `rs:${compactId(run)}:extra`,
      `t:${task}:1:hx`,
    ]) {
      expect(parseCallbackData(data), data).toBeNull();
    }
  });
});
