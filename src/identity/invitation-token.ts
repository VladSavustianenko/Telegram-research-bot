import { createHash, createHmac } from 'node:crypto';

/**
 * Invitation tokens (SPEC §2: random, single-use, stored only as a hash).
 *
 * token = base64url(HMAC-SHA256(INVITATION_TOKEN_SECRET, "trb-invitation-v1:" + id))
 *
 * `id` is a random UUID (crypto.randomUUID), so the token is unpredictable
 * without the secret. The database stores SHA-256(token) only. The message
 * that carries the link stores a placeholder and the delivery worker derives
 * the token at send time, so no table (telegram_update, delivery_part,
 * audit_event, invitation) ever contains a usable token.
 *
 * 43 characters of [A-Za-z0-9_-]: valid as a Telegram /start deep-link payload
 * (at most 64 such characters).
 */
export const INVITATION_TOKEN_PLACEHOLDER = '{{INVITATION_TOKEN}}';

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function deriveInvitationToken(secret: string, invitationId: string): string {
  return createHmac('sha256', secret)
    .update(`trb-invitation-v1:${invitationId}`)
    .digest('base64url');
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Cheap shape check before any database lookup; malformed payloads are simply invalid. */
export function isWellFormedInvitationToken(payload: string): boolean {
  return TOKEN_SHAPE.test(payload);
}
