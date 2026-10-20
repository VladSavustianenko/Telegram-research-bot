import { Api, GrammyError, HttpError, InputFile } from 'grammy';

/**
 * `not_sent`: the send is established as not accepted (a Bot API error response,
 * or a connection that was never opened), so no message was created.
 * `unknown`: the request may have been accepted (timeout, connection lost,
 * unreadable response); an automatic resend could duplicate the message.
 */
export class TelegramSendError extends Error {
  constructor(
    readonly code: string,
    readonly certainty: 'not_sent' | 'unknown',
    readonly permanent: boolean,
    readonly retryAfterSeconds?: number,
    /**
     * Telegram confirmed the private chat cannot receive messages: the user
     * blocked the bot or the account is deactivated (403 with that description).
     */
    readonly destinationUnavailable?: 'BOT_BLOCKED' | 'USER_DEACTIVATED',
  ) {
    super(`Telegram send failed: ${code}`);
    this.name = 'TelegramSendError';
  }
}

/** Inline keyboard with callback buttons only (no URL or login buttons). */
export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export interface TelegramDocument {
  fileName: string;
  /** Exact file bytes. */
  content: Buffer;
}

export interface TelegramSender {
  sendHtml(
    chatId: bigint,
    html: string,
    replyMarkup?: InlineKeyboard,
  ): Promise<{ messageId: number }>;
  /** Sends a file with an HTML caption (TRB-080 report fallback). */
  sendDocument(
    chatId: bigint,
    document: TelegramDocument,
    captionHtml: string,
  ): Promise<{ messageId: number }>;
  /** Best-effort acknowledgement of a button press; not a business action. */
  answerCallback(callbackQueryId: string, text?: string): Promise<void>;
}

export const TELEGRAM_SENDER = Symbol('TELEGRAM_SENDER');

/** grammY-based sender. Constructing it makes no network call. */
export class GrammyTelegramSender implements TelegramSender {
  private readonly api: Api;

  constructor(token: string, timeoutSeconds = 15, apiRoot?: string) {
    this.api = new Api(token, { timeoutSeconds, ...(apiRoot ? { apiRoot } : {}) });
  }

  async sendHtml(
    chatId: bigint,
    html: string,
    replyMarkup?: InlineKeyboard,
  ): Promise<{ messageId: number }> {
    try {
      const message = await this.api.sendMessage(chatId.toString(), html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
      return { messageId: message.message_id };
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }

  async sendDocument(
    chatId: bigint,
    document: TelegramDocument,
    captionHtml: string,
  ): Promise<{ messageId: number }> {
    try {
      const message = await this.api.sendDocument(
        chatId.toString(),
        new InputFile(document.content, document.fileName),
        { caption: captionHtml, parse_mode: 'HTML' },
      );
      return { messageId: message.message_id };
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }

  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await this.api.answerCallbackQuery(callbackQueryId, text ? { text } : {});
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }
}

/** Socket errors raised before a connection exists: no request bytes were sent. */
const NOT_CONNECTED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Retry classification (docs/DELIVERY.md).
 *
 * The Bot API contract: every response has `ok`; when the request is
 * unsuccessful, `ok` is false with `error_code` and `description`. grammY
 * raises GrammyError only for such a parsed answer, so it establishes that the
 * method failed and no message was created:
 * - 429: flood control; retryable after `parameters.retry_after` seconds;
 * - 403 "bot was blocked by the user" / "user is deactivated": permanent, and
 *   the destination is confirmed unavailable;
 * - other 4xx (malformed HTML, chat not found, other 403): permanent;
 * - 5xx answered with ok=false: retryable with backoff.
 * HttpError means no Bot API answer was read (timeout, connection reset,
 * gateway page that is not the API's JSON): the request may have been
 * executed, so the outcome is unknown. The only exception is a connection that
 * was never established (refused, DNS failure), which proves nothing was sent.
 */
export function classifyTelegramError(error: unknown): TelegramSendError {
  if (error instanceof GrammyError) {
    const status = error.error_code;
    if (status === 429) {
      return new TelegramSendError('TELEGRAM_429', 'not_sent', false, error.parameters.retry_after);
    }
    if (status === 403) {
      const description = error.description.toLowerCase();
      const unavailable = description.includes('bot was blocked by the user')
        ? 'BOT_BLOCKED'
        : description.includes('user is deactivated')
          ? 'USER_DEACTIVATED'
          : undefined;
      return new TelegramSendError('TELEGRAM_403', 'not_sent', true, undefined, unavailable);
    }
    return new TelegramSendError(`TELEGRAM_${status}`, 'not_sent', status >= 400 && status < 500);
  }
  if (error instanceof HttpError) {
    const cause = error.error as { code?: unknown } | null;
    if (cause && typeof cause.code === 'string' && NOT_CONNECTED.has(cause.code)) {
      return new TelegramSendError('TELEGRAM_CONNECT_FAILED', 'not_sent', false);
    }
    return new TelegramSendError('TELEGRAM_NETWORK', 'unknown', false);
  }
  return new TelegramSendError('TELEGRAM_UNEXPECTED', 'unknown', false);
}
