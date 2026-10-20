import type { Server } from 'node:http';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { inject } from 'vitest';
import { AppModule } from '../../src/app.module';
import { CLOCK } from '../../src/common/clock';
import { parseEnv } from '../../src/config/env.schema';
import { PrismaService } from '../../src/database/prisma.service';
import { DeliveryDispatcher } from '../../src/delivery/delivery-dispatcher';
import { DeliveryWorker } from '../../src/delivery/delivery-worker.service';
import { QueueService } from '../../src/queue/queue.service';
import { OutboxDispatcher } from '../../src/research/outbox-dispatcher';
import { RESEARCH_PROVIDER } from '../../src/research/provider/provider.types';
import { ResearchWorker } from '../../src/research/research-worker.service';
import { SchedulerService } from '../../src/scheduling/scheduler.service';
import { TELEGRAM_SENDER } from '../../src/telegram/telegram-sender';
import { FakeClock, RecordingSender, ScriptedProvider } from './fakes';

export const ADMIN_ID = 1001;
export const OTHER_ADMIN_ID = 1002;
export const BOT_TOKEN = '123456:TEST-TOKEN-not-real';
export const WEBHOOK_SECRET = 'test_webhook_secret';
export const INVITATION_SECRET = 'test-invitation-secret-0123456789abcdef';
export const BOT_USERNAME = 'trb_test_bot';

/** Records every log call so tests can assert what is (not) logged. */
export class CaptureLogger implements LoggerService {
  readonly lines: string[] = [];
  private push(level: string, args: unknown[]): void {
    this.lines.push(
      `${level} ${JSON.stringify(args, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value instanceof Error ? value.stack : value,
      )}`,
    );
  }
  log(...args: unknown[]): void {
    this.push('log', args);
  }
  error(...args: unknown[]): void {
    this.push('error', args);
  }
  warn(...args: unknown[]): void {
    this.push('warn', args);
  }
  debug(...args: unknown[]): void {
    this.push('debug', args);
  }
  verbose(...args: unknown[]): void {
    this.push('verbose', args);
  }
  fatal(...args: unknown[]): void {
    this.push('fatal', args);
  }
}

export interface Harness {
  app: INestApplication;
  prisma: PrismaService;
  research: ResearchWorker;
  queue: QueueService;
  scheduler: SchedulerService;
  dispatcher: OutboxDispatcher;
  delivery: DeliveryWorker;
  deliveryDispatcher: DeliveryDispatcher;
  provider: ScriptedProvider;
  sender: RecordingSender;
  clock: FakeClock;
  logger: CaptureLogger;
  post(update: unknown, secret?: string | null): request.Test;
  close(): Promise<void>;
}

/** App wired to the disposable database, fakes and manual worker ticks (no background loops). */
export async function startHarness(
  env: Record<string, string> = {},
  deps: {
    provider?: ScriptedProvider;
    sender?: RecordingSender;
    clock?: FakeClock;
    databaseUrl?: string;
  } = {},
): Promise<Harness> {
  const config = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: deps.databaseUrl ?? inject('databaseUrl'),
    BACKGROUND_WORKERS: 'off',
    TELEGRAM_MODE: 'webhook',
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ADMIN_TELEGRAM_IDS: `${ADMIN_ID},${OTHER_ADMIN_ID}`,
    INVITATION_TOKEN_SECRET: INVITATION_SECRET,
    TELEGRAM_BOT_USERNAME: BOT_USERNAME,
    RESEARCH_MODE: 'fake',
    OPENAI_POLL_INTERVAL_MS: '5',
    // Generous quotas so that earlier suites keep their meaning; quota tests set their own.
    USER_ACTIVE_RUN_LIMIT: '10',
    USER_DAILY_RUN_LIMIT: '100',
    USER_DAILY_MANUAL_RUN_LIMIT: '100',
    ...env,
  });
  const provider =
    deps.provider ?? new ScriptedProvider(config.RESEARCH_MODE === 'live' ? 'openai' : 'fake');
  const sender = deps.sender ?? new RecordingSender();
  const clock = deps.clock ?? new FakeClock();
  const logger = new CaptureLogger();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
    .overrideProvider(RESEARCH_PROVIDER)
    .useValue(provider)
    .overrideProvider(TELEGRAM_SENDER)
    .useValue(sender)
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication({ logger });
  await app.init();
  const server = app.getHttpServer() as Server;
  return {
    app,
    prisma: app.get(PrismaService),
    research: app.get(ResearchWorker),
    queue: app.get(QueueService),
    scheduler: app.get(SchedulerService),
    dispatcher: app.get(OutboxDispatcher),
    delivery: app.get(DeliveryWorker),
    deliveryDispatcher: app.get(DeliveryDispatcher),
    provider,
    sender,
    clock,
    logger,
    post: (update, secret = WEBHOOK_SECRET) => {
      const call = request(server)
        .post('/telegram/webhook')
        .send(update as object);
      return secret === null ? call : call.set('X-Telegram-Bot-Api-Secret-Token', secret);
    },
    close: () => app.close(),
  };
}

/**
 * Empties all application tables. By default the two configured administrators
 * are then recreated with completed onboarding (Europe/Kyiv), as after their
 * first /start; pass `{ onboardedAdmins: false }` for an empty user table.
 */
export async function resetDatabase(
  prisma: PrismaService,
  options: { onboardedAdmins?: boolean } = {},
): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE usage_ledger, budget_reservation, pricing_version, outbox_event, task_draft, task, audit_event, invitation, research_tool_item, research_reconciliation, research_attempt, schedule_event, delivery_event, delivery_part, delivery, research_run, telegram_update, app_user RESTART IDENTITY CASCADE',
  );
  // Jobs of earlier tests (pg-boss's own schema, installed by the global setup).
  await prisma.$executeRawUnsafe('TRUNCATE pgboss.job');
  if (options.onboardedAdmins === false) return;
  for (const id of [ADMIN_ID, OTHER_ADMIN_ID]) {
    await prisma.$executeRaw`
      INSERT INTO app_user (id, telegram_user_id, private_chat_id, role, onboarding_state, time_zone,
                            onboarded_at, updated_at)
      VALUES (gen_random_uuid(), ${id}, ${id}, 'ADMIN', 'COMPLETED', 'Europe/Kyiv', now(), now())`;
  }
}

let nextUpdateId = 1;

export function privateMessage(text: string, from = ADMIN_ID, updateId = nextUpdateId++) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_792_324_800,
      from: { id: from, is_bot: false, first_name: 'Test' },
      chat: { id: from, type: 'private', first_name: 'Test' },
      text,
    },
  };
}

export function groupMessage(text: string, from = ADMIN_ID, updateId = nextUpdateId++) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_792_324_800,
      from: { id: from, is_bot: false, first_name: 'Test' },
      chat: { id: -100123, type: 'supergroup', title: 'Group' },
      text,
    },
  };
}

/** A press of an inline button attached to a message in the sender's private chat. */
export function callbackQuery(
  data: string,
  from = ADMIN_ID,
  updateId = nextUpdateId++,
  chat: { id: number; type: string } = { id: from, type: 'private' },
) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cbq-${updateId}`,
      from: { id: from, is_bot: false, first_name: 'Test' },
      chat_instance: 'ci',
      data,
      message: {
        message_id: 1,
        date: 1_792_324_800,
        chat: { ...chat, first_name: 'Test' },
        text: 'buttons',
      },
    },
  };
}

/** Runs delivery ticks until no delivery is ready. */
export async function drainDeliveries(harness: Harness, max = 20): Promise<void> {
  for (let i = 0; i < max; i += 1) {
    if (!(await harness.delivery.tick())) return;
  }
}
