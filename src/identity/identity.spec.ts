import { describe, expect, it } from 'vitest';
import { parseEnv } from '../config/env.schema';
import {
  accountAccess,
  adminOperationDenial,
  isAdministrator,
  mayRedeemInvitation,
  researchAdmissionDenial,
  submissionDenial,
  userOperationDenial,
  type UserAccessView,
} from './authorization';
import {
  deriveInvitationToken,
  hashInvitationToken,
  isWellFormedInvitationToken,
} from './invitation-token';
import { normalizeTimeZone } from './time-zone';

const config = parseEnv({
  DATABASE_URL: 'postgresql://u:p@localhost:5434/db',
  ADMIN_TELEGRAM_IDS: '1001',
});

const user = (overrides: Partial<UserAccessView> = {}): UserAccessView => ({
  id: 'u',
  telegramUserId: 2002n,
  role: 'MEMBER',
  status: 'ACTIVE',
  onboardingState: 'COMPLETED',
  timeZone: 'Europe/Kyiv',
  revision: 1,
  invitedAt: new Date(),
  ...overrides,
});
const admin = (overrides: Partial<UserAccessView> = {}) =>
  user({ telegramUserId: 1001n, role: 'ADMIN', invitedAt: null, ...overrides });

describe('authorization rules', () => {
  it('derives account access with suspension taking precedence', () => {
    expect(accountAccess(null, config)).toBe('NONE');
    expect(accountAccess(user(), config)).toBe('ACTIVE');
    expect(accountAccess(user({ onboardingState: 'AWAITING_TIME_ZONE' }), config)).toBe(
      'ONBOARDING',
    );
    expect(accountAccess(user({ status: 'SUSPENDED' }), config)).toBe('SUSPENDED');
    expect(accountAccess(admin({ status: 'SUSPENDED' }), config)).toBe('SUSPENDED');
    // A member record without a redeemed invitation has no account.
    expect(accountAccess(user({ invitedAt: null }), config)).toBe('NONE');
  });

  it('requires both the configuration and the stored role for administrators', () => {
    expect(isAdministrator(admin(), config)).toBe(true);
    // Removed from ADMIN_TELEGRAM_IDS but the stored role was not yet synchronized.
    expect(isAdministrator(admin({ telegramUserId: 3003n }), config)).toBe(false);
    // Configured, but the stored role says MEMBER (not yet synchronized).
    expect(isAdministrator(user({ telegramUserId: 1001n }), config)).toBe(false);
    expect(accountAccess(admin({ telegramUserId: 3003n }), config)).toBe('NONE');
  });

  it('gates user, admin and research operations', () => {
    expect(userOperationDenial(null, config)).toBe('NOT_REGISTERED');
    expect(userOperationDenial(user({ status: 'SUSPENDED' }), config)).toBe('SUSPENDED');
    expect(userOperationDenial(user({ onboardingState: 'AWAITING_TIME_ZONE' }), config)).toBe(
      'ONBOARDING_INCOMPLETE',
    );
    expect(adminOperationDenial(user(), config)).toBe('NOT_ADMIN');
    expect(adminOperationDenial(admin({ onboardingState: 'AWAITING_TIME_ZONE' }), config)).toBe(
      null,
    );
    expect(researchAdmissionDenial(user(), 'fake', config)).toBeNull();
    expect(researchAdmissionDenial(user(), 'openai', config)).toBe('LIVE_ADMIN_ONLY');
    expect(researchAdmissionDenial(admin(), 'openai', config)).toBeNull();
  });

  it('lets only senders without an account redeem invitations', () => {
    expect(mayRedeemInvitation(null, config)).toBe(true);
    expect(mayRedeemInvitation(user({ invitedAt: null }), config)).toBe(true);
    expect(mayRedeemInvitation(user(), config)).toBe(false);
    expect(mayRedeemInvitation(user({ onboardingState: 'AWAITING_TIME_ZONE' }), config)).toBe(
      false,
    );
    expect(mayRedeemInvitation(user({ status: 'SUSPENDED', invitedAt: null }), config)).toBe(false);
    expect(mayRedeemInvitation(admin(), config)).toBe(false);
  });

  it('rechecks eligibility before submission', () => {
    expect(submissionDenial(null, 'fake', config)).toBe('OWNER_UNRESOLVED');
    expect(submissionDenial(user({ status: 'SUSPENDED' }), 'fake', config)).toBe('USER_SUSPENDED');
    expect(submissionDenial(user({ invitedAt: null }), 'fake', config)).toBe('ACCESS_REVOKED');
    expect(submissionDenial(user(), 'openai', config)).toBe('LIVE_NOT_PERMITTED');
    expect(submissionDenial(admin({ telegramUserId: 3003n }), 'openai', config)).toBe(
      'ACCESS_REVOKED',
    );
    expect(submissionDenial(user(), 'fake', config)).toBeNull();
    expect(submissionDenial(admin(), 'openai', config)).toBeNull();
  });
});

describe('normalizeTimeZone', () => {
  it.each([
    ['Europe/Kyiv', 'Europe/Kyiv'],
    ['  europe/kyiv ', 'Europe/Kyiv'],
    ['America/New_York', 'America/New_York'],
    ['america/argentina/buenos_aires', 'America/Argentina/Buenos_Aires'],
    ['Europe/Kiev', 'Europe/Kiev'],
    ['utc', 'UTC'],
  ])('accepts %j', (input, expected) => {
    expect(normalizeTimeZone(input)).toBe(expected);
  });

  it.each([
    '',
    'Kyiv',
    'EST',
    'est5edt',
    '+03:00',
    'GMT+3',
    'Mars/Olympus',
    'Europe/Kyiv; DROP',
    `Europe/${'a'.repeat(40)}`,
  ])('rejects %j', (input) => {
    expect(normalizeTimeZone(input)).toBeNull();
  });
});

describe('invitation tokens', () => {
  const secret = 'x'.repeat(32);

  it('derives distinct deep-link-safe tokens and stores only a digest', () => {
    const a = deriveInvitationToken(secret, '11111111-2222-4333-8444-555555555555');
    const b = deriveInvitationToken(secret, '11111111-2222-4333-8444-555555555556');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedInvitationToken(a)).toBe(true);
    expect(hashInvitationToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInvitationToken(a)).not.toContain(a);
    expect(deriveInvitationToken('y'.repeat(32), '11111111-2222-4333-8444-555555555555')).not.toBe(
      a,
    );
  });

  it.each(['', 'short', `${'A'.repeat(43)}=`, `${'A'.repeat(42)}!`])(
    'rejects malformed payload %j',
    (payload) => {
      expect(isWellFormedInvitationToken(payload)).toBe(false);
    },
  );
});
