import { Api, GrammyError, HttpError } from 'grammy';

/**
 * `not_sent`: Telegram answered with an error, so no message was created.
 * `unknown`: the request may have been accepted (network failure, timeout);
 * an automatic resend could duplicate the message.
 */
export class TelegramSendError extends Error {
  constructor(
    readonly code: string,
    readonly certainty: 'not_sent' | 'unknown',
    readonly permanent: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Telegram send failed: ${code}`);
    this.name = 'TelegramSendError';
  }
}

export interface TelegramSender {
  sendHtml(chatId: bigint, html: string): Promise<{ messageId: number }>;
}

export const TELEGRAM_SENDER = Symbol('TELEGRAM_SENDER');

/** grammY-based sender. Constructing it makes no network call. */
export class GrammyTelegramSender implements TelegramSender {
  private readonly api: Api;

  constructor(token: string, timeoutSeconds = 15) {
    this.api = new Api(token, { timeoutSeconds });
  }

  async sendHtml(chatId: bigint, html: string): Promise<{ messageId: number }> {
    try {
      const message = await this.api.sendMessage(chatId.toString(), html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return { messageId: message.message_id };
    } catch (error) {
      throw classifyTelegramError(error);
    }
  }
}

export function classifyTelegramError(error: unknown): TelegramSendError {
  if (error instanceof GrammyError) {
    const status = error.error_code;
    if (status === 429) {
      return new TelegramSendError('TELEGRAM_429', 'not_sent', false, error.parameters.retry_after);
    }
    // 400 (bad request, e.g. unparsable HTML or unknown chat) and 403 (bot blocked)
    // will not succeed on retry. 5xx answers mean Telegram did not create the message.
    const permanent = status === 400 || status === 403 || status === 404;
    return new TelegramSendError(`TELEGRAM_${status}`, 'not_sent', permanent);
  }
  if (error instanceof HttpError) {
    return new TelegramSendError('TELEGRAM_NETWORK', 'unknown', false);
  }
  return new TelegramSendError('TELEGRAM_UNEXPECTED', 'unknown', false);
}
