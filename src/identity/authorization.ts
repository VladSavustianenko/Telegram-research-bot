import type { Env } from '../config/env.schema';
import type { ProviderKind } from '../research/provider/provider.types';

/**
 * Central authorization rules (TRB-030). Pure functions over the user record
 * loaded for the authenticated Telegram sender; every entry point (commands,
 * callbacks, admission, execution, admin operations) uses them. Nothing here
 * trusts IDs from message text or callback data.
 */
export interface UserAccessView {
  id: string;
  telegramUserId: bigint;
  role: 'ADMIN' | 'MEMBER';
  status: 'ACTIVE' | 'SUSPENDED';
  onboardingState: 'AWAITING_TIME_ZONE' | 'COMPLETED';
  timeZone: string | null;
  revision: number;
  invitedAt: Date | null;
}

/**
 * NONE: no account (unknown, or an administrator removed from ADMIN_TELEGRAM_IDS
 * who never redeemed an invitation). SUSPENDED wins over everything else.
 */
export type AccountAccess = 'NONE' | 'SUSPENDED' | 'ONBOARDING' | 'ACTIVE';

export type Denial =
  'NOT_REGISTERED' | 'SUSPENDED' | 'ONBOARDING_INCOMPLETE' | 'NOT_ADMIN' | 'LIVE_ADMIN_ONLY';

/** ADMIN_TELEGRAM_IDS is authoritative for the administrator role. */
export function isConfiguredAdmin(config: Env, telegramUserId: bigint): boolean {
  return (config.ADMIN_TELEGRAM_IDS ?? []).includes(telegramUserId.toString());
}

/** Requires both the configuration and the synchronized database role. */
export function isAdministrator(user: UserAccessView | null, config: Env): boolean {
  return user !== null && user.role === 'ADMIN' && isConfiguredAdmin(config, user.telegramUserId);
}

export function accountAccess(user: UserAccessView | null, config: Env): AccountAccess {
  if (!user) return 'NONE';
  if (user.status === 'SUSPENDED') return 'SUSPENDED';
  if (!isAdministrator(user, config) && user.invitedAt === null) return 'NONE';
  return user.onboardingState === 'COMPLETED' ? 'ACTIVE' : 'ONBOARDING';
}

/** Protected user operations (research, stored results): active accounts with completed onboarding. */
export function userOperationDenial(user: UserAccessView | null, config: Env): Denial | null {
  switch (accountAccess(user, config)) {
    case 'NONE':
      return 'NOT_REGISTERED';
    case 'SUSPENDED':
      return 'SUSPENDED';
    case 'ONBOARDING':
      return 'ONBOARDING_INCOMPLETE';
    case 'ACTIVE':
      return null;
  }
}

/**
 * Admission of a research run. Live (paid) research stays administrator-only
 * until TRB-050 budget reservations are accepted; a refused live request is
 * never replaced by simulated research.
 */
export function researchAdmissionDenial(
  user: UserAccessView | null,
  providerKind: ProviderKind,
  config: Env,
): Denial | null {
  const denial = userOperationDenial(user, config);
  if (denial) return denial;
  if (providerKind === 'openai' && !isAdministrator(user, config)) return 'LIVE_ADMIN_ONLY';
  return null;
}

/** Administrator operations need an active configured administrator (onboarding not required). */
export function adminOperationDenial(user: UserAccessView | null, config: Env): Denial | null {
  const access = accountAccess(user, config);
  if (access === 'SUSPENDED') return 'SUSPENDED';
  if (access === 'NONE') return 'NOT_REGISTERED';
  return isAdministrator(user, config) ? null : 'NOT_ADMIN';
}

/** Only senders without an account may redeem; members, administrators and suspended users may not. */
export function mayRedeemInvitation(user: UserAccessView | null, config: Env): boolean {
  return accountAccess(user, config) === 'NONE';
}

/**
 * Delivery of run-related messages (reports, explicit resends, run status
 * notices), rechecked before each part with the current configuration. Returns
 * the suppression code, or null. Replies that are not about a run (help,
 * invitation-required, onboarding prompts) are not subject to this rule.
 * Only account access counts: losing the administrator role does not hide the
 * saved reports of a user who is still a member, and onboarding is not required.
 */
export function runDeliveryDenial(owner: UserAccessView | null, config: Env): string | null {
  if (!owner) return 'OWNER_UNRESOLVED';
  const access = accountAccess(owner, config);
  if (access === 'SUSPENDED') return 'RECIPIENT_SUSPENDED';
  if (access === 'NONE') return 'ACCESS_REVOKED';
  return null;
}

/**
 * Execution-time recheck before a new provider submission. Returns the
 * cancellation code, or null when submission may proceed. Onboarding is an
 * admission gate only; it is not rechecked here.
 */
export function submissionDenial(
  owner: UserAccessView | null,
  providerKind: ProviderKind,
  config: Env,
): string | null {
  if (!owner) return 'OWNER_UNRESOLVED';
  const access = accountAccess(owner, config);
  if (access === 'SUSPENDED') return 'USER_SUSPENDED';
  if (access === 'NONE') return 'ACCESS_REVOKED';
  if (providerKind === 'openai' && !isAdministrator(owner, config)) return 'LIVE_NOT_PERMITTED';
  return null;
}
