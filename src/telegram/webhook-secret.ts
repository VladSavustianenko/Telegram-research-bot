import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison of the X-Telegram-Bot-Api-Secret-Token header. */
export function webhookSecretMatches(received: unknown, expected: string | undefined): boolean {
  if (!expected || typeof received !== 'string' || received.length === 0) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}
