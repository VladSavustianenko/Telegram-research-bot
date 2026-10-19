import type { Update } from 'grammy/types';

/** Minimal, validated view of an incoming update. Message text is never logged. */
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
  const senderId = typeof message.from?.id === 'number' ? BigInt(message.from.id) : null;
  const chatType = typeof message.chat?.type === 'string' ? message.chat.type : null;
  if (senderId === null || chatType === null || typeof message.chat.id !== 'number') {
    return { kind: 'ignored', updateId, reason: 'NO_SENDER', senderId, chatType };
  }
  if (typeof message.text !== 'string') {
    return { kind: 'ignored', updateId, reason: 'NOT_TEXT', senderId, chatType };
  }
  return {
    kind: 'message',
    updateId,
    senderId,
    chatId: BigInt(message.chat.id),
    chatType,
    isBot: message.from?.is_bot === true,
    text: message.text,
  };
}

/** Parses "/name@bot args". Returns null for non-command text. */
export function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]{1,64})?(?:\s+([\s\S]*))?$/.exec(
    text.trim(),
  );
  if (!match) return null;
  return { name: (match[1] ?? '').toLowerCase(), args: (match[2] ?? '').trim() };
}
