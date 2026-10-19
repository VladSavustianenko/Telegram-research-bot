import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import type { PrismaService } from '../database/prisma.service';
import type { AppUser } from '../generated/prisma/client';
import { recordAudit } from './audit';
import { isConfiguredAdmin } from './authorization';

/** Advisory lock class serialising all updates of one Telegram identity (two-key form). */
const IDENTITY_LOCK_CLASS = 30_030;

/**
 * Serialises conversation changes per Telegram user (ARCHITECTURE §1),
 * including redemption by a sender who has no user record yet.
 */
export async function lockTelegramIdentity(tx: Tx, telegramUserId: bigint): Promise<void> {
  await tx.$queryRaw`
    SELECT 1 AS locked
      FROM pg_advisory_xact_lock(${IDENTITY_LOCK_CLASS}::int, hashtext(${telegramUserId.toString()}::text))`;
}

/** Loads the user and holds its row lock until the transaction ends. */
export async function lockUserByTelegramId(
  tx: Tx,
  telegramUserId: bigint,
): Promise<AppUser | null> {
  await tx.$queryRaw`SELECT 1 AS locked FROM app_user WHERE telegram_user_id = ${telegramUserId} FOR UPDATE`;
  return tx.appUser.findUnique({ where: { telegramUserId } });
}

/**
 * Shared row lock for an execution-time eligibility check: a concurrent
 * suspension (which updates the row) waits for it, or it waits for the suspension.
 */
export async function lockUserForShare(tx: Tx, userId: string): Promise<AppUser | null> {
  await tx.$queryRaw`SELECT 1 AS locked FROM app_user WHERE id = ${userId}::uuid FOR SHARE`;
  return tx.appUser.findUnique({ where: { id: userId } });
}

/**
 * Links TRB-020 runs to the user record of the same Telegram identity. Ownership
 * is the stored requester identity; nothing is assigned to anyone else.
 * updated_at is left untouched so that historical run evidence is unchanged.
 */
export function linkRunsByTelegramIdentity(
  tx: Tx,
  userId: string,
  telegramUserId: bigint,
): Promise<number> {
  return tx.$executeRaw`
    UPDATE research_run SET user_id = ${userId}::uuid
     WHERE user_id IS NULL AND requested_by_telegram_user_id = ${telegramUserId}`;
}

/** Creates a configured administrator's record if missing (concurrency-safe). Returns true when created. */
async function insertConfiguredAdmin(tx: Tx, telegramUserId: bigint): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO app_user (id, telegram_user_id, role, updated_at)
    VALUES (${randomUUID()}::uuid, ${telegramUserId}, 'ADMIN', now())
    ON CONFLICT (telegram_user_id) DO NOTHING
    RETURNING id`;
  const created = rows[0];
  if (!created) return false;
  const linkedRuns = await linkRunsByTelegramIdentity(tx, created.id, telegramUserId);
  await recordAudit(tx, {
    kind: 'ADMIN_GRANTED',
    subjectUserId: created.id,
    details: { source: 'ADMIN_TELEGRAM_IDS', created: true, linkedRuns },
  });
  return true;
}

async function setRole(tx: Tx, user: AppUser, role: 'ADMIN' | 'MEMBER'): Promise<AppUser> {
  const updated = await tx.appUser.update({
    where: { id: user.id },
    data: { role, revision: { increment: 1 } },
  });
  await recordAudit(tx, {
    kind: role === 'ADMIN' ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED',
    subjectUserId: user.id,
    details: { source: 'ADMIN_TELEGRAM_IDS', created: false },
  });
  return updated;
}

/**
 * Loads (and row-locks) the authenticated sender of a private update, applying
 * the administrator configuration lazily: a configured administrator gets a
 * record and the ADMIN role; a record with ADMIN that is no longer configured
 * loses it. Status is never changed here: bootstrap never reactivates a
 * suspended user. Returns null for senders without a record.
 */
export async function resolveSender(
  tx: Tx,
  config: Env,
  telegramUserId: bigint,
  privateChatId: bigint,
): Promise<AppUser | null> {
  const configured = isConfiguredAdmin(config, telegramUserId);
  let user = await lockUserByTelegramId(tx, telegramUserId);
  if (!user && configured) {
    await insertConfiguredAdmin(tx, telegramUserId);
    user = await lockUserByTelegramId(tx, telegramUserId);
  }
  if (!user) return null;
  if (configured !== (user.role === 'ADMIN')) {
    user = await setRole(tx, user, configured ? 'ADMIN' : 'MEMBER');
  }
  if (user.privateChatId === null) {
    user = await tx.appUser.update({ where: { id: user.id }, data: { privateChatId } });
  }
  return user;
}

export interface BootstrapSummary {
  skipped: boolean;
  created: number;
  granted: number;
  revoked: number;
  linkedRuns: number;
}

/**
 * Administrator bootstrap from ADMIN_TELEGRAM_IDS (idempotent; safe to run
 * concurrently from several processes):
 * - each configured ID gets a user record with role ADMIN (new records start
 *   onboarding; no invitation is consumed);
 * - records with role ADMIN whose ID is no longer configured become MEMBER;
 * - status is never changed, so a suspended user stays suspended;
 * - TRB-020 runs are linked to the record of their requester's Telegram identity.
 * Skipped entirely when ADMIN_TELEGRAM_IDS is not set (for example, when Telegram is disabled).
 */
export async function bootstrapAdministrators(
  prisma: PrismaService,
  config: Env,
): Promise<BootstrapSummary> {
  const ids = config.ADMIN_TELEGRAM_IDS;
  if (ids === undefined) {
    return { skipped: true, created: 0, granted: 0, revoked: 0, linkedRuns: 0 };
  }
  return prisma.$transaction(async (tx) => {
    let created = 0;
    for (const id of ids) {
      if (await insertConfiguredAdmin(tx, BigInt(id))) created += 1;
    }
    const granted = await tx.$queryRaw<{ id: string }[]>`
      UPDATE app_user SET role = 'ADMIN', revision = revision + 1, updated_at = now()
       WHERE role = 'MEMBER' AND telegram_user_id::text = ANY(${ids}::text[])
      RETURNING id`;
    const revoked = await tx.$queryRaw<{ id: string }[]>`
      UPDATE app_user SET role = 'MEMBER', revision = revision + 1, updated_at = now()
       WHERE role = 'ADMIN' AND NOT (telegram_user_id::text = ANY(${ids}::text[]))
      RETURNING id`;
    for (const [rows, kind] of [
      [granted, 'ADMIN_GRANTED'],
      [revoked, 'ADMIN_REVOKED'],
    ] as const) {
      for (const row of rows) {
        await recordAudit(tx, {
          kind,
          subjectUserId: row.id,
          details: { source: 'ADMIN_TELEGRAM_IDS', created: false },
        });
      }
    }
    const linkedRuns = await tx.$executeRaw`
      UPDATE research_run r SET user_id = u.id
        FROM app_user u
       WHERE r.user_id IS NULL AND u.telegram_user_id = r.requested_by_telegram_user_id`;
    return {
      skipped: false,
      created,
      granted: granted.length,
      revoked: revoked.length,
      linkedRuns,
    };
  });
}
