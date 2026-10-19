import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { parseEnv } from '../config/env.schema';
import { decide } from './ingress.service';
import { classifyTelegramError } from './telegram-sender';
import { parseCommand, parseUpdate } from './update-parser';
import { webhookSecretMatches } from './webhook-secret';

const config = parseEnv({
  DATABASE_URL: 'postgresql://u:p@localhost:5434/db',
  RESEARCH_MODE: 'fake',
  ADMIN_TELEGRAM_IDS: '1001',
  RESEARCH_PROMPT_MAX_CHARS: '20',
});

function message(overrides: {
  from?: number;
  chat?: number;
  type?: string;
  text?: string;
  bot?: boolean;
}) {
  const update = parseUpdate({
    update_id: 7,
    message: {
      message_id: 1,
      date: 0,
      from: { id: overrides.from ?? 1001, is_bot: overrides.bot ?? false, first_name: 'x' },
      chat: { id: overrides.chat ?? overrides.from ?? 1001, type: overrides.type ?? 'private' },
      text: overrides.text ?? '/research football',
    },
  });
  if (update.kind === 'invalid') throw new Error('invalid');
  return update;
}

describe('decide', () => {
  it('accepts research only from an administrator in their private chat', () => {
    expect(decide(message({}), config)).toEqual({ action: 'research', prompt: 'football' });
  });

  it.each(['group', 'supergroup', 'channel'])('ignores %s chats without replying', (type) => {
    expect(decide(message({ type, chat: -100 }), config)).toEqual({
      action: 'ignore',
      reason: 'NOT_PRIVATE_CHAT',
    });
  });

  it('rejects non-administrators even when the text names an administrator ID', () => {
    expect(decide(message({ from: 2002, text: '/research 1001 football' }), config)).toMatchObject({
      action: 'reply',
      disposition: 'REJECTED',
      reason: 'NOT_ADMIN',
    });
  });

  it('ignores bots and private chats that are not the sender', () => {
    expect(decide(message({ bot: true }), config)).toMatchObject({ reason: 'BOT_SENDER' });
    expect(decide(message({ chat: 3003 }), config)).toMatchObject({
      reason: 'CHAT_SENDER_MISMATCH',
    });
  });

  it('validates prompts and result IDs', () => {
    expect(decide(message({ text: '/research   ' }), config)).toMatchObject({
      reason: 'EMPTY_PROMPT',
    });
    expect(decide(message({ text: `/research ${'я'.repeat(21)}` }), config)).toMatchObject({
      reason: 'PROMPT_TOO_LONG',
    });
    expect(decide(message({ text: `/research ${'я'.repeat(20)}` }), config)).toMatchObject({
      action: 'research',
    });
    expect(decide(message({ text: '/result 42' }), config)).toMatchObject({
      reason: 'RESULT_USAGE',
    });
    expect(
      decide(message({ text: '/result 11111111-2222-4333-8444-555555555555' }), config),
    ).toEqual({ action: 'result', runId: '11111111-2222-4333-8444-555555555555' });
  });

  it('refuses research when disabled', () => {
    const disabled = parseEnv({ DATABASE_URL: config.DATABASE_URL, ADMIN_TELEGRAM_IDS: '1001' });
    expect(decide(message({}), disabled)).toMatchObject({ reason: 'RESEARCH_DISABLED' });
  });
});

describe('parseUpdate / parseCommand', () => {
  it('rejects bodies without a valid update_id and ignores non-message updates', () => {
    expect(parseUpdate(null).kind).toBe('invalid');
    expect(parseUpdate({ update_id: -1 }).kind).toBe('invalid');
    expect(parseUpdate({ update_id: 1.5 }).kind).toBe('invalid');
    expect(parseUpdate({ update_id: 5, callback_query: {} })).toMatchObject({
      kind: 'ignored',
      reason: 'UNSUPPORTED_UPDATE',
    });
  });

  it('parses commands with bot suffixes and multi-line arguments', () => {
    expect(parseCommand('/Research@MyBot  line one\nline two ')).toEqual({
      name: 'research',
      args: 'line one\nline two',
    });
    expect(parseCommand('hello /research')).toBeNull();
  });
});

describe('webhookSecretMatches', () => {
  it('requires the exact configured secret', () => {
    expect(webhookSecretMatches('abc_123', 'abc_123')).toBe(true);
    expect(webhookSecretMatches('abc_124', 'abc_123')).toBe(false);
    expect(webhookSecretMatches(undefined, 'abc_123')).toBe(false);
    expect(webhookSecretMatches('', '')).toBe(false);
    expect(webhookSecretMatches('abc_123', undefined)).toBe(false);
  });
});

describe('classifyTelegramError', () => {
  const grammyError = (error_code: number, retry_after?: number) =>
    new GrammyError(
      'failed',
      { ok: false, error_code, description: 'x', parameters: retry_after ? { retry_after } : {} },
      'sendMessage',
      {},
    );

  it('distinguishes definite failures from unknown outcomes', () => {
    expect(classifyTelegramError(grammyError(429, 7))).toMatchObject({
      certainty: 'not_sent',
      permanent: false,
      retryAfterSeconds: 7,
    });
    expect(classifyTelegramError(grammyError(403))).toMatchObject({
      certainty: 'not_sent',
      permanent: true,
    });
    expect(classifyTelegramError(grammyError(400))).toMatchObject({ permanent: true });
    expect(classifyTelegramError(grammyError(502))).toMatchObject({
      certainty: 'not_sent',
      permanent: false,
    });
    expect(classifyTelegramError(new HttpError('network', new Error('ETIMEDOUT')))).toMatchObject({
      certainty: 'unknown',
    });
  });
});
