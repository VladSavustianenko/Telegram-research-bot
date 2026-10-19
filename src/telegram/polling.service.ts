import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Api, GrammyError } from 'grammy';
import { abortableSleep } from '../common/abortable-sleep';
import { errorInfo } from '../common/error-info';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { TelegramIngressService } from './ingress.service';

const LONG_POLL_SECONDS = 25;

/**
 * Development-only long polling (TELEGRAM_MODE=polling). It never deletes a
 * webhook: if one is registered, Telegram answers getUpdates with 409 and
 * polling stops, so polling and a webhook never run for the same token.
 * The offset advances only after an update has been durably handled.
 */
@Injectable()
export class TelegramPollingService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TelegramPollingService.name);
  private readonly controller = new AbortController();
  private running: Promise<void> | undefined;

  constructor(
    private readonly ingress: TelegramIngressService,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.TELEGRAM_MODE !== 'polling' || this.config.BACKGROUND_WORKERS !== 'on') return;
    if (!this.config.TELEGRAM_BOT_TOKEN) return;
    const api = new Api(this.config.TELEGRAM_BOT_TOKEN, { timeoutSeconds: LONG_POLL_SECONDS + 10 });
    this.running = this.run(api);
  }

  async onModuleDestroy(): Promise<void> {
    this.controller.abort();
    // An in-flight long poll is abandoned; unconfirmed updates are re-delivered and deduplicated.
    await Promise.race([this.running, abortableSleep(2_000)]);
  }

  private async run(api: Api): Promise<void> {
    const signal = this.controller.signal;
    let offset: number | undefined;
    this.logger.log({ message: 'Telegram polling started (development mode)' });
    while (!signal.aborted) {
      try {
        const updates = await api.getUpdates(
          { offset, timeout: LONG_POLL_SECONDS, allowed_updates: ['message', 'callback_query'] },
          // grammY types its signal with the abort-controller polyfill; Node's is compatible.
          signal as unknown as Parameters<Api['getUpdates']>[1],
        );
        for (const update of updates) {
          await this.ingress.handle(update);
          offset = update.update_id + 1;
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof GrammyError && error.error_code === 409) {
          this.logger.error({
            message: 'Polling conflicts with a webhook or another poller; stopping',
          });
          return;
        }
        this.logger.warn({ message: 'Telegram polling failed', ...errorInfo(error) });
        await abortableSleep(5_000, signal);
      }
    }
  }
}
