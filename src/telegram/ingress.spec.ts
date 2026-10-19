import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it } from 'vitest';
import { timeZoneCallbackData, parseCallbackData } from './callback-data';
import { chatRejection } from './ingress.service';
import { classifyTelegramError } from './telegram-sender';
import { parseCommand, parseUpdate } from './update-parser';
import { webhookSecretMatches } from './webhook-secret';

function message(overrides: { from?: number; chat?: number; type?: string; bot?: boolean }) {
  const update = parseUpdate({
    update_id: 7,
    message: {
      message_id: 1,
      date: 0,
      from: { id: overrides.from ?? 1001, is_bot: overrides.bot ?? false, first_name: 'x' },
      chat: { id: overrides.chat ?? overrides.from ?? 1001, type: overrides.type ?? 'private' },
      text: '/research football',
    },
  });
  if (update.kind === 'invalid') throw new Error('invalid');
  return update;
}

describe('chatRejection', () => {
  it('accepts only a non-bot sender in their own private chat', () => {
    expect(chatRejection(message({}))).toBeNull();
    expect(chatRejection(message({ from: 2002 }))).toBeNull();
  });

  it.each(['group', 'supergroup', 'channel'])('ignores %s chats', (type) => {
    expect(chatRejection(message({ type, chat: -100 }))).toBe('NOT_PRIVATE_CHAT');
  });

  it('ignores bots and private chats that are not the sender', () => {
    expect(chatRejection(message({ bot: true }))).toBe('BOT_SENDER');
    expect(chatRejection(message({ chat: 3003 }))).toBe('CHAT_SENDER_MISMATCH');
  });
});

describe('callback data', () => {
  it('round-trips the time zone confirmation and enforces Telegram limits', () => {
    const data = timeZoneCallbackData(7, 'America/Argentina/Buenos_Aires');
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseCallbackData(data)).toEqual({
      kind: 'confirm_time_zone',
      revision: 7,
      zone: 'America/Argentina/Buenos_Aires',
    });
    expect(() => timeZoneCallbackData(1, 'Europe/<script>')).toThrow();
  });

  it.each([
    null,
    '',
    'tz:1',
    'tz:x:Europe/Kyiv',
    'tz:-1:Europe/Kyiv',
    'tz:01:Europe/Kyiv',
    'tz:1:Europe/Kyiv;user=1002',
    'run:11111111-2222-4333-8444-555555555555',
    `tz:1:${'A'.repeat(70)}`,
  ])('rejects malformed or foreign payload %j', (data) => {
    expect(parseCallbackData(data)).toBeNull();
  });
});

describe('parseUpdate / parseCommand', () => {
  it('rejects bodies without a valid update_id and ignores non-message updates', () => {
    expect(parseUpdate(null).kind).toBe('invalid');
    expect(parseUpdate({ update_id: -1 }).kind).toBe('invalid');
    expect(parseUpdate({ update_id: 1.5 }).kind).toBe('invalid');
    expect(parseUpdate({ update_id: 5, edited_message: {} })).toMatchObject({
      kind: 'ignored',
      reason: 'UNSUPPORTED_UPDATE',
    });
  });

  it('parses button presses and ignores ones without a chat', () => {
    const press = {
      id: 'q1',
      from: { id: 1001, is_bot: false, first_name: 'x' },
      chat_instance: 'c',
      data: 'tz:0:Europe/Kyiv',
    };
    expect(
      parseUpdate({
        update_id: 9,
        callback_query: {
          ...press,
          message: { message_id: 1, date: 0, chat: { id: 1001, type: 'private' } },
        },
      }),
    ).toEqual({
      kind: 'callback',
      updateId: 9n,
      callbackId: 'q1',
      senderId: 1001n,
      chatId: 1001n,
      chatType: 'private',
      isBot: false,
      data: 'tz:0:Europe/Kyiv',
    });
    expect(parseUpdate({ update_id: 10, callback_query: press })).toMatchObject({
      kind: 'ignored',
      reason: 'CALLBACK_WITHOUT_CHAT',
    });
  });

  it('never rounds Telegram IDs outside the safe integer range', () => {
    const unsafe = 2 ** 53 + 1;
    expect(
      parseUpdate({
        update_id: 11,
        message: {
          message_id: 1,
          date: 0,
          from: { id: unsafe, is_bot: false, first_name: 'x' },
          chat: { id: unsafe, type: 'private' },
          text: '/start',
        },
      }),
    ).toMatchObject({ kind: 'ignored', reason: 'NO_SENDER' });
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
