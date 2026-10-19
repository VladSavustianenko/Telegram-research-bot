import type { Update } from 'grammy/types';

/** Minimal, validated view of an incoming update. Message text and callback data are never logged. */
export type ParsedUpdate =
  | { kind: 'invalid' }
  | {
      kind: 'ignored';
      updateId: bigint;
      reason: string;
      senderId: bigint | null;
      chatType: string | null;
    }
  | {
      kind: 'message';
      updateId: bigint;
      senderId: bigint;
      chatId: bigint;
      chatType: string;
      isBot: boolean;
      text: string;
    }
  | {
      kind: 'callback';
      updateId: bigint;
      callbackId: string;
      senderId: bigint;
      /** Chat of the message carrying the button. */
      chatId: bigint;
      chatType: string;
      isBot: boolean;
      data: string | null;
    };

export interface ParsedCommand {
  /** Lower-case command without the leading slash or @bot suffix. */
  name: string;
  /** Everything after the command, trimmed; may contain newlines. */
  args: string;
}

export function parseUpdate(raw: unknown): ParsedUpdate {
  if (typeof raw !== 'object' || raw === null) return { kind: 'invalid' };
  const update = raw as Partial<Update>;
  if (!Number.isSafeInteger(update.update_id) || (update.update_id ?? -1) < 0) {
    return { kind: 'invalid' };
  }
  const updateId = BigInt(update.update_id as number);
  if (update.callback_query) return parseCallback(updateId, update.callback_query);
  const message = update.message;
  if (!message) {
    return {
      kind: 'ignored',
      updateId,
      reason: 'UNSUPPORTED_UPDATE',
      senderId: null,
      chatType: null,
    };
  }
  const senderId = telegramId(message.from?.id);
  const chatType = typeof message.chat?.type === 'string' ? message.chat.type : null;
  const chatId = telegramId(message.chat?.id);
  if (senderId === null || chatType === null || chatId === null) {
    return { kind: 'ignored', updateId, reason: 'NO_SENDER', senderId, chatType };
  }
  if (typeof message.text !== 'string') {
    return { kind: 'ignored', updateId, reason: 'NOT_TEXT', senderId, chatType };
  }
  return {
    kind: 'message',
    updateId,
    senderId,
    chatId,
    chatType,
    isBot: message.from?.is_bot === true,
    text: message.text,
  };
}

function parseCallback(
  updateId: bigint,
  query: NonNullable<Update['callback_query']>,
): ParsedUpdate {
  const senderId = telegramId(query.from?.id);
  const chat = query.message?.chat;
  const chatType = typeof chat?.type === 'string' ? chat.type : null;
  if (senderId === null || typeof query.id !== 'string') {
    return { kind: 'ignored', updateId, reason: 'NO_SENDER', senderId, chatType };
  }
  // Inline-mode callbacks have no message; they never come from this bot's own buttons.
  const chatId = telegramId(chat?.id);
  if (chatType === null || chatId === null) {
    return { kind: 'ignored', updateId, reason: 'CALLBACK_WITHOUT_CHAT', senderId, chatType };
  }
  return {
    kind: 'callback',
    updateId,
    callbackId: query.id,
    senderId,
    chatId,
    chatType,
    isBot: query.from.is_bot === true,
    data: typeof query.data === 'string' ? query.data : null,
  };
}

/**
 * Telegram IDs fit in 52 bits; JSON numbers beyond the safe integer range
 * cannot be converted exactly and are rejected rather than rounded.
 */
function telegramId(value: unknown): bigint | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : null;
}

/** Parses "/name@bot args". Returns null for non-command text. */
export function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/.exec(
    text.trim(),
  );
  if (!match) return null;
  return { name: (match[1] ?? '').toLowerCase(), args: (match[2] ?? '').trim() };
}
