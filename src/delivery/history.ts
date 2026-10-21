import { sumComponents } from '../accounting/ledger';
import { formatUsd } from '../accounting/pricing';
import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import type { AppUser, Prisma } from '../generated/prisma/client';
import { userOperationDenial } from '../identity/authorization';
import { formatInZone } from '../scheduling/recurrence';
import {
  historyCallbackData,
  resendCallbackData,
  runCallbackData,
  taskCallbackData,
  taskListCallbackData,
  type HistoryCursor,
  type HistoryScope,
} from '../telegram/callback-data';
import type { InlineKeyboard } from '../telegram/telegram-sender';
import { createStatusDelivery } from './delivery-records';
import { OUTCOME_LABELS, denialMessage, messages } from './messages';
import { requestResultResend, visibleRunsOf } from './result-resend';

/** Inbox context of a history action (the sender's identity and row locks are held). */
export interface HistoryContext {
  tx: Tx;
  config: Env;
  user: AppUser;
  chatId: bigint;
  now: Date;
}

export interface HistoryOutcome {
  disposition: 'REPLIED' | 'REJECTED' | 'IGNORED' | 'RESULT_REQUESTED';
  reason: string;
  runId?: string;
  callbackAnswer?: string;
}

export const HISTORY_PAGE_SIZE = 5;
const PROMPT_PREVIEW_CHARS = 200;
const NAME_PREVIEW_CHARS = 30;
/** A scheduled run that started later than this shows its actual start next to the plan. */
const LATE_START_MS = 5 * 60_000;

const RUN_FIELDS = {
  id: true,
  trigger: true,
  state: true,
  outcome: true,
  failureCode: true,
  providerKind: true,
  reconciledAt: true,
  prompt: true,
  contentPurgedAt: true,
  occurrenceAt: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  requestSnapshot: true,
  task: { select: { id: true, name: true } },
  deliveries: {
    where: { kind: { in: ['REPORT', 'RESEND'] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { kind: true, state: true, lastErrorCode: true },
  },
  reservations: {
    select: {
      status: true,
      reservedMicros: true,
      estimatedMicros: true,
      uncertainMicros: true,
      confirmedMicros: true,
      exposureMicros: true,
    },
  },
} satisfies Prisma.ResearchRunSelect;

type RunRow = Prisma.ResearchRunGetPayload<{ select: typeof RUN_FIELDS }>;

/**
 * Run history, run cards and resends in Telegram (TRB-080, docs/DELIVERY.md).
 *
 * Every function rechecks account access and queries by the authenticated
 * user's ID together with the object ID; runs of deleted tasks are hidden like
 * the tasks themselves. A foreign, deleted or nonexistent ID gets the same
 * answer as a stale button. Nothing here starts research or changes a run,
 * reservation or earlier delivery.
 *
 * Pagination is keyset-based on (created_at, id), newest first: a page is
 * "older than" or "newer than" a run of the current page, so new runs never
 * shift or duplicate the rows of an open page.
 */
export async function showHistory(
  ctx: HistoryContext,
  scope: HistoryScope,
  cursor: HistoryCursor | null = null,
): Promise<HistoryOutcome> {
  const refused = await denied(ctx);
  if (refused) return refused;
  const resolved = await resolveScope(ctx, scope);
  if (!resolved) return notFound(ctx, messages.taskNotFound, 'TASK_NOT_FOUND');
  const base = resolved.where;

  let notice: string | undefined;
  let anchor: { id: string; createdAt: Date } | null = null;
  if (cursor) {
    anchor = await ctx.tx.researchRun.findFirst({
      where: { ...base, id: cursor.runId },
      select: { id: true, createdAt: true },
    });
    // A page anchor that is no longer visible: start again from the newest runs.
    if (!anchor) notice = messages.historyRestarted;
  }

  let rows: RunRow[];
  let hasNewer: boolean;
  let hasOlder: boolean;
  if (anchor && cursor?.direction === 'newer') {
    const newer = await ctx.tx.researchRun.findMany({
      where: {
        AND: [
          base,
          {
            OR: [
              { createdAt: { gt: anchor.createdAt } },
              { createdAt: anchor.createdAt, id: { gt: anchor.id } },
            ],
          },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: HISTORY_PAGE_SIZE + 1,
      select: RUN_FIELDS,
    });
    hasNewer = newer.length > HISTORY_PAGE_SIZE;
    rows = newer.slice(0, HISTORY_PAGE_SIZE).reverse();
    hasOlder = true;
  } else {
    const older = await ctx.tx.researchRun.findMany({
      where: anchor
        ? {
            AND: [
              base,
              {
                OR: [
                  { createdAt: { lt: anchor.createdAt } },
                  { createdAt: anchor.createdAt, id: { lt: anchor.id } },
                ],
              },
            ],
          }
        : base,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: HISTORY_PAGE_SIZE + 1,
      select: RUN_FIELDS,
    });
    hasOlder = older.length > HISTORY_PAGE_SIZE;
    rows = older.slice(0, HISTORY_PAGE_SIZE);
    hasNewer = anchor !== null;
  }
  // An "older" page past the end (runs hidden meanwhile) falls back to the newest page.
  if (rows.length === 0 && anchor) return showHistory(ctx, scope, null);

  const title = resolved.task
    ? `Історія запусків завдання «${resolved.task.name}»`
    : 'Ваші останні запуски (завдання й /research)';
  const lines = [...(notice ? [notice, ''] : []), title];
  if (rows.length === 0) lines.push('', messages.historyEmpty);
  const buttons: InlineKeyboard['inline_keyboard'] = [];
  rows.forEach((run, index) => {
    lines.push('', `${index + 1}. ${historyLine(run, ctx.user, !resolved.task)}`);
  });
  if (rows.length > 0) {
    buttons.push(
      rows.map((run, index) => ({
        text: `${index + 1}`,
        callback_data: runCallbackData(run.id, scope),
      })),
    );
    lines.push('', 'Натисніть номер, щоб відкрити запуск і його результат.');
  }
  const paging: InlineKeyboard['inline_keyboard'][number] = [];
  const first = rows[0];
  const last = rows.at(-1);
  if (hasNewer && first) {
    paging.push({
      text: '« Новіші',
      callback_data: historyCallbackData(scope, { direction: 'newer', runId: first.id }),
    });
  }
  if (hasOlder && last) {
    paging.push({
      text: 'Старіші »',
      callback_data: historyCallbackData(scope, { direction: 'older', runId: last.id }),
    });
  }
  if (paging.length > 0) buttons.push(paging);
  buttons.push([
    resolved.task
      ? {
          text: '« До завдання',
          callback_data: taskCallbackData(resolved.task.id, resolved.task.revision, 'v'),
        }
      : { text: 'Завдання', callback_data: taskListCallbackData(0) },
  ]);
  await createStatusDelivery(ctx.tx, ctx.chatId, lines.join('\n'), undefined, {
    inline_keyboard: buttons,
  });
  return { disposition: 'REPLIED', reason: cursor ? 'HISTORY_PAGE' : 'HISTORY' };
}

/** The card of one visible run: times, states, delivery, usage and the resend button. */
export async function showRun(
  ctx: HistoryContext,
  runId: string,
  scope: HistoryScope,
  notice?: string,
): Promise<HistoryOutcome> {
  const refused = await denied(ctx);
  if (refused) return refused;
  const run = await ctx.tx.researchRun.findFirst({
    where: { id: runId, ...visibleRunsOf(ctx.user.id) },
    select: RUN_FIELDS,
  });
  if (!run) return notFound(ctx, messages.runNotFound, 'RUN_NOT_FOUND');
  const zone = zoneOf(run, ctx.user);
  const at = (instant: Date) => `${formatInZone(instant, zone)} (${zone})`;
  const report = run.deliveries.find((delivery) => delivery.kind === 'REPORT');
  const resends = run.deliveries.filter((delivery) => delivery.kind === 'RESEND');

  const lines = [...(notice ? [notice, ''] : []), `Запуск ${run.id}`];
  lines.push(
    run.task
      ? `Завдання: «${run.task.name}»`
      : run.contentPurgedAt
        ? 'Разовий запит (/research); текст запиту видалено за політикою зберігання'
        : `Разовий запит (/research): ${truncate(run.prompt, PROMPT_PREVIEW_CHARS)}`,
  );
  lines.push(`Тип: ${run.trigger === 'SCHEDULED' ? 'за розкладом' : 'вручну'}`);
  if (run.occurrenceAt) lines.push(`Заплановано на: ${at(run.occurrenceAt)}`);
  lines.push(`Прийнято: ${at(run.createdAt)}`);
  if (run.startedAt) {
    const late =
      run.occurrenceAt && run.startedAt.getTime() - run.occurrenceAt.getTime() > LATE_START_MS
        ? ` — на ${Math.round((run.startedAt.getTime() - run.occurrenceAt.getTime()) / 60_000)} хв пізніше запланованого`
        : '';
    lines.push(`Фактичний початок: ${at(run.startedAt)}${late}`);
  } else {
    lines.push(
      `Фактичний початок: ${run.state === 'QUEUED' ? 'ще не почалося' : 'не виконувалося'}`,
    );
  }
  if (run.completedAt) lines.push(`Завершено: ${at(run.completedAt)}`);
  lines.push(`Дослідження: ${stateText(run)}`);
  if (run.outcome) lines.push(`Підсумок: ${OUTCOME_LABELS[run.outcome]}`);
  if (run.contentPurgedAt) {
    lines.push(messages.reportExpiredLine(ctx.config.REPORT_RETENTION_DAYS));
  }
  if (report) {
    lines.push(`Доставка звіту: ${deliveryLabel(report.state, report.lastErrorCode)}`);
    if (report.state === 'UNKNOWN') lines.push(messages.unknownDeliveryWarning);
  } else if (run.state !== 'QUEUED' && run.state !== 'RUNNING') {
    lines.push('Звіту немає.');
  }
  const lastResend = resends.at(-1);
  if (lastResend) {
    lines.push(
      `Повторних надсилань: ${resends.length} (останнє: ${deliveryLabel(lastResend.state, lastResend.lastErrorCode)})`,
    );
  }
  lines.push(`Витрати: ${usage(run).long}`);
  lines.push('', 'Стан дослідження і стан доставки — окремі: збій доставки не змінює результат.');

  const buttons: InlineKeyboard['inline_keyboard'] = [];
  if (run.state === 'SUCCEEDED' && report && !run.contentPurgedAt) {
    buttons.push([
      {
        text: report.state === 'UNKNOWN' ? 'Надіслати ще раз (можливий дубль)' : 'Надіслати звіт',
        callback_data: resendCallbackData(run.id),
      },
    ]);
  }
  buttons.push([{ text: '« До історії', callback_data: historyCallbackData(scope) }]);
  await createStatusDelivery(ctx.tx, ctx.chatId, lines.join('\n'), undefined, {
    inline_keyboard: buttons,
  });
  return { disposition: 'REPLIED', reason: 'RUN_CARD', runId: run.id };
}

/** "Останній результат" on a task card: the card of the task's latest successful run. */
export async function showLatestResult(
  ctx: HistoryContext,
  taskId: string,
): Promise<HistoryOutcome> {
  const refused = await denied(ctx);
  if (refused) return refused;
  const resolved = await resolveScope(ctx, { taskId });
  if (!resolved?.task) return notFound(ctx, messages.taskNotFound, 'TASK_NOT_FOUND');
  const latest = await ctx.tx.researchRun.findFirst({
    where: { ...resolved.where, state: 'SUCCEEDED' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  if (!latest) {
    await createStatusDelivery(
      ctx.tx,
      ctx.chatId,
      messages.noResultsYet(resolved.task.name),
      undefined,
      {
        inline_keyboard: [
          [{ text: 'Історія запусків', callback_data: historyCallbackData({ taskId }) }],
          [
            {
              text: '« До завдання',
              callback_data: taskCallbackData(resolved.task.id, resolved.task.revision, 'v'),
            },
          ],
        ],
      },
    );
    return { disposition: 'REPLIED', reason: 'NO_RESULT_YET' };
  }
  const outcome = await showRun(ctx, latest.id, { taskId });
  return { ...outcome, reason: 'LATEST_RESULT' };
}

/** The resend button of a run card: the same explicit resend as /result. */
export async function resendFromHistory(
  ctx: HistoryContext,
  runId: string,
): Promise<HistoryOutcome> {
  const outcome = await requestResultResend(ctx.tx, ctx.config, {
    user: ctx.user,
    runId,
    chatId: ctx.chatId,
  });
  return {
    disposition: outcome.disposition,
    reason: outcome.reason ?? 'RESEND_REQUESTED',
    ...(outcome.runId ? { runId: outcome.runId } : {}),
    ...(outcome.reason === null ? { callbackAnswer: messages.resendQueued } : {}),
  };
}

// ---------------------------------------------------------------------------

async function denied(ctx: HistoryContext): Promise<HistoryOutcome | null> {
  const denial = userOperationDenial(ctx.user, ctx.config);
  if (!denial) return null;
  await createStatusDelivery(ctx.tx, ctx.chatId, denialMessage(denial));
  return { disposition: 'REJECTED', reason: denial, callbackAnswer: denialMessage(denial) };
}

async function notFound(
  ctx: HistoryContext,
  text: string,
  reason: string,
): Promise<HistoryOutcome> {
  await createStatusDelivery(ctx.tx, ctx.chatId, text);
  return { disposition: 'REJECTED', reason, callbackAnswer: text };
}

async function resolveScope(
  ctx: HistoryContext,
  scope: HistoryScope,
): Promise<{
  where: Prisma.ResearchRunWhereInput;
  task?: { id: string; name: string; revision: number };
} | null> {
  const where = visibleRunsOf(ctx.user.id);
  if (scope === 'all') return { where };
  const task = await ctx.tx.task.findFirst({
    where: { id: scope.taskId, userId: ctx.user.id, state: { not: 'DELETED' } },
    select: { id: true, name: true, revision: true },
  });
  return task ? { where: { ...where, taskId: task.id }, task } : null;
}

function zoneOf(run: RunRow, user: AppUser): string {
  const snapshot = run.requestSnapshot as { config?: { timeZone?: unknown } } | null;
  const zone = snapshot?.config?.timeZone;
  return typeof zone === 'string' && zone ? zone : (user.timeZone ?? 'UTC');
}

function historyLine(run: RunRow, user: AppUser, withName: boolean): string {
  const zone = zoneOf(run, user);
  const planned = run.occurrenceAt;
  const started = run.startedAt;
  let when = formatInZone(planned ?? run.createdAt, zone);
  if (planned && started && started.getTime() - planned.getTime() > LATE_START_MS) {
    when += ` (факт ${formatInZone(started, zone).slice(11)})`;
  }
  const report = run.deliveries.find((delivery) => delivery.kind === 'REPORT');
  const parts = [
    when,
    run.trigger === 'SCHEDULED' ? 'за розкладом' : 'вручну',
    ...(withName
      ? [run.task ? `«${truncate(run.task.name, NAME_PREVIEW_CHARS)}»` : '/research']
      : []),
    `${STATE_LABELS[run.state]}${run.outcome ? `: ${OUTCOME_LABELS[run.outcome]}` : ''}`,
    ...(report ? [`доставка: ${deliveryLabel(report.state, report.lastErrorCode)}`] : []),
  ];
  const cost = usage(run).short;
  if (cost) parts.push(cost);
  return parts.join(' · ');
}

const STATE_LABELS: Record<RunRow['state'], string> = {
  QUEUED: 'у черзі',
  RUNNING: 'виконується',
  SUCCEEDED: 'завершено',
  FAILED: 'помилка',
  CANCELLED: 'скасовано',
  UNCERTAIN: 'невизначено',
};

function stateText(run: RunRow): string {
  const code = run.failureCode ? ` (${run.failureCode})` : '';
  switch (run.state) {
    case 'UNCERTAIN':
      return run.providerKind === 'fake'
        ? `невизначений результат${code} (симуляція, витрат не було)`
        : `невизначений результат${code}: запит міг бути виконаний і оплачений` +
            (run.reconciledAt ? '; оператор провів звірку' : '; очікує звірки оператором');
    case 'SUCCEEDED':
      return 'завершено успішно';
    default:
      return `${STATE_LABELS[run.state]}${code}`;
  }
}

/** Delivery state as the user sees it; UNKNOWN is never shown as a failure. */
export function deliveryLabel(state: string, code: string | null): string {
  switch (state) {
    case 'PENDING':
      return 'очікує надсилання';
    case 'SENDING':
      return 'надсилається';
    case 'SENT':
      return 'доставлено';
    case 'RETRYABLE_FAILURE':
      return 'тимчасова помилка, буде повторна спроба';
    case 'UNKNOWN':
      return 'невідомо (могло надійти)';
    case 'PERMANENT_FAILURE':
      return 'не доставлено';
    case 'SUPPRESSED':
      return `не надсилалося (${SUPPRESSION_LABELS[code ?? ''] ?? 'зупинено'})`;
    default:
      return state;
  }
}

const SUPPRESSION_LABELS: Record<string, string> = {
  RECIPIENT_SUSPENDED: 'доступ було призупинено',
  TASK_DELETED: 'завдання видалено',
  CHAT_BLOCKED: 'чат був недоступний',
  ACCESS_REVOKED: 'доступ відкликано',
  OWNER_UNRESOLVED: 'власника не визначено',
  CONTENT_EXPIRED: 'вміст видалено за політикою зберігання',
  INVITATION_REVOKED: 'запрошення відкликано',
};

/** Estimated usage versus amounts that are still unresolved or reserved (local estimates). */
function usage(run: RunRow): { short: string; long: string } {
  if (run.reservations.length === 0) {
    return run.providerKind === 'fake'
      ? { short: 'симуляція', long: 'немає (симуляція, реального запиту не було)' }
      : { short: '', long: 'не обліковувалися (запуск до введення обліку)' };
  }
  const totals = sumComponents(run.reservations);
  const estimated = totals.estimatedMicros;
  const unresolved = totals.unresolvedMicros;
  const reserved = totals.reservedMicros;
  const confirmed = totals.confirmedMicros;
  const long: string[] = [];
  const short: string[] = [];
  if (estimated > 0n) {
    long.push(`оцінка ≈ ${formatUsd(estimated)}`);
    short.push(`≈ ${formatUsd(estimated)}`);
  }
  if (unresolved > 0n) {
    long.push(`невизначено (утримується до звірки) ${formatUsd(unresolved)}`);
    short.push(`невизн. ${formatUsd(unresolved)}`);
  }
  if (reserved > 0n) {
    long.push(`зарезервовано ${formatUsd(reserved)}`);
    short.push(`резерв ${formatUsd(reserved)}`);
  }
  if (confirmed > 0n) {
    long.push(`підтверджено оператором ${formatUsd(confirmed)}`);
    short.push(`${formatUsd(confirmed)}`);
  }
  if (long.length === 0)
    return { short: '$0', long: 'немає (скасовано до запиту, резерв звільнено)' };
  return {
    short: short.join(', '),
    long: `${long.join('; ')}. Оцінки застосунку, не рахунок OpenAI.`,
  };
}

function truncate(text: string, maxCodePoints: number): string {
  const points = Array.from(text);
  return points.length <= maxCodePoints ? text : `${points.slice(0, maxCodePoints).join('')}…`;
}
