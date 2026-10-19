import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import { createDelivery, createStatusDelivery } from '../delivery/delivery-records';
import { denialMessage, messages } from '../delivery/messages';
import { escapeHtml } from '../delivery/telegram-html';
import type { AppUser } from '../generated/prisma/client';
import { formatLocal } from '../research/request-builder';
import { adminOperationDenial } from './authorization';
import { INVITATION_TOKEN_PLACEHOLDER } from './invitation-token';
import { createInvitation } from './invitations';
import { reactivateUser, suspendUser } from './suspension';

const MAX_BIGINT = 9_223_372_036_854_775_807n;

export interface AdminOutcome {
  disposition: 'REPLIED' | 'REJECTED';
  reason: string;
}

/**
 * Minimal administrator commands (TRB-030):
 *   /admin                         administrator help
 *   /admin invite                  single-use invitation
 *   /admin suspend <Telegram ID>   suspend a member
 *   /admin reactivate <Telegram ID>
 * Authorization is checked here; a non-administrator gets the unknown-command
 * reply, so the command's existence is not disclosed.
 */
export async function runAdminCommand(
  tx: Tx,
  config: Env,
  input: { actor: AppUser | null; chatId: bigint; args: string },
): Promise<AdminOutcome> {
  const { actor, chatId } = input;
  const reply = async (disposition: AdminOutcome['disposition'], reason: string, text: string) => {
    await createStatusDelivery(tx, chatId, text);
    return { disposition, reason };
  };
  const denial = adminOperationDenial(actor, config);
  if (denial || !actor)
    return reply('REJECTED', denial ?? 'NOT_REGISTERED', denialMessage(denial ?? 'NOT_REGISTERED'));

  const [sub = '', target, ...extra] = input.args.split(/\s+/).filter(Boolean);
  switch (sub.toLowerCase()) {
    case '':
    case 'help':
      return reply('REPLIED', 'ADMIN_HELP', messages.adminHelp);
    case 'invite': {
      const invitation = await createInvitation(tx, config, actor);
      if (invitation === 'NOT_CONFIGURED') {
        return reply('REJECTED', 'INVITATIONS_NOT_CONFIGURED', messages.invitationsNotConfigured);
      }
      const zone = actor.timeZone ?? 'UTC';
      const link = config.TELEGRAM_BOT_USERNAME
        ? `https://t.me/${config.TELEGRAM_BOT_USERNAME}?start=${INVITATION_TOKEN_PLACEHOLDER}`
        : `/start ${INVITATION_TOKEN_PLACEHOLDER}`;
      const text = messages.invitationCreated(
        `${formatLocal(invitation.expiresAt, zone)} (${zone})`,
        link,
      );
      // The stored part holds the placeholder; the delivery worker derives the token at send time.
      await createDelivery(tx, {
        kind: 'INVITATION',
        chatId,
        invitationId: invitation.id,
        parts: [escapeHtml(text)],
      });
      return { disposition: 'REPLIED', reason: 'INVITATION_CREATED' };
    }
    case 'suspend':
    case 'reactivate': {
      const targetId = parseTelegramId(target);
      if (targetId === null || extra.length > 0) {
        return reply('REJECTED', 'ADMIN_USAGE', messages.adminTargetUsage);
      }
      const shown = targetId.toString();
      if (sub.toLowerCase() === 'suspend') {
        const result = await suspendUser(tx, config, actor, targetId);
        switch (result.result) {
          case 'DONE':
            return reply(
              'REPLIED',
              'USER_SUSPENDED',
              messages.adminSuspended(shown, result.cancelledRuns, result.runningRuns),
            );
          case 'NO_CHANGE':
            return reply('REPLIED', 'ALREADY_SUSPENDED', messages.adminAlreadySuspended(shown));
          case 'TARGET_IS_ADMIN':
            return reply('REJECTED', 'TARGET_IS_ADMIN', messages.adminTargetIsAdmin);
          case 'USER_NOT_FOUND':
            return reply('REJECTED', 'USER_NOT_FOUND', messages.adminUserNotFound);
        }
      }
      const result = await reactivateUser(tx, actor, targetId);
      switch (result.result) {
        case 'DONE':
          return reply('REPLIED', 'USER_REACTIVATED', messages.adminReactivated(shown));
        case 'NO_CHANGE':
          return reply('REPLIED', 'NOT_SUSPENDED', messages.adminNotSuspended(shown));
        default:
          return reply('REJECTED', 'USER_NOT_FOUND', messages.adminUserNotFound);
      }
    }
    default:
      return reply('REJECTED', 'ADMIN_USAGE', messages.adminHelp);
  }
}

function parseTelegramId(value: string | undefined): bigint | null {
  if (!value || !/^[1-9]\d{0,18}$/.test(value)) return null;
  const id = BigInt(value);
  return id <= MAX_BIGINT ? id : null;
}
