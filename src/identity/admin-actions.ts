import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import { createDelivery, createStatusDelivery } from '../delivery/delivery-records';
import { denialMessage, messages } from '../delivery/messages';
import { escapeHtml } from '../delivery/telegram-html';
import type { AppUser } from '../generated/prisma/client';
import { formatLocal } from '../research/request-builder';
import { adminOperationDenial } from './authorization';
import { INVITATION_TOKEN_PLACEHOLDER } from './invitation-token';
import {
  adminAuditView,
  adminInvitesView,
  adminUsageView,
  adminUserView,
  adminUsersView,
  revokeInvitation,
  setLimitOverride,
  type AdminView,
} from './admin-views';
import { createInvitation } from './invitations';
import { reactivateUser, suspendUser } from './suspension';

const MAX_BIGINT = 9_223_372_036_854_775_807n;

export interface AdminOutcome {
  disposition: 'REPLIED' | 'REJECTED' | 'IGNORED';
  reason: string;
  callbackAnswer?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function show(
  tx: Tx,
  chatId: bigint,
  reason: string,
  view: AdminView,
): Promise<AdminOutcome> {
  await createStatusDelivery(tx, chatId, view.text, undefined, view.keyboard);
  return { disposition: 'REPLIED', reason };
}

/**
 * Minimal administrator commands (TRB-030):
 *   /admin                         administrator help
 *   /admin invite                  single-use invitation
 *   /admin suspend <Telegram ID>   suspend a member
 *   /admin reactivate <Telegram ID>
 * TRB-090 (docs/ADMINISTRATION.md):
 *   /admin users [page]            user list (metadata only)
 *   /admin user <Telegram ID>      one user: access, counts, accounting, effective limits
 *   /admin limit <Telegram ID> <name> <value|default> [reason]
 *   /admin usage                   current UTC period: exposure, failures, open cases
 *   /admin invites                 invitations; /admin revoke <invitation ID>
 *   /admin audit [page]            audit events
 * Authorization is checked here; a non-administrator gets the unknown-command
 * reply, so the command's existence is not disclosed.
 */
export async function runAdminCommand(
  tx: Tx,
  config: Env,
  input: { actor: AppUser | null; chatId: bigint; args: string; now?: Date },
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
  const now = input.now ?? new Date();
  switch (sub.toLowerCase()) {
    case 'users': {
      const page = target && /^[1-9]\d{0,3}$/.test(target) ? Number(target) - 1 : 0;
      return show(tx, chatId, 'ADMIN_USERS', await adminUsersView(tx, config, now, page));
    }
    case 'user': {
      const targetId = parseTelegramId(target);
      if (targetId === null || extra.length > 0) {
        return reply('REJECTED', 'ADMIN_USAGE', messages.adminTargetUsage);
      }
      const user = await tx.appUser.findUnique({ where: { telegramUserId: targetId } });
      if (!user) return reply('REJECTED', 'USER_NOT_FOUND', messages.adminUserNotFound);
      return show(tx, chatId, 'ADMIN_USER', await adminUserView(tx, config, now, user));
    }
    case 'limit': {
      const targetId = parseTelegramId(target);
      const [limit, value, ...reason] = extra;
      if (targetId === null || !limit || !value) {
        return reply('REJECTED', 'ADMIN_USAGE', messages.adminLimitUsage);
      }
      const change = await setLimitOverride(tx, config, actor, {
        targetTelegramId: targetId,
        limit,
        value,
        reason: reason.join(' '),
      });
      switch (change.result) {
        case 'USER_NOT_FOUND':
          return reply('REJECTED', 'USER_NOT_FOUND', messages.adminUserNotFound);
        case 'UNKNOWN_LIMIT':
        case 'INVALID_VALUE':
          return reply('REJECTED', change.result, messages.adminLimitUsage);
        default:
          return show(
            tx,
            chatId,
            change.result === 'CHANGED' ? 'LIMIT_CHANGED' : 'LIMIT_UNCHANGED',
            await adminUserView(
              tx,
              config,
              now,
              change.target,
              change.result === 'CHANGED' ? 'Ліміт змінено.' : 'Ліміт уже має це значення.',
            ),
          );
      }
    }
    case 'usage':
      return show(tx, chatId, 'ADMIN_USAGE_VIEW', await adminUsageView(tx, config, now));
    case 'invites':
      return show(tx, chatId, 'ADMIN_INVITES', await adminInvitesView(tx, now));
    case 'revoke': {
      if (!target || !UUID.test(target) || extra.length > 0) {
        return reply('REJECTED', 'ADMIN_USAGE', messages.adminRevokeUsage);
      }
      const result = await revokeInvitation(tx, actor, target.toLowerCase());
      return reply(
        result === 'REVOKED' ? 'REPLIED' : 'REJECTED',
        result === 'REVOKED' ? 'INVITATION_REVOKED' : `INVITATION_${result}`,
        result === 'REVOKED' ? messages.invitationRevoked : messages.invitationNotRevocable,
      );
    }
    case 'audit': {
      const page = target && /^[1-9]\d{0,3}$/.test(target) ? Number(target) - 1 : 0;
      return show(tx, chatId, 'ADMIN_AUDIT', await adminAuditView(tx, page));
    }
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

/**
 * Administrator buttons (TRB-090). Authorized here like the commands. A button
 * acts on a user by internal ID and is bound to the user's revision: after any
 * change (suspension, reactivation, limit change) an old button only shows the
 * current view. Unknown IDs answer like a stale button.
 */
export async function runAdminCallback(
  tx: Tx,
  config: Env,
  input: {
    actor: AppUser | null;
    chatId: bigint;
    now: Date;
    action:
      | { kind: 'admin_users'; page: number }
      | { kind: 'admin_user'; userId: string }
      | { kind: 'admin_access'; userId: string; revision: number; op: 'suspend' | 'reactivate' };
  },
): Promise<AdminOutcome> {
  const { actor, chatId, action, now } = input;
  const denial = adminOperationDenial(actor, config);
  if (denial || !actor) {
    // Not disclosed: the same answer as an unknown button.
    return {
      disposition: 'REJECTED',
      reason: denial ?? 'NOT_REGISTERED',
      callbackAnswer: messages.staleButton,
    };
  }
  if (action.kind === 'admin_users') {
    return show(tx, chatId, 'ADMIN_USERS', await adminUsersView(tx, config, now, action.page));
  }
  const target = await tx.appUser.findUnique({ where: { id: action.userId } });
  if (!target) {
    return {
      disposition: 'IGNORED',
      reason: 'CALLBACK_STALE',
      callbackAnswer: messages.staleButton,
    };
  }
  if (action.kind === 'admin_user') {
    return show(tx, chatId, 'ADMIN_USER', await adminUserView(tx, config, now, target));
  }
  if (target.revision !== action.revision) {
    const outcome = await show(
      tx,
      chatId,
      'CALLBACK_STALE',
      await adminUserView(tx, config, now, target, 'Дані змінилися; ось актуальний стан.'),
    );
    return { ...outcome, disposition: 'IGNORED', callbackAnswer: messages.staleButton };
  }
  const shown = target.telegramUserId.toString();
  let notice: string;
  let reason: string;
  if (action.op === 'suspend') {
    const result = await suspendUser(tx, config, actor, target.telegramUserId);
    reason = result.result === 'DONE' ? 'USER_SUSPENDED' : result.result;
    notice =
      result.result === 'DONE'
        ? messages.adminSuspended(shown, result.cancelledRuns, result.runningRuns)
        : result.result === 'TARGET_IS_ADMIN'
          ? messages.adminTargetIsAdmin
          : messages.adminAlreadySuspended(shown);
  } else {
    const result = await reactivateUser(tx, actor, target.telegramUserId);
    reason = result.result === 'DONE' ? 'USER_REACTIVATED' : result.result;
    notice =
      result.result === 'DONE'
        ? messages.adminReactivated(shown)
        : messages.adminNotSuspended(shown);
  }
  const current = await tx.appUser.findUniqueOrThrow({ where: { id: target.id } });
  const outcome = await show(
    tx,
    chatId,
    reason,
    await adminUserView(tx, config, now, current, notice),
  );
  return { ...outcome, disposition: reason === 'TARGET_IS_ADMIN' ? 'REJECTED' : 'REPLIED' };
}
