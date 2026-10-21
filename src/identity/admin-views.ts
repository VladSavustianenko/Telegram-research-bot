import { sumComponents, type UsageTotals } from '../accounting/ledger';
import {
  LIMIT_SPECS,
  effectiveLimits,
  type EffectiveLimits,
  type LimitName,
} from '../accounting/limits';
import { formatUsd, periodsOf } from '../accounting/pricing';
import { parseUsdMicros, type Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import type { AppUser } from '../generated/prisma/client';
import {
  adminAccessCallbackData,
  adminUserCallbackData,
  adminUsersCallbackData,
} from '../telegram/callback-data';
import type { InlineKeyboard } from '../telegram/telegram-sender';
import { recordAudit } from './audit';
import { isConfiguredAdmin } from './authorization';
import { lockUserByTelegramId } from './users';

/**
 * Administrator views and limit changes (TRB-090, docs/ADMINISTRATION.md).
 *
 * Callers have authorized the administrator (adminOperationDenial) under the
 * sender's identity and row locks. Views show operational metadata only:
 * identifiers, access state, counts, configured and effective limits,
 * accounting totals (application estimates) and failure codes. They never
 * read prompts, task prompts or names, report text, documents, sources,
 * invitation tokens or hashes. All text is plain and escaped on delivery.
 */
export interface AdminView {
  text: string;
  keyboard?: InlineKeyboard;
}

export const ADMIN_USERS_PER_PAGE = 8;
const AUDIT_PER_PAGE = 10;
const INVITES_SHOWN = 8;
const TOP_USERS = 5;
const TOP_CODES = 5;
const REASON_MAX = 200;

const utc = (instant: Date | null | undefined) =>
  instant ? `${instant.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—';
const roleLabel = (user: Pick<AppUser, 'role' | 'telegramUserId'>, config: Env) =>
  user.role === 'ADMIN' && isConfiguredAdmin(config, user.telegramUserId)
    ? 'адміністратор'
    : 'учасник';

async function monthTotalsByUser(tx: Tx, month: string): Promise<Map<string, UsageTotals>> {
  const rows = await tx.budgetReservation.findMany({
    where: { periodMonth: month },
    select: {
      userId: true,
      status: true,
      exposureMicros: true,
      estimatedMicros: true,
      uncertainMicros: true,
      confirmedMicros: true,
    },
  });
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) grouped.set(row.userId, [...(grouped.get(row.userId) ?? []), row]);
  return new Map([...grouped].map(([userId, list]) => [userId, sumComponents(list)]));
}

const totalsLine = (totals: UsageTotals) =>
  `оцінено ${formatUsd(totals.estimatedMicros)}, невизначено ${formatUsd(totals.unresolvedMicros)}, ` +
  `у резерві ${formatUsd(totals.reservedMicros)}, підтверджено оператором ${formatUsd(totals.confirmedMicros)}; ` +
  `разом враховано ${formatUsd(totals.exposureMicros)}`;

/** `/admin users [page]`: bounded, stable order (creation time, then ID). */
export async function adminUsersView(
  tx: Tx,
  config: Env,
  now: Date,
  page: number,
): Promise<AdminView> {
  const total = await tx.appUser.count();
  const pages = Math.max(1, Math.ceil(total / ADMIN_USERS_PER_PAGE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const users = await tx.appUser.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    skip: current * ADMIN_USERS_PER_PAGE,
    take: ADMIN_USERS_PER_PAGE,
  });
  const { month } = periodsOf(now);
  const totals = await monthTotalsByUser(tx, month);
  const lines = [
    `Користувачі: ${total} (сторінка ${current + 1} з ${pages}). Облік за ${month} (UTC).`,
  ];
  const rows: InlineKeyboard['inline_keyboard'] = [];
  for (const [index, user] of users.entries()) {
    const [saved, active, runs] = await Promise.all([
      tx.task.count({ where: { userId: user.id, state: { not: 'DELETED' } } }),
      tx.task.count({ where: { userId: user.id, state: 'ACTIVE' } }),
      tx.researchRun.count({ where: { userId: user.id, admittedMonth: month } }),
    ]);
    const exposure = totals.get(user.id)?.exposureMicros ?? 0n;
    lines.push(
      `${current * ADMIN_USERS_PER_PAGE + index + 1}. ${user.telegramUserId} · ${roleLabel(user, config)} · ` +
        `${user.status === 'SUSPENDED' ? 'призупинений' : 'активний'}` +
        `${user.onboardingState === 'COMPLETED' ? '' : ' (онбординг)'}` +
        `${user.chatBlockedAt ? ' · чат недоступний' : ''} · завдань ${saved}/${active} акт. · ` +
        `запусків ${runs} · враховано ${formatUsd(exposure)}`,
    );
    rows.push([{ text: `${user.telegramUserId}`, callback_data: adminUserCallbackData(user.id) }]);
  }
  const paging: InlineKeyboard['inline_keyboard'][number] = [];
  if (current > 0) paging.push({ text: '«', callback_data: adminUsersCallbackData(current - 1) });
  if (current + 1 < pages)
    paging.push({ text: '»', callback_data: adminUsersCallbackData(current + 1) });
  if (paging.length > 0) rows.push(paging);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

function limitLines(limits: EffectiveLimits, config: Env): string[] {
  const shown = (name: LimitName, value: string, fallback: string) =>
    limits.overridden.has(name)
      ? `${value} (перевизначено; типово ${fallback})`
      : `${value} (типово)`;
  const budget = (micros: bigint | undefined) =>
    micros === undefined ? 'не налаштовано' : formatUsd(micros);
  return [
    `- tasks, збережені завдання: ${shown('savedTasks', `${limits.savedTasks}`, `${config.TASK_SAVED_LIMIT}`)}`,
    `- active_tasks, активні завдання: ${shown('activeTasks', `${limits.activeTasks}`, `${config.TASK_ACTIVE_LIMIT}`)}`,
    `- daily_runs, досліджень за добу (ручні й за розкладом): ${shown('dailyRuns', `${limits.dailyRuns}`, `${config.USER_DAILY_RUN_LIMIT}`)}`,
    `- manual_runs, ручних за добу: ${shown('dailyManualRuns', `${limits.dailyManualRuns}`, `${config.USER_DAILY_MANUAL_RUN_LIMIT}`)}`,
    `- active_runs, одночасних досліджень: ${shown('activeRuns', `${limits.activeRuns}`, `${config.USER_ACTIVE_RUN_LIMIT}`)}`,
    `- budget_usd, місячний бюджет: ${shown('monthlyBudget', budget(limits.monthlyBudgetMicros), budget(config.USER_MONTHLY_BUDGET_USD))}` +
      (config.USER_MONTHLY_BUDGET_USD === undefined ||
      config.GLOBAL_MONTHLY_BUDGET_USD === undefined
        ? ' — бюджети в конфігурації не задані, live-дослідження недоступні'
        : ''),
  ];
}

/** One user's administration view, by internal ID (callbacks) or Telegram ID (command). */
export async function adminUserView(
  tx: Tx,
  config: Env,
  now: Date,
  target: AppUser,
  notice?: string,
): Promise<AdminView> {
  const { day, month } = periodsOf(now);
  const counted = {
    userId: target.id,
    admittedDay: day,
    NOT: { state: 'CANCELLED' as const, submissionState: 'NOT_SUBMITTED' as const },
  };
  const [saved, active, deleted, today, manualToday, running, monthRuns, failed, uncertain] =
    await Promise.all([
      tx.task.count({ where: { userId: target.id, state: { not: 'DELETED' } } }),
      tx.task.count({ where: { userId: target.id, state: 'ACTIVE' } }),
      tx.task.count({ where: { userId: target.id, state: 'DELETED' } }),
      tx.researchRun.count({ where: counted }),
      tx.researchRun.count({ where: { ...counted, trigger: 'MANUAL' } }),
      tx.researchRun.count({ where: { userId: target.id, state: { in: ['QUEUED', 'RUNNING'] } } }),
      tx.researchRun.count({ where: { userId: target.id, admittedMonth: month } }),
      tx.researchRun.count({ where: { userId: target.id, admittedMonth: month, state: 'FAILED' } }),
      tx.researchRun.count({
        where: { userId: target.id, admittedMonth: month, state: 'UNCERTAIN' },
      }),
    ]);
  const totals = (await monthTotalsByUser(tx, month)).get(target.id) ?? sumComponents([]);
  const limits = effectiveLimits(target, config);
  const lines = [
    ...(notice ? [notice, ''] : []),
    `Користувач ${target.telegramUserId} (внутрішній ID ${target.id})`,
    `Роль: ${roleLabel(target, config)} · стан: ${target.status === 'SUSPENDED' ? 'призупинений' : 'активний'} · ` +
      `онбординг: ${target.onboardingState === 'COMPLETED' ? 'завершено' : 'очікує часового поясу'}`,
    `Чат: ${target.chatBlockedAt ? `недоступний (${target.chatBlockReason ?? '—'}, з ${utc(target.chatBlockedAt)})` : 'доступний'}`,
    `Запрошено: ${utc(target.invitedAt)} · онбординг: ${utc(target.onboardedAt)} · призупинено: ${utc(target.suspendedAt)}`,
    `Завдання: збережених ${saved}, активних ${active}, видалених ${deleted}`,
    `Сьогодні (${day} UTC): досліджень ${today}, з них ручних ${manualToday}; зараз активних ${running}`,
    `${month} (UTC): запусків ${monthRuns}, помилок виконання ${failed}, невизначених ${uncertain}`,
    `Витрати ${month} (оцінки застосунку, не рахунок OpenAI): ${totalsLine(totals)}`,
    '',
    'Ефективні ліміти:',
    ...limitLines(limits, config),
    '',
    `Змінити: /admin limit ${target.telegramUserId} <назва> <значення|default> [причина]`,
  ];
  const rows: InlineKeyboard['inline_keyboard'] = [];
  const protectedAdmin =
    target.role === 'ADMIN' || isConfiguredAdmin(config, target.telegramUserId);
  if (!protectedAdmin) {
    rows.push([
      target.status === 'SUSPENDED'
        ? {
            text: 'Відновити доступ',
            callback_data: adminAccessCallbackData(target.id, target.revision, 'reactivate'),
          }
        : {
            text: 'Призупинити',
            callback_data: adminAccessCallbackData(target.id, target.revision, 'suspend'),
          },
    ]);
  }
  rows.push([{ text: '« До списку', callback_data: adminUsersCallbackData(0) }]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

/** `/admin usage`: current UTC period, global and per-user exposure, failures and open cases. */
export async function adminUsageView(tx: Tx, config: Env, now: Date): Promise<AdminView> {
  const { day, month } = periodsOf(now);
  const byUser = await monthTotalsByUser(tx, month);
  const global = sumComponents(
    await tx.budgetReservation.findMany({
      where: { periodMonth: month },
      select: {
        status: true,
        exposureMicros: true,
        estimatedMicros: true,
        uncertainMicros: true,
        confirmedMicros: true,
      },
    }),
  );
  const budget = config.GLOBAL_MONTHLY_BUDGET_USD;
  const top = [...byUser].sort((a, b) => (b[1].exposureMicros > a[1].exposureMicros ? 1 : -1));
  const topUsers = await tx.appUser.findMany({
    where: { id: { in: top.slice(0, TOP_USERS).map(([id]) => id) } },
    select: { id: true, telegramUserId: true },
  });
  const telegramOf = new Map(topUsers.map((user) => [user.id, user.telegramUserId]));
  const states = await tx.researchRun.groupBy({
    by: ['state'],
    where: { admittedMonth: month },
    _count: { _all: true },
  });
  const stateCount = (state: string) => states.find((row) => row.state === state)?._count._all ?? 0;
  const codes = await tx.researchRun.groupBy({
    by: ['failureCode'],
    where: { admittedMonth: month, state: { in: ['FAILED', 'UNCERTAIN', 'CANCELLED'] } },
    _count: { _all: true },
  });
  const monthStart = new Date(`${month}-01T00:00:00Z`);
  const deliveries = await tx.delivery.groupBy({
    by: ['state'],
    where: { createdAt: { gte: monthStart } },
    _count: { _all: true },
  });
  const deliveryCount = (state: string) =>
    deliveries.find((row) => row.state === state)?._count._all ?? 0;
  const [unreconciled, unresolved, held, pendingBlocks, blockedChats] = await Promise.all([
    tx.researchRun.count({
      where: { state: 'UNCERTAIN', providerKind: { not: 'fake' }, reconciledAt: null },
    }),
    tx.budgetReservation.count({ where: { status: 'UNRESOLVED' } }),
    tx.budgetReservation.count({ where: { status: 'SETTLED', uncertainMicros: { gt: 0n } } }),
    tx.delivery.count({
      where: { destinationBlockReason: { not: null }, destinationBlockAppliedAt: null },
    }),
    tx.appUser.count({ where: { chatBlockedAt: { not: null } } }),
  ]);
  const lines = [
    `Облік за UTC: місяць ${month}, сьогодні ${day}. Суми — оцінки застосунку, не рахунок OpenAI.`,
    `Глобально: ${totalsLine(global)}` +
      (budget === undefined
        ? '. Глобальний бюджет не налаштовано: live-дослідження недоступні.'
        : ` з бюджету ${formatUsd(budget)}.`),
    'Найбільші за врахованим:',
    ...(top.length === 0
      ? ['- немає резервів']
      : top
          .slice(0, TOP_USERS)
          .map(
            ([id, totals]) =>
              `- ${telegramOf.get(id) ?? id}: ${formatUsd(totals.exposureMicros)} (оцінено ${formatUsd(totals.estimatedMicros)}, невизначено ${formatUsd(totals.unresolvedMicros)}, резерв ${formatUsd(totals.reservedMicros)})`,
          )),
    `Дослідження за ${month}: усього ${states.reduce((n, row) => n + row._count._all, 0)}; ` +
      `успішно ${stateCount('SUCCEEDED')}, помилка ${stateCount('FAILED')}, невизначено ${stateCount('UNCERTAIN')}, ` +
      `скасовано ${stateCount('CANCELLED')}, у черзі ${stateCount('QUEUED')}, виконується ${stateCount('RUNNING')}`,
    `Коди незавершених: ${
      codes
        .sort((a, b) => b._count._all - a._count._all)
        .slice(0, TOP_CODES)
        .map((row) => `${row.failureCode ?? '—'} ×${row._count._all}`)
        .join(', ') || '—'
    }`,
    `Доставки з ${month}-01 (окремо від результату дослідження): надіслано ${deliveryCount('SENT')}, ` +
      `невідомо ${deliveryCount('UNKNOWN')}, не доставлено ${deliveryCount('PERMANENT_FAILURE')}, ` +
      `придушено ${deliveryCount('SUPPRESSED')}, очікують ${deliveryCount('PENDING') + deliveryCount('SENDING') + deliveryCount('RETRYABLE_FAILURE')}`,
    `Відкриті випадки: live-запусків без звірки ${unreconciled}; резервів UNRESOLVED ${unresolved}; ` +
      `SETTLED з утриманням ${held}; незастосованих відмов чату ${pendingBlocks}; недоступних чатів ${blockedChats}`,
    'Звірка з провайдером (npm run ops:reconcile) і фінансове вирішення (npm run ops:accounting) — окремі дії оператора.',
  ];
  return { text: lines.join('\n') };
}

/** `/admin invites`: counts and the latest invitations; never tokens or hashes. */
export async function adminInvitesView(tx: Tx, now: Date): Promise<AdminView> {
  const [redeemed, revoked, expired, pending] = await Promise.all([
    tx.invitation.count({ where: { redeemedAt: { not: null } } }),
    tx.invitation.count({ where: { revokedAt: { not: null } } }),
    tx.invitation.count({ where: { redeemedAt: null, revokedAt: null, expiresAt: { lte: now } } }),
    tx.invitation.count({ where: { redeemedAt: null, revokedAt: null, expiresAt: { gt: now } } }),
  ]);
  const latest = await tx.invitation.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: INVITES_SHOWN,
    select: {
      id: true,
      createdAt: true,
      expiresAt: true,
      redeemedAt: true,
      revokedAt: true,
      createdBy: { select: { telegramUserId: true } },
      redeemedBy: { select: { telegramUserId: true } },
    },
  });
  const status = (row: (typeof latest)[number]) =>
    row.redeemedAt
      ? `використано ${row.redeemedBy?.telegramUserId ?? ''}`.trim()
      : row.revokedAt
        ? 'відкликано'
        : row.expiresAt <= now
          ? 'прострочено'
          : 'чинне';
  return {
    text: [
      `Запрошення: чинних ${pending}, використаних ${redeemed}, прострочених ${expired}, відкликаних ${revoked}.`,
      ...latest.map(
        (row) =>
          `- ${row.id} · створив ${row.createdBy.telegramUserId} ${utc(row.createdAt)} · до ${utc(row.expiresAt)} · ${status(row)}`,
      ),
      'Відкликати чинне: /admin revoke <ID запрошення>',
    ].join('\n'),
  };
}

/** `/admin audit [page]`: newest first; details are identifiers, codes and counts only. */
export async function adminAuditView(tx: Tx, page: number): Promise<AdminView> {
  const current = Math.max(0, page);
  const events = await tx.auditEvent.findMany({
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: current * AUDIT_PER_PAGE,
    take: AUDIT_PER_PAGE,
    select: {
      kind: true,
      createdAt: true,
      details: true,
      actor: { select: { telegramUserId: true } },
      subject: { select: { telegramUserId: true } },
    },
  });
  const lines = [`Журнал аудиту (сторінка ${current + 1}, новіші спершу):`];
  if (events.length === 0) lines.push('Записів немає.');
  for (const event of events) {
    const details = JSON.stringify(event.details);
    lines.push(
      `- ${utc(event.createdAt)} ${event.kind} · хто ${event.actor?.telegramUserId ?? 'система'} · ` +
        `кого ${event.subject?.telegramUserId ?? '—'} · ${details.length > REASON_MAX ? `${details.slice(0, REASON_MAX)}…` : details}`,
    );
  }
  lines.push(`Далі: /admin audit ${current + 2}`);
  return { text: lines.join('\n') };
}

export type LimitChange =
  | { result: 'CHANGED' | 'NO_CHANGE'; target: AppUser }
  | { result: 'USER_NOT_FOUND' | 'UNKNOWN_LIMIT' | 'INVALID_VALUE' };

/**
 * Sets or clears (`default`) one override of the target, under the target's
 * row lock: admission and task operations hold that lock, so a change commits
 * entirely before or after each of them. Existing tasks, runs, reservations
 * and exposure are never rewritten; only new operations see the new limit.
 * The change and its before/after values are audited (no-op changes are not).
 */
export async function setLimitOverride(
  tx: Tx,
  config: Env,
  actor: AppUser,
  input: { targetTelegramId: bigint; limit: string; value: string; reason: string },
): Promise<LimitChange> {
  const spec = LIMIT_SPECS[input.limit.toLowerCase()];
  if (!spec) return { result: 'UNKNOWN_LIMIT' };
  let next: number | bigint | null;
  if (input.value.toLowerCase() === 'default') next = null;
  else if (spec.money) {
    next = parseUsdMicros(input.value);
    if (next === null) return { result: 'INVALID_VALUE' };
  } else {
    if (!/^\d{1,9}$/.test(input.value)) return { result: 'INVALID_VALUE' };
    next = Number(input.value);
    if (next > spec.max) return { result: 'INVALID_VALUE' };
  }
  const target = await lockUserByTelegramId(tx, input.targetTelegramId);
  if (!target) return { result: 'USER_NOT_FOUND' };
  const before = effectiveLimits(target, config);
  const previous = target[spec.column];
  if (
    (previous === null && next === null) ||
    (previous !== null && next !== null && BigInt(previous) === BigInt(next))
  ) {
    return { result: 'NO_CHANGE', target };
  }
  const updated = await tx.appUser.update({
    where: { id: target.id },
    data: { [spec.column]: next, revision: { increment: 1 } },
  });
  const after = effectiveLimits(updated, config);
  const value = (limits: EffectiveLimits) => {
    const raw = limits[spec.name === 'monthlyBudget' ? 'monthlyBudgetMicros' : spec.name];
    return raw === undefined ? null : raw.toString();
  };
  await recordAudit(tx, {
    kind: 'LIMIT_CHANGED',
    actorUserId: actor.id,
    subjectUserId: target.id,
    details: {
      limit: input.limit.toLowerCase(),
      overrideBefore: previous === null ? null : previous.toString(),
      overrideAfter: next === null ? null : next.toString(),
      effectiveBefore: value(before),
      effectiveAfter: value(after),
      reason: input.reason.slice(0, REASON_MAX) || null,
    },
  });
  return { result: 'CHANGED', target: updated };
}

export type Revocation = 'REVOKED' | 'NOT_FOUND' | 'NOT_REVOCABLE';

/**
 * Revokes an unredeemed, unexpired invitation (row-locked, so a concurrent
 * redemption either wins first or finds it revoked). Its undelivered invitation
 * message is suppressed; an already delivered link stops working.
 */
export async function revokeInvitation(
  tx: Tx,
  actor: AppUser,
  invitationId: string,
): Promise<Revocation> {
  const rows = await tx.$queryRaw<{ redeemable: boolean }[]>`
    SELECT (redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS redeemable
      FROM invitation WHERE id = ${invitationId}::uuid FOR UPDATE`;
  const row = rows[0];
  if (!row) return 'NOT_FOUND';
  if (!row.redeemable) return 'NOT_REVOCABLE';
  await tx.invitation.update({
    where: { id: invitationId },
    data: { revokedAt: new Date(), revokedByUserId: actor.id },
  });
  const suppressed = await tx.$executeRaw`
    UPDATE delivery SET state = 'SUPPRESSED', suppressed_at = COALESCE(suppressed_at, now()),
           last_error_code = 'INVITATION_REVOKED', updated_at = now()
     WHERE invitation_id = ${invitationId}::uuid AND state IN ('PENDING', 'RETRYABLE_FAILURE')`;
  await recordAudit(tx, {
    kind: 'INVITATION_REVOKED',
    actorUserId: actor.id,
    invitationId,
    details: { suppressedDeliveries: suppressed },
  });
  return 'REVOKED';
}
