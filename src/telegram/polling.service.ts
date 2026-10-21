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
import { AppLifecycle } from '../common/lifecycle';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { ExecutionGate } from '../operations/execution-gate';
import { TelegramIngressService } from './ingress.service';

const LONG_POLL_SECONDS = 25;
const COMPONENT = 'telegram-polling';

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
    private readonly lifecycle: AppLifecycle,
    private readonly gate: ExecutionGate,
  ) {
    lifecycle.shutdownSignal.addEventListener('abort', () => this.controller.abort(), {
      once: true,
    });
  }

  onApplicationBootstrap(): void {
    if (this.config.TELEGRAM_MODE !== 'polling' || this.config.BACKGROUND_WORKERS !== 'on') return;
    const token = this.config.TELEGRAM_BOT_TOKEN;
    if (!token) return;
    // A stopped poller (409 conflict) reports not ready; a long poll lasts at most ~35 s.
    this.lifecycle.register(COMPONENT, { staleAfterMs: 300_000 });
    this.gate.whenOpen(() => {
      if (this.controller.signal.aborted) return;
      const api = new Api(token, {
        timeoutSeconds: LONG_POLL_SECONDS + 10,
        ...(this.config.TELEGRAM_API_ROOT ? { apiRoot: this.config.TELEGRAM_API_ROOT } : {}),
      });
      this.lifecycle.mark(COMPONENT, 'up');
      this.running = this.run(api);
    });
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
        this.lifecycle.heartbeat(COMPONENT);
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
          this.lifecycle.mark(COMPONENT, 'failed');
          return;
        }
        this.logger.warn({ message: 'Telegram polling failed', ...errorInfo(error) });
        await abortableSleep(5_000, signal);
      }
    }
  }
}
