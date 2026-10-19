import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { TelegramIngressService } from './ingress.service';
import { webhookSecretMatches } from './webhook-secret';

@Controller('telegram')
export class TelegramWebhookController {
  constructor(
    private readonly ingress: TelegramIngressService,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {}

  /**
   * Responds 200 only after the update and its business actions are committed;
   * research and delivery run later in background workers. Telegram retries
   * non-2xx responses, and replays are deduplicated by update_id.
   */
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    if (this.config.TELEGRAM_MODE !== 'webhook') throw new NotFoundException();
    if (!webhookSecretMatches(secret, this.config.TELEGRAM_WEBHOOK_SECRET)) {
      throw new UnauthorizedException();
    }
    const result = await this.ingress.handle(body);
    if (result === 'invalid') throw new BadRequestException();
    return { ok: true };
  }
}
