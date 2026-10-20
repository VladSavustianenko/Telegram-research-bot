import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { TelegramIngressService } from './ingress.service';
import { TelegramPollingService } from './polling.service';
import { GrammyTelegramSender, TELEGRAM_SENDER } from './telegram-sender';
import { TelegramWebhookController } from './webhook.controller';

export function createTelegramSender(config: Env): GrammyTelegramSender | null {
  return config.TELEGRAM_MODE !== 'disabled' && config.TELEGRAM_BOT_TOKEN
    ? new GrammyTelegramSender(config.TELEGRAM_BOT_TOKEN, 15, config.TELEGRAM_API_ROOT)
    : null;
}

@Global()
@Module({
  controllers: [TelegramWebhookController],
  providers: [
    TelegramIngressService,
    TelegramPollingService,
    { provide: TELEGRAM_SENDER, inject: [APP_CONFIG], useFactory: createTelegramSender },
  ],
  exports: [TELEGRAM_SENDER, TelegramIngressService],
})
export class TelegramModule {}
