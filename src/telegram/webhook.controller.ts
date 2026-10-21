import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { ExecutionGate } from '../operations/execution-gate';
import { TelegramIngressService } from './ingress.service';
import { webhookSecretMatches } from './webhook-secret';

@Controller('telegram')
export class TelegramWebhookController {
  constructor(
    private readonly ingress: TelegramIngressService,
    @Inject(APP_CONFIG) private readonly config: Env,
    private readonly gate: ExecutionGate,
  ) {}

  /**
   * Responds 200 only after the update and its business actions are committed;
   * research and delivery run later in background workers. Telegram retries
   * non-2xx responses, and replays are deduplicated by update_id.
   * While the execution gate is closed (schema not migrated, operational hold;
   * TRB-100) an authenticated update gets 503 and is not read: Telegram keeps
   * it and delivers it again later.
   */
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    if (this.config.TELEGRAM_MODE !== 'webhook') throw new NotFoundException();
    if (
      !webhookSecretMatches(
        secret,
        this.config.TELEGRAM_WEBHOOK_SECRET,
        this.config.TELEGRAM_WEBHOOK_SECRET_PREVIOUS,
      )
    ) {
      throw new UnauthorizedException();
    }
    if (!this.gate.open) throw new ServiceUnavailableException();
    const result = await this.ingress.handle(body);
    if (result === 'invalid') throw new BadRequestException();
    return { ok: true };
  }
}
