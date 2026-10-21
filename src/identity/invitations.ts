import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import type { AppUser } from '../generated/prisma/client';
import { recordAudit } from './audit';
import {
  deriveInvitationToken,
  hashInvitationToken,
  isWellFormedInvitationToken,
} from './invitation-token';
import { linkRunsByTelegramIdentity } from './users';

export interface CreatedInvitation {
  id: string;
  expiresAt: Date;
}

/**
 * Creates a single-use invitation. The caller must have authorized the
 * administrator (adminOperationDenial). Expiry uses database time.
 */
export async function createInvitation(
  tx: Tx,
  config: Env,
  admin: AppUser,
): Promise<CreatedInvitation | 'NOT_CONFIGURED'> {
  const secret = config.INVITATION_TOKEN_SECRET;
  if (!secret) return 'NOT_CONFIGURED';
  const id = randomUUID();
  const tokenHash = hashInvitationToken(deriveInvitationToken(secret, id));
  const rows = await tx.$queryRaw<{ expiresAt: Date }[]>`
    INSERT INTO invitation (id, token_hash, created_by_user_id, expires_at)
    VALUES (${id}::uuid, ${tokenHash}, ${admin.id}::uuid,
            now() + make_interval(hours => ${config.INVITATION_TTL_HOURS}::int))
    RETURNING expires_at AS "expiresAt"`;
  const expiresAt = rows[0]?.expiresAt;
  if (!expiresAt) throw new Error('invitation not created');
  await recordAudit(tx, {
    kind: 'INVITATION_CREATED',
    actorUserId: admin.id,
    invitationId: id,
    details: { ttlHours: config.INVITATION_TTL_HOURS },
  });
  return { id, expiresAt };
}

export type Redemption =
  | { ok: true; user: AppUser; createdBy: { telegramUserId: bigint; privateChatId: bigint | null } }
  | { ok: false };

/**
 * Atomically consumes an invitation for the authenticated sender. The caller
 * holds the sender's identity lock and has checked mayRedeemInvitation
 * (no account; not suspended). Invalid, expired and consumed invitations are
 * indistinguishable to the caller.
 *
 * Concurrency: the invitation row is locked with FOR UPDATE under its
 * "unredeemed and unexpired" condition. A concurrent redeemer waits, and after
 * the winner commits PostgreSQL re-evaluates the condition on the new row
 * version, so it gets no row: exactly one redemption succeeds.
 */
export async function redeemInvitation(
  tx: Tx,
  input: {
    payload: string;
    telegramUserId: bigint;
    privateChatId: bigint;
    existing: AppUser | null;
  },
): Promise<Redemption> {
  if (!isWellFormedInvitationToken(input.payload)) return { ok: false };
  const tokenHash = hashInvitationToken(input.payload);
  const [invitation] = await tx.$queryRaw<{ id: string; createdByUserId: string }[]>`
    SELECT id, created_by_user_id AS "createdByUserId" FROM invitation
     WHERE token_hash = ${tokenHash} AND redeemed_at IS NULL AND revoked_at IS NULL
       AND expires_at > now()
     FOR UPDATE`;
  if (!invitation) return { ok: false };

  const now = new Date();
  // An existing record without access (an administrator removed from the
  // configuration) becomes a member; its onboarding progress is kept.
  const user = input.existing
    ? await tx.appUser.update({
        where: { id: input.existing.id },
        data: { invitedAt: now, privateChatId: input.privateChatId, revision: { increment: 1 } },
      })
    : await tx.appUser.create({
        data: {
          telegramUserId: input.telegramUserId,
          privateChatId: input.privateChatId,
          role: 'MEMBER',
          invitedAt: now,
        },
      });
  await tx.$executeRaw`
    UPDATE invitation SET redeemed_at = now(), redeemed_by_user_id = ${user.id}::uuid
     WHERE id = ${invitation.id}::uuid`;
  const linkedRuns = await linkRunsByTelegramIdentity(tx, user.id, user.telegramUserId);
  await recordAudit(tx, {
    kind: 'INVITATION_REDEEMED',
    actorUserId: user.id,
    subjectUserId: user.id,
    invitationId: invitation.id,
    details: { existingRecord: input.existing !== null, linkedRuns },
  });
  const createdBy = await tx.appUser.findUniqueOrThrow({
    where: { id: invitation.createdByUserId },
    select: { telegramUserId: true, privateChatId: true },
  });
  return { ok: true, user, createdBy };
}
