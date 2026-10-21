import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '../common/clock';
import { errorInfo } from '../common/error-info';
import { showUsage } from '../accounting/usage';
import { APP_CONFIG } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { isUniqueViolation, type Tx } from '../database/prisma-errors';
import { PrismaService } from '../database/prisma.service';
import { createStatusDelivery } from '../delivery/delivery-records';
import { messages } from '../delivery/messages';
import { restoreDestination } from '../delivery/destination';
import { resendFromHistory, showHistory, showRun } from '../delivery/history';
import { requestResultResend } from '../delivery/result-resend';
import type { AppUser } from '../generated/prisma/client';
import { runAdminCommand } from '../identity/admin-actions';
import { accountAccess, isAdministrator, mayRedeemInvitation } from '../identity/authorization';
import { redeemInvitation } from '../identity/invitations';
import { confirmTimeZone, timeZoneKeyboard } from '../identity/onboarding';
import { normalizeTimeZone } from '../identity/time-zone';
import { lockTelegramIdentity, resolveSender } from '../identity/users';
import { admitResearch } from '../research/admission';
import { codePointLength } from '../research/report';
import {
  cancelDraft,
  onDraftAction,
  onDraftText,
  onTaskAction,
  showTasks,
  startCreate,
  type TaskContext,
} from '../tasks/task-service';
import { parseCallbackData } from './callback-data';
import { TELEGRAM_SENDER, type InlineKeyboard, type TelegramSender } from './telegram-sender';
import { parseCommand, parseUpdate, type ParsedUpdate } from './update-parser';

type Disposition = 'RUN_ACCEPTED' | 'RESULT_REQUESTED' | 'REPLIED' | 'REJECTED' | 'IGNORED';

interface Outcome {
  disposition: Disposition;
  reason: string | null;
  runId?: string;
  /** Text for the best-effort callback acknowledgement (button presses only). */
  callbackAnswer?: string;
}

/** A private, non-bot update whose chat is the sender's own chat. */
type PrivateUpdate = Extract<ParsedUpdate, { kind: 'message' | 'callback' }>;

interface Context {
  tx: Tx;
  update: PrivateUpdate;
  user: AppUser | null;
}

export type IngressResult = 'processed' | 'duplicate' | 'invalid';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Chat-level filter, decided without database access. Only a non-bot sender
 * in their own private chat (chat ID equal to sender ID) is processed; group,
 * supergroup and channel updates are recorded as ignored and get no reply.
 */
export function chatRejection(update: Exclude<ParsedUpdate, { kind: 'invalid' }>): string | null {
  if (update.kind === 'ignored') return update.reason;
  if (update.chatType !== 'private') return 'NOT_PRIVATE_CHAT';
  if (update.chatId !== update.senderId) return 'CHAT_SENDER_MISMATCH';
  if (update.isBot) return 'BOT_SENDER';
  return null;
}

/**
 * Telegram inbox: deduplication, identity and command routing. Identity comes
 * only from the update's sender; the destination is the sender's own private
 * chat. Business actions are delegated to application services, which check
 * authorization themselves.
 */
@Injectable()
export class TelegramIngressService {
  private readonly logger = new Logger(TelegramIngressService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: Env,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(TELEGRAM_SENDER) private readonly sender: TelegramSender | null = null,
  ) {}

  /**
   * Records the update and every resulting business action in one transaction.
   * Returns only after commit, so a webhook acknowledgment implies durable
   * receipt. A replayed update_id is a no-op.
   */
  async handle(raw: unknown): Promise<IngressResult> {
    const update = parseUpdate(raw);
    if (update.kind === 'invalid') return 'invalid';

    let outcome: Outcome | null;
    try {
      outcome = await this.prisma.$transaction((tx) => this.process(tx, update));
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      outcome = null;
    }
    if (!outcome) {
      this.logger.log({
        message: 'Duplicate Telegram update ignored',
        updateId: update.updateId.toString(),
      });
      return 'duplicate';
    }
    this.logger.log({
      message: 'Telegram update processed',
      updateId: update.updateId.toString(),
      disposition: outcome.disposition,
      reason: outcome.reason,
      ...(outcome.runId ? { runId: outcome.runId } : {}),
    });
    if (update.kind === 'callback') this.answerCallback(update.callbackId, outcome.callbackAnswer);
    return 'processed';
  }

  /** Returns null for an update_id that was already recorded (replay). */
  private async process(
    tx: Tx,
    update: Exclude<ParsedUpdate, { kind: 'invalid' }>,
  ): Promise<Outcome | null> {
    // Deduplication first: a concurrent replay waits here for the first
    // transaction and then inserts nothing. No message text or payload is stored.
    const inserted = await tx.$queryRaw<{ updateId: bigint }[]>`
      INSERT INTO telegram_update (update_id, sender_telegram_id, chat_type, disposition, reason)
      VALUES (${update.updateId}, ${update.senderId}, ${update.chatType}, 'IGNORED', 'PROCESSING')
      ON CONFLICT (update_id) DO NOTHING
      RETURNING update_id AS "updateId"`;
    if (inserted.length === 0) return null;

    const outcome = await this.route(tx, update);
    await tx.telegramUpdate.update({
      where: { updateId: update.updateId },
      data: {
        disposition: outcome.disposition,
        reason: outcome.reason,
        runId: outcome.runId ?? null,
      },
    });
    return outcome;
  }

  private async route(
    tx: Tx,
    update: Exclude<ParsedUpdate, { kind: 'invalid' }>,
  ): Promise<Outcome> {
    const rejection = chatRejection(update);
    if (rejection || update.kind === 'ignored') {
      return { disposition: 'IGNORED', reason: rejection ?? 'IGNORED' };
    }
    // Transport checks passed: a supported update from a non-bot sender in their own
    // private chat. Durable evidence that the chat works (TRB-080), whatever the
    // business answer (onboarding, denial, unknown command) turns out to be.
    await tx.$executeRaw`
      UPDATE telegram_update SET private_chat_verified = true WHERE update_id = ${update.updateId}`;
    // One sender at a time; then load (and row-lock) the sender's record.
    await lockTelegramIdentity(tx, update.senderId);
    let user = await resolveSender(tx, this.config, update.senderId, update.chatId);
    // Writing to the bot proves the chat works again (TRB-080): the block is
    // cleared before any reply is created; paused tasks stay paused.
    if (user?.chatBlockedAt) user = await restoreDestination(tx, user);
    const context: Context = { tx, update, user };
    return update.kind === 'callback'
      ? this.onCallback(context, update.data)
      : this.onMessage(context, update.text);
  }

  private async onMessage(context: Context, text: string): Promise<Outcome> {
    const { tx, update, user } = context;
    const command = parseCommand(text);
    const access = accountAccess(user, this.config);

    if (access === 'SUSPENDED')
      return this.reply(context, 'REJECTED', 'SUSPENDED', messages.suspended);
    if (access === 'NONE' || !user) {
      if (command?.name === 'start' && command.args && mayRedeemInvitation(user, this.config)) {
        return this.redeem(context, command.args);
      }
      return this.reply(context, 'REJECTED', 'NOT_REGISTERED', messages.invitationRequired);
    }

    if (command?.name === 'admin') {
      return runAdminCommand(tx, this.config, {
        actor: user,
        chatId: update.chatId,
        args: command.args,
      });
    }

    if (access === 'ONBOARDING') {
      if (!command) return this.onTimeZoneText(context, user, text);
      const reason =
        command.name === 'start'
          ? command.args
            ? 'INVITATION_NOT_NEEDED'
            : 'ONBOARDING_PROMPT'
          : 'ONBOARDING_INCOMPLETE';
      const lead = command.name === 'start' ? null : messages.onboardingRequired;
      return this.promptTimeZone(context, user, reason, lead);
    }

    const help = this.helpFor(user);
    switch (command?.name) {
      case 'start':
        // Already registered: an invitation in the payload is not consumed.
        return command.args
          ? this.reply(
              context,
              'REPLIED',
              'INVITATION_NOT_NEEDED',
              `${messages.alreadyRegistered}\n\n${help}`,
            )
          : this.reply(context, 'REPLIED', 'HELP', help);
      case 'help':
        return this.reply(context, 'REPLIED', 'HELP', help);
      case 'usage':
        return showUsage(tx, this.config, { user, chatId: update.chatId, now: this.clock.now() });
      case 'tasks':
        return showTasks(this.taskContext(context, user));
      case 'history':
        return showHistory(this.taskContext(context, user), 'all');
      case 'new':
        return startCreate(this.taskContext(context, user));
      case 'cancel':
        return cancelDraft(this.taskContext(context, user));
      case 'research': {
        if (this.config.RESEARCH_MODE === 'disabled') {
          return this.reply(context, 'REPLIED', 'RESEARCH_DISABLED', messages.researchDisabled);
        }
        if (!command.args)
          return this.reply(context, 'REPLIED', 'EMPTY_PROMPT', messages.emptyPrompt);
        if (codePointLength(command.args) > this.config.RESEARCH_PROMPT_MAX_CHARS) {
          return this.reply(
            context,
            'REPLIED',
            'PROMPT_TOO_LONG',
            messages.promptTooLong(this.config.RESEARCH_PROMPT_MAX_CHARS),
          );
        }
        return admitResearch(tx, this.config, {
          user,
          chatId: update.chatId,
          updateId: update.updateId,
          now: this.clock.now(),
          source: { kind: 'prompt', prompt: command.args },
        });
      }
      case 'result':
        if (!UUID.test(command.args)) {
          return this.reply(context, 'REPLIED', 'RESULT_USAGE', messages.resultUsage);
        }
        return requestResultResend(tx, this.config, {
          user,
          runId: command.args.toLowerCase(),
          chatId: update.chatId,
        });
      case undefined:
        // Commands are routed first; free text is a value only for an open draft.
        return (
          (await onDraftText(this.taskContext(context, user), text)) ??
          this.reply(context, 'REPLIED', 'NOT_A_COMMAND', help)
        );
      default:
        return this.reply(context, 'REPLIED', 'UNKNOWN_COMMAND', messages.unknownCommand);
    }
  }

  /** Invitation redemption by a sender without an account (checked by the caller). */
  private async redeem(context: Context, payload: string): Promise<Outcome> {
    const { tx, update } = context;
    const redemption = await redeemInvitation(tx, {
      payload,
      telegramUserId: update.senderId,
      privateChatId: update.chatId,
      existing: context.user,
    });
    if (!redemption.ok) {
      return this.reply(context, 'REJECTED', 'INVITATION_INVALID', messages.invitationInvalid);
    }
    const { user, createdBy } = redemption;
    await createStatusDelivery(
      tx,
      createdBy.privateChatId ?? createdBy.telegramUserId,
      messages.invitationRedeemedNotice(user.telegramUserId.toString()),
    );
    if (user.onboardingState === 'COMPLETED') {
      return this.reply(
        context,
        'REPLIED',
        'INVITATION_REDEEMED',
        `${messages.welcome}\n\n${this.helpFor(user)}`,
      );
    }
    return this.promptTimeZone(context, user, 'INVITATION_REDEEMED', messages.welcome);
  }

  /** Free text while onboarding is a proposed time zone; it is confirmed by a button. */
  private onTimeZoneText(context: Context, user: AppUser, text: string): Promise<Outcome> {
    const zone = normalizeTimeZone(text);
    if (!zone) {
      return this.reply(
        context,
        'REJECTED',
        'TIME_ZONE_INVALID',
        messages.timeZoneInvalid,
        timeZoneKeyboard(user),
      );
    }
    return this.reply(
      context,
      'REPLIED',
      'TIME_ZONE_PROPOSED',
      messages.timeZoneQuestion(zone),
      timeZoneKeyboard(user, zone),
    );
  }

  private promptTimeZone(
    context: Context,
    user: AppUser,
    reason: string,
    lead: string | null,
  ): Promise<Outcome> {
    const text = lead ? `${lead}\n\n${messages.timeZonePrompt}` : messages.timeZonePrompt;
    const disposition = reason === 'ONBOARDING_INCOMPLETE' ? 'REJECTED' : 'REPLIED';
    return this.reply(context, disposition, reason, text, timeZoneKeyboard(user));
  }

  /**
   * Button presses act only on the sender's own record. Stale buttons (an older
   * revision), replays and presses after completion change nothing.
   */
  private async onCallback(context: Context, data: string | null): Promise<Outcome> {
    const { tx, update, user } = context;
    const action = parseCallbackData(data);
    if (!action) {
      return {
        disposition: 'IGNORED',
        reason: 'CALLBACK_UNKNOWN',
        callbackAnswer: messages.staleButton,
      };
    }
    const access = accountAccess(user, this.config);
    if (access === 'NONE' || !user) {
      return {
        disposition: 'REJECTED',
        reason: 'NOT_REGISTERED',
        callbackAnswer: messages.invitationRequired,
      };
    }
    if (access === 'SUSPENDED') {
      return { disposition: 'REJECTED', reason: 'SUSPENDED', callbackAnswer: messages.suspended };
    }
    if (action.kind !== 'confirm_time_zone') {
      // Task and draft buttons need a completed account; services recheck access.
      if (access !== 'ACTIVE') {
        return {
          disposition: 'REJECTED',
          reason: 'ONBOARDING_INCOMPLETE',
          callbackAnswer: messages.onboardingRequired,
        };
      }
      const tasks = this.taskContext(context, user);
      switch (action.kind) {
        case 'draft':
          return onDraftAction(tasks, action.draftId, action.version, action.op);
        case 'task':
          return onTaskAction(tasks, action.taskId, action.revision, action.op);
        case 'task_list':
          return showTasks(tasks, action.page);
        case 'task_new':
          return startCreate(tasks);
        case 'history':
          return showHistory(tasks, action.scope, action.cursor);
        case 'run':
          return showRun(tasks, action.runId, action.scope);
        case 'resend':
          return resendFromHistory(tasks, action.runId);
      }
    }
    if (access === 'ACTIVE') {
      return {
        disposition: 'IGNORED',
        reason: 'TIME_ZONE_ALREADY_CONFIRMED',
        callbackAnswer: messages.timeZoneAlreadyConfirmed(user.timeZone ?? ''),
      };
    }
    const zone = normalizeTimeZone(action.zone);
    if (action.revision !== user.revision || !zone) {
      return {
        disposition: 'IGNORED',
        reason: zone ? 'CALLBACK_STALE' : 'TIME_ZONE_INVALID',
        callbackAnswer: messages.staleButton,
      };
    }
    const confirmed = await confirmTimeZone(tx, user, action.revision, zone);
    if (!confirmed) {
      return {
        disposition: 'IGNORED',
        reason: 'CALLBACK_STALE',
        callbackAnswer: messages.staleButton,
      };
    }
    await createStatusDelivery(
      tx,
      update.chatId,
      `${messages.timeZoneConfirmed(zone)}\n\n${this.helpFor(confirmed)}`,
    );
    return {
      disposition: 'REPLIED',
      reason: 'TIME_ZONE_CONFIRMED',
      callbackAnswer: messages.timeZoneConfirmed(zone),
    };
  }

  private async reply(
    context: Context,
    disposition: Disposition,
    reason: string,
    text: string,
    replyMarkup?: InlineKeyboard,
  ): Promise<Outcome> {
    await createStatusDelivery(context.tx, context.update.chatId, text, undefined, replyMarkup);
    return { disposition, reason };
  }

  private taskContext(context: Context, user: AppUser): TaskContext {
    return {
      tx: context.tx,
      config: this.config,
      user,
      chatId: context.update.chatId,
      updateId: context.update.updateId,
      now: this.clock.now(),
    };
  }

  private helpFor(user: AppUser): string {
    return isAdministrator(user, this.config)
      ? `${messages.help}\n\n${messages.adminHelp}`
      : messages.help;
  }

  /** Best-effort, after commit: a failure only leaves the client's spinner running. */
  private answerCallback(callbackId: string, text: string | undefined): void {
    if (!this.sender) return;
    this.sender.answerCallback(callbackId, text).catch((error: unknown) => {
      this.logger.warn({ message: 'Callback acknowledgement failed', ...errorInfo(error) });
    });
  }
}
