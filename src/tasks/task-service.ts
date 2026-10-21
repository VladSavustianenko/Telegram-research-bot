import type { Env } from '../config/env.schema';
import type { Tx } from '../database/prisma-errors';
import { effectiveLimits } from '../accounting/limits';
import { createDelivery } from '../delivery/delivery-records';
import { denialMessage } from '../delivery/messages';
import { escapeHtml } from '../delivery/telegram-html';
import type { AppUser, Prisma, Task, TaskDraft } from '../generated/prisma/client';
import { showHistory, showLatestResult } from '../delivery/history';
import { userOperationDenial } from '../identity/authorization';
import { SUGGESTED_TIME_ZONE } from '../identity/time-zone';
import { admitResearch } from '../research/admission';
import { cancelQueuedRuns, suppressRunDeliveries } from '../research/lifecycle';
import { nextOccurrenceAfter } from '../scheduling/recurrence';
import type { DraftOp, TaskOp } from '../telegram/callback-data';
import {
  applyEvent,
  completeConfiguration,
  scheduleOf,
  stepSequence,
  type DraftData,
  type DraftError,
  type DraftEvent,
  type DraftSection,
  type DraftShape,
} from './draft-flow';
import {
  DRAFT_TTL_HOURS,
  TASK_NAME_MAX_CHARS,
  validateName,
  validatePrompt,
} from './task-validation';
import {
  TASKS_PER_PAGE,
  deleteConfirmView,
  draftConflictView,
  stepView,
  taskCardView,
  taskListView,
  type DraftView,
  type View,
} from './task-views';

/**
 * Task management and the durable task dialog (TRB-040).
 *
 * Every function runs inside the Telegram inbox transaction, after the
 * sender's identity lock and row lock (one update per user at a time). Each
 * one rechecks account access itself, and every query is scoped by the
 * authenticated user's ID, so foreign and nonexistent IDs look the same.
 * Mutations are also conditional on the revision the user acted on
 * (optimistic concurrency), so a stale button or edit never overwrites newer
 * data even without the lock. Only "Run now" creates research runs.
 *
 * Schedule (TRB-070): every change that affects it sets next_run_at in the same
 * conditional update. Creation, resume and a schedule edit compute the first
 * occurrence after now (never a catch-up); pause and deletion clear it. "Run
 * now" never touches it.
 */
export interface TaskContext {
  tx: Tx;
  config: Env;
  user: AppUser;
  chatId: bigint;
  /** The inbox update being handled (a run's source) and the admission time. */
  updateId: bigint;
  now: Date;
}

export interface TaskOutcome {
  disposition: 'REPLIED' | 'REJECTED' | 'IGNORED' | 'RUN_ACCEPTED' | 'RESULT_REQUESTED';
  reason: string;
  callbackAnswer?: string;
  /** A research run started (or found active) by "Run now". */
  runId?: string;
}

const STALE_BUTTON = 'Ця кнопка застаріла.';
const NOT_FOUND = 'Завдання не знайдено.';
/** Telegram allows 4096 characters; stay well below, as the report renderer does. */
const MAX_PART_LENGTH = 3800;

const ERROR_TEXT = (error: DraftError, promptMax: number): string => {
  switch (error) {
    case 'NAME_EMPTY':
      return 'Назва не може бути порожньою.';
    case 'NAME_TOO_LONG':
      return `Назва задовга: максимум ${TASK_NAME_MAX_CHARS} символів.`;
    case 'NAME_MULTILINE':
      return 'Назва має бути одним рядком.';
    case 'PROMPT_EMPTY':
      return 'Запит не може бути порожнім.';
    case 'PROMPT_TOO_LONG':
      return `Запит задовгий: максимум ${promptMax} символів.`;
    case 'TIME_INVALID':
      return 'Невірний час. Формат ГГ:ХХ, від 00:00 до 23:59.';
    case 'ZONE_INVALID':
      return 'Невідомий часовий пояс. Надішліть назву IANA, наприклад Europe/Kyiv.';
    case 'NEEDS_BUTTON':
      return 'Оберіть варіант кнопкою нижче.';
    case 'NOTHING_TO_KEEP':
      return 'Поточного значення немає; надішліть нове.';
    case 'NOT_APPLICABLE':
      return 'Ця дія не відповідає поточному кроку.';
  }
};

/** Escaped HTML parts, split between graphemes; buttons go on the last part. */
export function htmlParts(text: string, limit = MAX_PART_LENGTH): string[] {
  const parts: string[] = [];
  let current = '';
  for (const { segment } of new Intl.Segmenter('uk', { granularity: 'grapheme' }).segment(text)) {
    const escaped = escapeHtml(segment);
    // Prefer a line break near the end of a part; otherwise split anywhere between graphemes.
    if (
      current.length + escaped.length > limit ||
      (segment === '\n' && current.length > limit - 400)
    ) {
      parts.push(current);
      current = segment === '\n' ? '' : escaped;
      continue;
    }
    current += escaped;
  }
  if (current.length > 0 || parts.length === 0) parts.push(current);
  return parts;
}

async function send(ctx: TaskContext, view: View): Promise<void> {
  const parts = htmlParts(view.text);
  await createDelivery(ctx.tx, {
    kind: 'STATUS',
    chatId: ctx.chatId,
    parts: parts.map((html, index) =>
      index === parts.length - 1 && view.keyboard ? { html, replyMarkup: view.keyboard } : html,
    ),
  });
}

async function reply(
  ctx: TaskContext,
  disposition: TaskOutcome['disposition'],
  reason: string,
  view: View,
  callbackAnswer?: string,
): Promise<TaskOutcome> {
  await send(ctx, view);
  return { disposition, reason, ...(callbackAnswer ? { callbackAnswer } : {}) };
}

/** Access gate of every entry point (defence in depth; the router checks too). */
async function denied(ctx: TaskContext): Promise<TaskOutcome | null> {
  const denial = userOperationDenial(ctx.user, ctx.config);
  if (!denial) return null;
  return reply(ctx, 'REJECTED', denial, { text: denialMessage(denial) }, denialMessage(denial));
}

// ---------------------------------------------------------------------------
// Tasks

const ownTask = (ctx: TaskContext, taskId: string) =>
  ctx.tx.task.findFirst({ where: { id: taskId, userId: ctx.user.id, state: { not: 'DELETED' } } });

async function counts(ctx: TaskContext) {
  const [saved, active] = await Promise.all([
    ctx.tx.task.count({ where: { userId: ctx.user.id, state: { not: 'DELETED' } } }),
    ctx.tx.task.count({ where: { userId: ctx.user.id, state: 'ACTIVE' } }),
  ]);
  return {
    saved,
    active,
    savedLimit: limitsOfUser(ctx).savedTasks,
    activeLimit: limitsOfUser(ctx).activeTasks,
  };
}

/** `/tasks` and list pages: the user's non-deleted tasks, oldest first. */
export async function showTasks(ctx: TaskContext, page = 0, notice?: string): Promise<TaskOutcome> {
  const refused = await denied(ctx);
  if (refused) return refused;
  const total = await counts(ctx);
  const last = Math.max(0, Math.ceil(total.saved / TASKS_PER_PAGE) - 1);
  const current = Math.min(Math.max(page, 0), last);
  const tasks = await ctx.tx.task.findMany({
    where: { userId: ctx.user.id, state: { not: 'DELETED' } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    skip: current * TASKS_PER_PAGE,
    take: TASKS_PER_PAGE,
  });
  return reply(ctx, 'REPLIED', 'TASK_LIST', taskListView(tasks, current, total, notice));
}

/** Button on a task card or list. */
export async function onTaskAction(
  ctx: TaskContext,
  taskId: string,
  revision: number,
  op: TaskOp,
): Promise<TaskOutcome> {
  const refused = await denied(ctx);
  if (refused) return refused;
  const task = await ownTask(ctx, taskId);
  // Foreign, deleted and nonexistent tasks are indistinguishable.
  if (!task) return reply(ctx, 'REJECTED', 'TASK_NOT_FOUND', { text: NOT_FOUND }, NOT_FOUND);
  if (op === 'v') return reply(ctx, 'REPLIED', 'TASK_CARD', taskCardView(task));
  // Read-only views (TRB-080) show the current state; the revision does not matter.
  if (op === 'lr') return showLatestResult(ctx, task.id);
  if (op === 'h') return showHistory(ctx, { taskId: task.id });
  if (task.revision !== revision) {
    return reply(
      ctx,
      'IGNORED',
      'TASK_STALE',
      taskCardView(task, 'Завдання змінилося; ось його актуальний стан.'),
      STALE_BUTTON,
    );
  }
  switch (op) {
    case 'p':
    case 'u':
      return setPaused(ctx, task, op === 'p');
    case 'd':
      return reply(ctx, 'REPLIED', 'TASK_DELETE_REQUESTED', deleteConfirmView(task));
    case 'r':
      // The one admission path (quotas, budgets, live restriction, one active run per
      // task). Available for paused tasks too (SPEC §4); the schedule is not touched.
      return admitResearch(ctx.tx, ctx.config, {
        user: ctx.user,
        chatId: ctx.chatId,
        updateId: ctx.updateId,
        now: ctx.now,
        source: { kind: 'task', taskId: task.id, revision: task.revision },
      }).then((outcome) => ({
        disposition: outcome.disposition,
        reason: outcome.reason ?? 'TASK_RUN_ACCEPTED',
        ...(outcome.runId ? { runId: outcome.runId } : {}),
      }));
    case 'dy':
      return deleteTask(ctx, task);
    default:
      return startEdit(ctx, task, op === 'en' ? 'NAME' : op === 'ep' ? 'PROMPT' : 'SCHEDULE');
  }
}

/** First occurrence after now for an active scheduled task, otherwise null. */
const nextRunOf = (
  task: Pick<Task, 'scheduleKind' | 'weekday' | 'localTime' | 'timeZone'>,
  state: Task['state'],
  now: Date,
) => (state === 'ACTIVE' ? nextOccurrenceAfter(task, now) : null);

/** Idempotent: pausing a paused task (or resuming an active one) changes nothing. */
async function setPaused(ctx: TaskContext, task: Task, pause: boolean): Promise<TaskOutcome> {
  const target = pause ? 'PAUSED' : 'ACTIVE';
  if (task.state === target) {
    return reply(
      ctx,
      'IGNORED',
      pause ? 'TASK_ALREADY_PAUSED' : 'TASK_ALREADY_ACTIVE',
      taskCardView(task, pause ? 'Завдання вже на паузі.' : 'Завдання вже активне.'),
    );
  }
  if (!pause && (await counts(ctx)).active >= limitsOfUser(ctx).activeTasks) {
    return reply(ctx, 'REJECTED', 'TASK_LIMIT_ACTIVE', taskCardView(task, activeLimitText(ctx)));
  }
  const updated = await ctx.tx.task.updateMany({
    where: { id: task.id, userId: ctx.user.id, revision: task.revision, state: task.state },
    // Resume starts from the next future occurrence: missed ones are not replayed.
    data: {
      state: target,
      revision: { increment: 1 },
      nextRunAt: nextRunOf(task, target, ctx.now),
    },
  });
  // Pausing cancels queued research of the task (its reservation is released);
  // a running request may finish and deliver (SPEC §4).
  if (updated.count === 1 && pause)
    await cancelQueuedRuns(ctx.tx, { taskId: task.id }, 'TASK_PAUSED');
  const current = await ownTask(ctx, task.id);
  if (updated.count !== 1 || !current) {
    return current
      ? reply(
          ctx,
          'IGNORED',
          'TASK_STALE',
          taskCardView(current, 'Завдання змінилося; ось його актуальний стан.'),
        )
      : reply(ctx, 'REJECTED', 'TASK_NOT_FOUND', { text: NOT_FOUND });
  }
  return reply(
    ctx,
    'REPLIED',
    pause ? 'TASK_PAUSED' : 'TASK_RESUMED',
    taskCardView(current, pause ? 'Завдання призупинено.' : 'Завдання відновлено.'),
  );
}

/** Soft delete, only at the revision the confirmation was issued for. Research history is untouched. */
async function deleteTask(ctx: TaskContext, task: Task): Promise<TaskOutcome> {
  const deleted = await ctx.tx.task.updateMany({
    where: {
      id: task.id,
      userId: ctx.user.id,
      revision: task.revision,
      state: { not: 'DELETED' },
    },
    data: { state: 'DELETED', deletedAt: new Date(), revision: { increment: 1 }, nextRunAt: null },
  });
  if (deleted.count !== 1) {
    const current = await ownTask(ctx, task.id);
    return current
      ? reply(
          ctx,
          'IGNORED',
          'TASK_STALE',
          taskCardView(current, 'Завдання змінилося; видалення скасовано.'),
        )
      : reply(ctx, 'REJECTED', 'TASK_NOT_FOUND', { text: NOT_FOUND });
  }
  // Deletion suppresses delivery of the task's results, including from a running
  // request, and cancels its queued research (releasing the reservation).
  await suppressRunDeliveries(ctx.tx, { taskId: task.id }, 'TASK_DELETED');
  await cancelQueuedRuns(ctx.tx, { taskId: task.id }, 'TASK_DELETED');
  const outcome = await showTasks(ctx, 0, `Завдання «${task.name}» видалено.`);
  return { ...outcome, reason: 'TASK_DELETED' };
}

/** Effective task limits of the sender (TRB-090): override or default, from the locked user row. */
const limitsOfUser = (ctx: TaskContext) => effectiveLimits(ctx.user, ctx.config);

const activeLimitText = (ctx: TaskContext) =>
  `Досягнуто ліміту активних завдань (${limitsOfUser(ctx).activeTasks}). Призупиніть або видаліть інше завдання.`;
const savedLimitText = (ctx: TaskContext) =>
  `Досягнуто ліміту збережених завдань (${limitsOfUser(ctx).savedTasks}). Видаліть непотрібне завдання.`;

// ---------------------------------------------------------------------------
// Drafts

type DraftRow = TaskDraft & { task: Task | null };

/** The user's open draft; `expired` drafts are reported, never resumed or saved. */
async function openDraft(ctx: TaskContext): Promise<{ draft: DraftRow; expired: boolean } | null> {
  const rows = await ctx.tx.$queryRaw<{ expired: boolean }[]>`
    SELECT expires_at <= now() AS expired FROM task_draft WHERE user_id = ${ctx.user.id}::uuid`;
  const state = rows[0];
  if (!state) return null;
  const draft = await ctx.tx.taskDraft.findUniqueOrThrow({
    where: { userId: ctx.user.id },
    include: { task: true },
  });
  return { draft, expired: state.expired };
}

function viewOf(draft: DraftRow): DraftView {
  return {
    id: draft.id,
    mode: draft.mode,
    section: draft.section,
    step: draft.step,
    data: draft.data as unknown as DraftData,
    version: draft.version,
    ...(draft.task ? { taskName: draft.task.name } : {}),
  };
}

const limitsOf = (ctx: TaskContext) => ({ promptMaxChars: ctx.config.RESEARCH_PROMPT_MAX_CHARS });

async function removeDraft(ctx: TaskContext, draft: DraftRow): Promise<void> {
  await ctx.tx.taskDraft.deleteMany({ where: { id: draft.id, userId: ctx.user.id } });
}

/** Ends an expired draft and says so; a saved task is never changed by it. */
async function expire(ctx: TaskContext, draft: DraftRow, notice?: string): Promise<TaskOutcome> {
  await removeDraft(ctx, draft);
  const text =
    draft.mode === 'CREATE'
      ? `Чернетку нового завдання прострочено (${DRAFT_TTL_HOURS} год без змін); нічого не збережено. Почніть знову: /new`
      : `Чернетку редагування прострочено (${DRAFT_TTL_HOURS} год без змін); завдання не змінено.`;
  return reply(
    ctx,
    'REPLIED',
    'DRAFT_EXPIRED',
    { text: notice ? `${text}\n\n${notice}` : text },
    'Чернетку прострочено.',
  );
}

/** An edit draft whose task was deleted (or is no longer the user's) ends safely. */
async function targetGone(ctx: TaskContext, draft: DraftRow): Promise<TaskOutcome | null> {
  if (draft.mode !== 'EDIT') return null;
  if (draft.task && draft.task.userId === ctx.user.id && draft.task.state !== 'DELETED')
    return null;
  await removeDraft(ctx, draft);
  return reply(
    ctx,
    'REJECTED',
    'DRAFT_TARGET_GONE',
    { text: 'Завдання більше не існує; редагування скасовано.' },
    'Завдання більше не існує.',
  );
}

/**
 * Stores the next step and values. Conditional on the version the change was
 * computed from; every successful change extends the expiry by 24 hours.
 */
async function storeDraft(ctx: TaskContext, draft: DraftRow, shape: DraftShape): Promise<DraftRow> {
  const updated = await ctx.tx.$executeRaw`
    UPDATE task_draft
       SET step = ${shape.step}::"DraftStep", data = ${JSON.stringify(shape.data)}::jsonb,
           version = version + 1, updated_at = now(),
           expires_at = now() + make_interval(hours => ${DRAFT_TTL_HOURS}::int)
     WHERE id = ${draft.id}::uuid AND user_id = ${ctx.user.id}::uuid AND version = ${draft.version}`;
  if (updated !== 1) throw new Error('task draft changed concurrently');
  return ctx.tx.taskDraft.findUniqueOrThrow({ where: { id: draft.id }, include: { task: true } });
}

async function insertDraft(
  ctx: TaskContext,
  draft: {
    mode: 'CREATE' | 'EDIT';
    section: DraftSection | null;
    taskId: string | null;
    baseRevision: number | null;
    data: DraftData;
  },
): Promise<DraftRow> {
  const shape = { mode: draft.mode, section: draft.section, data: draft.data };
  const step = stepSequence(shape)[0] ?? 'NAME';
  await ctx.tx.$executeRaw`
    INSERT INTO task_draft (id, user_id, mode, task_id, section, base_revision, step, data, expires_at, updated_at)
    VALUES (gen_random_uuid(), ${ctx.user.id}::uuid, ${draft.mode}::"DraftMode", ${draft.taskId}::uuid,
            ${draft.section}::"DraftSection", ${draft.baseRevision}, ${step}::"DraftStep",
            ${JSON.stringify(draft.data)}::jsonb,
            now() + make_interval(hours => ${DRAFT_TTL_HOURS}::int), now())`;
  return ctx.tx.taskDraft.findUniqueOrThrow({
    where: { userId: ctx.user.id },
    include: { task: true },
  });
}

/** `/new` and the "+ Нове завдання" button. An open draft is never discarded silently. */
export async function startCreate(ctx: TaskContext): Promise<TaskOutcome> {
  const refused = await denied(ctx);
  if (refused) return refused;
  const open = await openDraft(ctx);
  let notice: string | undefined;
  if (open?.expired) {
    await removeDraft(ctx, open.draft);
    notice = 'Попередню чернетку прострочено; її не збережено.';
  } else if (open) {
    return reply(ctx, 'REPLIED', 'DRAFT_EXISTS', draftConflictView(viewOf(open.draft), 'new'));
  }
  if ((await counts(ctx)).saved >= limitsOfUser(ctx).savedTasks) {
    return reply(ctx, 'REJECTED', 'TASK_LIMIT_SAVED', { text: savedLimitText(ctx) });
  }
  const draft = await insertDraft(ctx, {
    mode: 'CREATE',
    section: null,
    taskId: null,
    baseRevision: null,
    data: { suggestedTimeZone: ctx.user.timeZone ?? SUGGESTED_TIME_ZONE },
  });
  return reply(ctx, 'REPLIED', 'DRAFT_STARTED', stepView(viewOf(draft), notice));
}

/** Editing starts from the task's current values and remembers its revision. */
async function startEdit(
  ctx: TaskContext,
  task: Task,
  section: DraftSection,
): Promise<TaskOutcome> {
  const open = await openDraft(ctx);
  if (open && !open.expired) {
    return reply(ctx, 'REPLIED', 'DRAFT_EXISTS', draftConflictView(viewOf(open.draft), 'edit'));
  }
  if (open) await removeDraft(ctx, open.draft);
  const data: DraftData = {
    name: task.name,
    prompt: task.prompt,
    scheduleKind: task.scheduleKind,
    ...(task.weekday !== null ? { weekday: task.weekday } : {}),
    ...(task.localTime !== null ? { localTime: task.localTime } : {}),
    timeZone: task.timeZone,
    suggestedTimeZone: task.timeZone,
  };
  const draft = await insertDraft(ctx, {
    mode: 'EDIT',
    section,
    taskId: task.id,
    baseRevision: task.revision,
    data,
  });
  return reply(ctx, 'REPLIED', 'DRAFT_STARTED', stepView(viewOf(draft)));
}

/** `/cancel`: ends the open draft; a saved task is never changed. */
export async function cancelDraft(ctx: TaskContext): Promise<TaskOutcome> {
  const refused = await denied(ctx);
  if (refused) return refused;
  const open = await openDraft(ctx);
  if (!open) return reply(ctx, 'REPLIED', 'NO_DRAFT', { text: 'Немає незавершеної чернетки.' });
  await removeDraft(ctx, open.draft);
  return reply(ctx, 'REPLIED', 'DRAFT_CANCELLED', { text: cancelledText(open.draft) });
}

const cancelledText = (draft: DraftRow) =>
  draft.mode === 'CREATE'
    ? 'Створення завдання скасовано; нічого не збережено.'
    : 'Редагування скасовано; завдання не змінено.';

/**
 * Free text from an active user. Returns null when no draft is open (the
 * caller then shows help); commands never reach this function.
 */
export async function onDraftText(ctx: TaskContext, text: string): Promise<TaskOutcome | null> {
  const refused = await denied(ctx);
  if (refused) return refused;
  const open = await openDraft(ctx);
  if (!open) return null;
  if (open.expired) return expire(ctx, open.draft);
  return (
    (await targetGone(ctx, open.draft)) ?? applyAndReply(ctx, open.draft, { type: 'text', text })
  );
}

async function applyAndReply(
  ctx: TaskContext,
  draft: DraftRow,
  event: DraftEvent,
): Promise<TaskOutcome> {
  const view = viewOf(draft);
  const transition = applyEvent(view, event, limitsOf(ctx));
  if (!transition.ok) {
    // Nothing changes, so the buttons already shown stay valid.
    const notice = ERROR_TEXT(transition.error, ctx.config.RESEARCH_PROMPT_MAX_CHARS);
    return reply(ctx, 'REJECTED', `DRAFT_${transition.error}`, stepView(view, notice), notice);
  }
  const stored = await storeDraft(ctx, draft, transition.shape);
  return reply(ctx, 'REPLIED', 'DRAFT_STEP', stepView(viewOf(stored)));
}

const DRAFT_EVENTS: Partial<Record<DraftOp, DraftEvent>> = {
  b: { type: 'back' },
  k: { type: 'keep' },
  z: { type: 'suggested_zone' },
  km: { type: 'kind', kind: 'MANUAL' },
  kd: { type: 'kind', kind: 'DAILY' },
  kw: { type: 'kind', kind: 'WEEKLY' },
};

/**
 * Draft button. Acts only on the user's own open draft with the ID the button
 * was issued for, at that version; the query is scoped to the user, so a
 * foreign draft ID never matches.
 */
export async function onDraftAction(
  ctx: TaskContext,
  draftId: string,
  version: number,
  op: DraftOp,
): Promise<TaskOutcome> {
  const refused = await denied(ctx);
  if (refused) return refused;
  const open = await openDraft(ctx);
  if (!open) return { disposition: 'IGNORED', reason: 'DRAFT_NONE', callbackAnswer: STALE_BUTTON };
  // Identity first: a button of an earlier (or foreign) draft must not touch this
  // one in any way, not even by ending it as expired.
  if (open.draft.id !== draftId) {
    return { disposition: 'IGNORED', reason: 'CALLBACK_STALE', callbackAnswer: STALE_BUTTON };
  }
  if (open.expired) return expire(ctx, open.draft);
  const { draft } = open;
  if (draft.version !== version) {
    return { disposition: 'IGNORED', reason: 'CALLBACK_STALE', callbackAnswer: STALE_BUTTON };
  }
  const gone = await targetGone(ctx, draft);
  if (gone) return gone;
  switch (op) {
    case 'x':
      await removeDraft(ctx, draft);
      return reply(ctx, 'REPLIED', 'DRAFT_CANCELLED', { text: cancelledText(draft) });
    case 'r': {
      // Resuming is activity: extend the expiry (and reissue the buttons).
      const resumed = await storeDraft(ctx, draft, viewOf(draft));
      return reply(ctx, 'REPLIED', 'DRAFT_RESUMED', stepView(viewOf(resumed)));
    }
    case 'n': {
      await removeDraft(ctx, draft);
      const outcome = await startCreate(ctx);
      return {
        ...outcome,
        reason: outcome.reason === 'DRAFT_STARTED' ? 'DRAFT_REPLACED' : outcome.reason,
      };
    }
    case 's':
      return draft.mode === 'CREATE' ? saveCreate(ctx, draft) : saveEdit(ctx, draft);
    default: {
      const event: DraftEvent | undefined = op.startsWith('w')
        ? { type: 'weekday', weekday: Number(op.slice(1)) }
        : DRAFT_EVENTS[op];
      if (!event)
        return { disposition: 'IGNORED', reason: 'CALLBACK_UNKNOWN', callbackAnswer: STALE_BUTTON };
      return applyAndReply(ctx, draft, event);
    }
  }
}

function previewOnly(
  ctx: TaskContext,
  draft: DraftRow,
  reason: string,
  notice: string,
): Promise<TaskOutcome> {
  return reply(ctx, 'REJECTED', reason, stepView(viewOf(draft), notice), notice);
}

/**
 * Creates exactly one task and ends the draft in the same transaction. A
 * repeated Save finds no draft (or a newer version); `created_from_draft_id`
 * is unique as a last guard.
 */
async function saveCreate(ctx: TaskContext, draft: DraftRow): Promise<TaskOutcome> {
  if (draft.step !== 'PREVIEW')
    return previewOnly(ctx, draft, 'DRAFT_NOT_APPLICABLE', ERROR_TEXT('NOT_APPLICABLE', 0));
  const config = completeConfiguration(draft.data as unknown as DraftData, limitsOf(ctx));
  if (!config)
    return previewOnly(ctx, draft, 'DRAFT_INCOMPLETE', 'Чернетка неповна; перевірте кроки.');
  const total = await counts(ctx);
  if (total.saved >= limitsOfUser(ctx).savedTasks) {
    return previewOnly(ctx, draft, 'TASK_LIMIT_SAVED', savedLimitText(ctx));
  }
  if (total.active >= limitsOfUser(ctx).activeTasks) {
    return previewOnly(ctx, draft, 'TASK_LIMIT_ACTIVE', activeLimitText(ctx));
  }
  const task = await ctx.tx.task.create({
    data: {
      userId: ctx.user.id,
      ...config,
      createdFromDraftId: draft.id,
      // Saving never runs research; the first scheduled occurrence is in the future.
      nextRunAt: nextRunOf(config, 'ACTIVE', ctx.now),
    },
  });
  await removeDraft(ctx, draft);
  return reply(
    ctx,
    'REPLIED',
    'TASK_CREATED',
    taskCardView(task, 'Завдання збережено. Дослідження не запускалося.'),
    'Збережено.',
  );
}

/** Applies the edited section only if the task is still at the revision the edit started from. */
async function saveEdit(ctx: TaskContext, draft: DraftRow): Promise<TaskOutcome> {
  if (draft.step !== 'PREVIEW')
    return previewOnly(ctx, draft, 'DRAFT_NOT_APPLICABLE', ERROR_TEXT('NOT_APPLICABLE', 0));
  const data = draft.data as unknown as DraftData;
  const changes = editChanges(draft.section, data, ctx.config.RESEARCH_PROMPT_MAX_CHARS);
  if (!changes || !draft.taskId || draft.baseRevision === null || !draft.task) {
    return previewOnly(ctx, draft, 'DRAFT_INCOMPLETE', 'Чернетка неповна; перевірте кроки.');
  }
  // The revision condition guarantees the task state read with the draft is current.
  // A prompt or schedule edit replaces any pending occurrence with the first one
  // strictly after now: the new schedule, or the task's existing one for a prompt
  // edit, so a past-due occurrence is never run later with the new settings. Paused
  // and manual tasks keep none. A name edit does not touch the schedule.
  const schedule =
    draft.section === 'SCHEDULE' || draft.section === 'PROMPT'
      ? {
          nextRunAt: nextRunOf(
            draft.section === 'SCHEDULE'
              ? (changes as Pick<Task, 'scheduleKind' | 'weekday' | 'localTime' | 'timeZone'>)
              : draft.task,
            draft.task.state,
            ctx.now,
          ),
        }
      : {};
  const updated = await ctx.tx.task.updateMany({
    where: {
      id: draft.taskId,
      userId: ctx.user.id,
      revision: draft.baseRevision,
      state: { not: 'DELETED' },
    },
    data: { ...changes, ...schedule, revision: { increment: 1 } },
  });
  // Queued research built from the old prompt or schedule is cancelled (its
  // reservation released); a running run keeps its immutable snapshot (SPEC §4).
  if (updated.count === 1 && (draft.section === 'PROMPT' || draft.section === 'SCHEDULE')) {
    await cancelQueuedRuns(ctx.tx, { taskId: draft.taskId }, 'TASK_EDITED');
  }
  await removeDraft(ctx, draft);
  const current = await ownTask(ctx, draft.taskId);
  if (updated.count !== 1) {
    return current
      ? reply(
          ctx,
          'REJECTED',
          'TASK_EDIT_STALE',
          taskCardView(
            current,
            'Завдання змінилося після початку редагування, тому зміни не збережено. Ось актуальний стан; почніть редагування знову.',
          ),
          'Зміни не збережено.',
        )
      : reply(ctx, 'REJECTED', 'DRAFT_TARGET_GONE', {
          text: 'Завдання більше не існує; редагування скасовано.',
        });
  }
  return reply(
    ctx,
    'REPLIED',
    'TASK_UPDATED',
    taskCardView(
      current ?? (await ctx.tx.task.findUniqueOrThrow({ where: { id: draft.taskId } })),
      'Зміни збережено.',
    ),
    'Збережено.',
  );
}

function editChanges(
  section: DraftSection | null,
  data: DraftData,
  promptMax: number,
): Prisma.TaskUpdateManyMutationInput | null {
  switch (section) {
    case 'NAME': {
      const name = validateName(data.name ?? '');
      return name.ok ? { name: name.value } : null;
    }
    case 'PROMPT': {
      const prompt = validatePrompt(data.prompt ?? '', promptMax);
      return prompt.ok ? { prompt: prompt.value } : null;
    }
    case 'SCHEDULE': {
      const schedule = scheduleOf(data);
      const complete = completeConfiguration(
        { ...data, name: 'x', prompt: 'x' },
        { promptMaxChars: promptMax },
      );
      return schedule && complete
        ? {
            scheduleKind: complete.scheduleKind,
            weekday: complete.weekday,
            localTime: complete.localTime,
            timeZone: complete.timeZone,
          }
        : null;
    }
    default:
      return null;
  }
}
