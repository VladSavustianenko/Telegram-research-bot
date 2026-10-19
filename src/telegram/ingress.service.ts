import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { isUniqueViolation, type Tx } from '../database/prisma-errors';
import { PrismaService } from '../database/prisma.service';
import { createDelivery, createStatusDelivery } from '../delivery/delivery-records';
import { messages } from '../delivery/messages';
import { codePointLength } from '../research/report';
import { snapshotRunConfig } from '../research/request-builder';
import { parseCommand, parseUpdate, type ParsedUpdate } from './update-parser';

type Disposition = 'RUN_ACCEPTED' | 'RESULT_REQUESTED' | 'REPLIED' | 'REJECTED' | 'IGNORED';

/** What to do with an update, decided without database access. */
export type Decision =
  | { action: 'ignore'; reason: string }
  | { action: 'reply'; disposition: 'REPLIED' | 'REJECTED'; reason: string; text: string }
  | { action: 'research'; prompt: string }
  | { action: 'result'; runId: string };

export type IngressResult = 'processed' | 'duplicate' | 'invalid';

/** Postgres advisory lock key serialising research admission (queue bound). */
const ADMISSION_LOCK_KEY = 20_020;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authorization and command routing. Identity comes only from the update's
 * sender; the destination is the authorized private chat itself.
 */
export function decide(update: Exclude<ParsedUpdate, { kind: 'invalid' }>, config: Env): Decision {
  if (update.kind === 'ignored') return { action: 'ignore', reason: update.reason };
  if (update.chatType !== 'private') return { action: 'ignore', reason: 'NOT_PRIVATE_CHAT' };
  // In a private chat the chat ID equals the user ID; anything else is not a 1:1 chat.
  if (update.chatId !== update.senderId)
    return { action: 'ignore', reason: 'CHAT_SENDER_MISMATCH' };
  if (update.isBot) return { action: 'ignore', reason: 'BOT_SENDER' };

  const admins = config.ADMIN_TELEGRAM_IDS ?? [];
  if (!admins.includes(update.senderId.toString())) {
    return {
      action: 'reply',
      disposition: 'REJECTED',
      reason: 'NOT_ADMIN',
      text: messages.notAuthorized,
    };
  }

  const command = parseCommand(update.text);
  const reply = (reason: string, text: string): Decision => ({
    action: 'reply',
    disposition: 'REPLIED',
    reason,
    text,
  });
  switch (command?.name) {
    case 'start':
    case 'help':
      return reply('HELP', messages.help);
    case 'research': {
      if (config.RESEARCH_MODE === 'disabled')
        return reply('RESEARCH_DISABLED', messages.researchDisabled);
      if (!command.args) return reply('EMPTY_PROMPT', messages.emptyPrompt);
      if (codePointLength(command.args) > config.RESEARCH_PROMPT_MAX_CHARS) {
        return reply('PROMPT_TOO_LONG', messages.promptTooLong(config.RESEARCH_PROMPT_MAX_CHARS));
      }
      return { action: 'research', prompt: command.args };
    }
    case 'result':
      if (!UUID.test(command.args)) return reply('RESULT_USAGE', messages.resultUsage);
      return { action: 'result', runId: command.args.toLowerCase() };
    case undefined:
      return reply('NOT_A_COMMAND', messages.help);
    default:
      return reply('UNKNOWN_COMMAND', messages.unknownCommand);
  }
}

@Injectable()
export class TelegramIngressService {
  private readonly logger = new Logger(TelegramIngressService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: Env,
  ) {}

  /**
   * Records the update and every resulting business action in one transaction.
   * Returns only after commit, so a webhook acknowledgment implies durable
   * receipt. A replayed update_id is a no-op.
   */
  async handle(raw: unknown): Promise<IngressResult> {
    const update = parseUpdate(raw);
    if (update.kind === 'invalid') return 'invalid';
    const decision = decide(update, this.config);

    try {
      const outcome = await this.prisma.$transaction((tx) => this.apply(tx, update, decision));
      this.logger.log({
        message: 'Telegram update processed',
        updateId: update.updateId.toString(),
        disposition: outcome.disposition,
        reason: outcome.reason,
        ...(outcome.runId ? { runId: outcome.runId } : {}),
      });
      return 'processed';
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.log({
          message: 'Duplicate Telegram update ignored',
          updateId: update.updateId.toString(),
        });
        return 'duplicate';
      }
      throw error;
    }
  }

  private async apply(
    tx: Tx,
    update: Exclude<ParsedUpdate, { kind: 'invalid' }>,
    decision: Decision,
  ): Promise<{ disposition: Disposition; reason: string | null; runId?: string }> {
    const record = (disposition: Disposition, reason: string | null, runId?: string) =>
      tx.telegramUpdate.create({
        data: {
          updateId: update.updateId,
          senderTelegramId: update.senderId,
          chatType: update.chatType,
          disposition,
          reason,
          runId: runId ?? null,
        },
      });

    if (decision.action === 'ignore' || update.kind !== 'message') {
      const reason = decision.action === 'ignore' ? decision.reason : 'IGNORED';
      await record('IGNORED', reason);
      return { disposition: 'IGNORED', reason };
    }
    const chatId = update.chatId;

    if (decision.action === 'reply') {
      await record(decision.disposition, decision.reason);
      await createStatusDelivery(tx, chatId, decision.text);
      return { disposition: decision.disposition, reason: decision.reason };
    }

    if (decision.action === 'result') {
      await record('RESULT_REQUESTED', null, decision.runId);
      await this.queueResult(tx, decision.runId, update.senderId, chatId);
      return { disposition: 'RESULT_REQUESTED', reason: null, runId: decision.runId };
    }

    // Research admission: serialised so the queue bound holds under concurrency.
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(${ADMISSION_LOCK_KEY})`;
    const active = await tx.researchRun.count({ where: { state: { in: ['QUEUED', 'RUNNING'] } } });
    if (active >= this.config.RESEARCH_QUEUE_LIMIT) {
      await record('REJECTED', 'QUEUE_FULL');
      await createStatusDelivery(tx, chatId, messages.queueFull(this.config.RESEARCH_QUEUE_LIMIT));
      return { disposition: 'REJECTED', reason: 'QUEUE_FULL' };
    }
    const snapshot = snapshotRunConfig(this.config);
    if (!snapshot) throw new Error('research admission without research configuration');

    const runId = randomUUID();
    await record('RUN_ACCEPTED', null, runId);
    await tx.researchRun.create({
      data: {
        id: runId,
        requestedByTelegramUserId: update.senderId,
        chatId,
        sourceUpdateId: update.updateId,
        prompt: decision.prompt,
        providerKind: snapshot.providerKind,
        requestSnapshot: { config: { ...snapshot } },
      },
    });
    await createStatusDelivery(
      tx,
      chatId,
      messages.accepted(runId, snapshot.providerKind === 'fake'),
      runId,
    );
    return { disposition: 'RUN_ACCEPTED', reason: null, runId };
  }

  /** Explicit resend of a stored result. Never starts research. Owner-scoped lookup. */
  private async queueResult(
    tx: Tx,
    runId: string,
    senderId: bigint,
    chatId: bigint,
  ): Promise<void> {
    const run = await tx.researchRun.findFirst({
      where: { id: runId, requestedByTelegramUserId: senderId },
      select: { id: true, state: true, failureCode: true },
    });
    if (!run) {
      await createStatusDelivery(tx, chatId, messages.runNotFound);
      return;
    }
    if (run.state !== 'SUCCEEDED') {
      const text =
        run.state === 'QUEUED'
          ? messages.runQueued(run.id)
          : run.state === 'RUNNING'
            ? messages.runRunning(run.id)
            : run.state === 'UNCERTAIN'
              ? messages.runUncertain(run.id, run.failureCode ?? 'UNKNOWN')
              : messages.runFailed(run.id, run.failureCode ?? 'UNKNOWN');
      await createStatusDelivery(tx, chatId, text, run.id);
      return;
    }
    const report = await tx.delivery.findFirst({
      where: { runId: run.id, kind: 'REPORT' },
      select: { parts: { orderBy: { ordinal: 'asc' }, select: { html: true } } },
    });
    if (!report) throw new Error('succeeded run without report delivery');
    await createDelivery(tx, {
      kind: 'RESEND',
      chatId,
      runId: run.id,
      parts: report.parts.map((part) => part.html),
    });
  }
}
