import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Constant-time comparison of the X-Telegram-Bot-Api-Secret-Token header.
 * `previous` (TELEGRAM_WEBHOOK_SECRET_PREVIOUS) is accepted as well during a
 * secret rotation (docs/OPERATIONS.md); both comparisons always run.
 */
export function webhookSecretMatches(
  received: unknown,
  expected: string | undefined,
  previous?: string,
): boolean {
  if (!expected || typeof received !== 'string' || received.length === 0) return false;
  const actual = digest(received);
  const current = timingSafeEqual(actual, digest(expected));
  const rotated = timingSafeEqual(actual, digest(previous ?? expected));
  return current || (previous !== undefined && rotated);
}
