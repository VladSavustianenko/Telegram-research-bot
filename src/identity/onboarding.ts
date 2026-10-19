import type { Tx } from '../database/prisma-errors';
import type { AppUser } from '../generated/prisma/client';
import { timeZoneCallbackData } from '../telegram/callback-data';
import type { InlineKeyboard } from '../telegram/telegram-sender';
import { SUGGESTED_TIME_ZONE } from './time-zone';

/**
 * Buttons that confirm a time zone for the user's current revision. The
 * proposed zone (if any) comes first, then the suggested default.
 */
export function timeZoneKeyboard(user: AppUser, proposed?: string): InlineKeyboard {
  const zones = [...new Set([proposed, SUGGESTED_TIME_ZONE].filter((z): z is string => !!z))];
  return {
    inline_keyboard: zones.map((zone) => [
      { text: `Підтвердити ${zone}`, callback_data: timeZoneCallbackData(user.revision, zone) },
    ]),
  };
}

/**
 * Completes onboarding with the confirmed zone. Conditional on the revision the
 * button was issued for, the onboarding state and ACTIVE status, so stale,
 * replayed or concurrent confirmations change nothing. Returns the updated user
 * or null.
 */
export async function confirmTimeZone(
  tx: Tx,
  user: AppUser,
  revision: number,
  zone: string,
): Promise<AppUser | null> {
  const updated = await tx.appUser.updateMany({
    where: {
      id: user.id,
      revision,
      status: 'ACTIVE',
      onboardingState: 'AWAITING_TIME_ZONE',
    },
    data: {
      timeZone: zone,
      onboardingState: 'COMPLETED',
      onboardedAt: new Date(),
      revision: { increment: 1 },
    },
  });
  if (updated.count !== 1) return null;
  return tx.appUser.findUniqueOrThrow({ where: { id: user.id } });
}
