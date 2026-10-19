/**
 * Inline-button payloads. Callback data is client-supplied: it never carries
 * user, run or owner IDs, and it is only a request about the sender's own
 * record. Format (at most 64 bytes, Telegram's limit):
 *   tz:<revision>:<zone>   confirm <zone> as the sender's time zone, valid only
 *                          while the sender's record still has <revision>
 */
const MAX_CALLBACK_BYTES = 64;
const TIME_ZONE_CALLBACK = /^tz:(0|[1-9]\d{0,8}):([A-Za-z][A-Za-z0-9_+\-/]{0,39})$/;

export type CallbackAction = { kind: 'confirm_time_zone'; revision: number; zone: string };

export function timeZoneCallbackData(revision: number, zone: string): string {
  const data = `tz:${revision}:${zone}`;
  if (Buffer.byteLength(data) > MAX_CALLBACK_BYTES || !TIME_ZONE_CALLBACK.test(data)) {
    throw new Error('time zone callback data out of bounds');
  }
  return data;
}

export function parseCallbackData(data: string | null): CallbackAction | null {
  if (data === null || Buffer.byteLength(data) > MAX_CALLBACK_BYTES) return null;
  const match = TIME_ZONE_CALLBACK.exec(data);
  if (!match) return null;
  return { kind: 'confirm_time_zone', revision: Number(match[1]), zone: match[2] ?? '' };
}
