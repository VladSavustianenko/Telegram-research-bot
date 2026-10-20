import {
  TASK_NEW_CALLBACK,
  draftCallbackData,
  historyCallbackData,
  taskCallbackData,
  taskListCallbackData,
} from '../telegram/callback-data';
import { formatInZone } from '../scheduling/recurrence';
import type { InlineKeyboard } from '../telegram/telegram-sender';
import { acceptsText, currentValue, previousStep, type DraftShape } from './draft-flow';
import {
  TASK_NAME_MAX_CHARS,
  WEEKDAY_NAMES,
  describeSchedule,
  type ScheduleKind,
  type ScheduleView,
} from './task-validation';

/** Plain text (escaped when stored as a delivery) and optional buttons. */
export interface View {
  text: string;
  keyboard?: InlineKeyboard;
}

type Button = InlineKeyboard['inline_keyboard'][number][number];

export const TASKS_PER_PAGE = 5;
const PROMPT_PREVIEW_CHARS = 300;
const BUTTON_NAME_CHARS = 40;

export interface DraftView extends DraftShape {
  /** Bound into every draft button, so a button never acts on another draft. */
  id: string;
  version: number;
  /** Name of the task being edited (EDIT only). */
  taskName?: string;
}

export interface TaskView extends ScheduleView {
  id: string;
  name: string;
  prompt: string;
  timeZone: string;
  state: 'ACTIVE' | 'PAUSED' | 'DELETED';
  revision: number;
  /** Next planned occurrence (UTC), active scheduled tasks only (TRB-070). */
  nextRunAt?: Date | null;
}

/** How scheduled runs behave; shown where a schedule is chosen (TRB-070, SPEC §4). */
export const SCHEDULE_NOTE =
  'Запуски за розкладом — у вказаний місцевий час завдання (з урахуванням переходу на літній/зимовий час). ' +
  'Якщо бот був недоступний, виконується щонайбільше один пропущений запуск, не старший за 24 год; ' +
  'звіт тоді показує затримку. Запуск не відбудеться, якщо попередній ще виконується або вичерпано ліміти /usage.';

/** The card's line about automatic runs. */
export function nextRunLine(task: TaskView): string {
  if (task.scheduleKind === 'MANUAL') return 'Запуски: лише вручну («Запустити зараз»).';
  if (task.state !== 'ACTIVE') {
    return 'Автоматичні запуски на паузі; після відновлення — з наступного часу за розкладом, пропущені не надолужуються.';
  }
  return task.nextRunAt
    ? `Наступний запуск: ${formatInZone(task.nextRunAt, task.timeZone)} (${task.timeZone}).`
    : 'Наступний запуск: буде обчислено найближчим часом.';
}

export function truncate(text: string, maxCodePoints: number): string {
  const points = Array.from(text);
  return points.length <= maxCodePoints ? text : `${points.slice(0, maxCodePoints).join('')}…`;
}

const KIND_LABELS: Record<ScheduleKind, string> = {
  MANUAL: 'Вручну',
  DAILY: 'Щодня',
  WEEKLY: 'Щотижня',
};

function header(draft: DraftView): string {
  return draft.mode === 'CREATE'
    ? 'Нове завдання'
    : `Редагування завдання «${draft.taskName ?? ''}»`;
}

function navigation(draft: DraftView): Button[] {
  const row: Button[] = [];
  if (previousStep(draft)) {
    row.push({ text: '« Назад', callback_data: draftCallbackData(draft.id, draft.version, 'b') });
  }
  row.push({ text: 'Скасувати', callback_data: draftCallbackData(draft.id, draft.version, 'x') });
  return row;
}

/** The question for the draft's current step, with its buttons. */
export function stepView(draft: DraftView, notice?: string): View {
  if (draft.step === 'PREVIEW') return previewView(draft, notice);
  const { id, data, version } = draft;
  const lines: string[] = [];
  const rows: Button[][] = [];
  const mark = (selected: boolean, label: string) => (selected ? `✓ ${label}` : label);
  switch (draft.step) {
    case 'NAME':
      lines.push(`Надішліть назву завдання (до ${TASK_NAME_MAX_CHARS} символів, один рядок).`);
      break;
    case 'PROMPT':
      lines.push(
        'Надішліть запит для дослідження: що шукати й за якими умовами.',
        'Для подій і новин вкажіть період явно, наприклад «наступні 7 днів» або «поточний тиждень».',
      );
      break;
    case 'SCHEDULE_KIND':
      lines.push('Як запускати завдання?');
      rows.push(
        (['MANUAL', 'DAILY', 'WEEKLY'] as const).map((kind) => ({
          text: mark(data.scheduleKind === kind, KIND_LABELS[kind]),
          callback_data: draftCallbackData(
            id,
            version,
            kind === 'MANUAL' ? 'km' : kind === 'DAILY' ? 'kd' : 'kw',
          ),
        })),
      );
      break;
    case 'WEEKDAY':
      lines.push('Оберіть день тижня.');
      for (const days of [
        [1, 2, 3, 4],
        [5, 6, 7],
      ]) {
        rows.push(
          days.map((day) => ({
            text: mark(data.weekday === day, WEEKDAY_NAMES[day - 1] ?? ''),
            callback_data: draftCallbackData(id, version, `w${day}`),
          })),
        );
      }
      break;
    case 'LOCAL_TIME':
      lines.push('Надішліть місцевий час запуску у форматі ГГ:ХХ, наприклад 09:00.');
      break;
    case 'TIME_ZONE':
      lines.push(
        'Часовий пояс завдання: за ним тлумачаться час запуску, дати й тижні.',
        'Натисніть кнопку або надішліть назву IANA, наприклад Europe/Warsaw.',
      );
      rows.push([
        {
          text: `Використати ${data.suggestedTimeZone}`,
          callback_data: draftCallbackData(id, version, 'z'),
        },
      ]);
      break;
  }
  const current = currentValue(draft);
  if (acceptsText(draft.step) && current !== undefined) {
    lines.push(`Зараз: ${truncate(current, PROMPT_PREVIEW_CHARS)}`);
    rows.push([{ text: 'Залишити як є', callback_data: draftCallbackData(id, version, 'k') }]);
  }
  rows.push(navigation(draft));
  return {
    text: [notice, header(draft), '', ...lines].filter((line) => line !== undefined).join('\n'),
    keyboard: { inline_keyboard: rows },
  };
}

/** Exactly what Save stores: the full name, prompt, schedule and zone. */
export function previewView(draft: DraftView, notice?: string): View {
  const { id, data, version } = draft;
  const editing = draft.mode === 'EDIT' ? draft.section : null;
  const lines = [
    ...(notice ? [notice] : []),
    header(draft),
    '',
    'Перевірте й збережіть:',
    ...(editing === null || editing === 'NAME' ? [`Назва: ${data.name ?? ''}`] : []),
    ...(editing === null || editing === 'SCHEDULE'
      ? [
          `Розклад: ${describeSchedule({
            scheduleKind: data.scheduleKind ?? 'MANUAL',
            weekday: data.weekday ?? null,
            localTime: data.localTime ?? null,
          })}`,
          `Часовий пояс: ${data.timeZone ?? ''}`,
        ]
      : []),
    ...(editing === null || editing === 'PROMPT' ? ['Запит:', data.prompt ?? ''] : []),
    '',
    'Збереження не запускає дослідження.',
    ...((editing === null || editing === 'SCHEDULE') && data.scheduleKind !== 'MANUAL'
      ? [SCHEDULE_NOTE]
      : []),
  ];
  return {
    text: lines.join('\n'),
    keyboard: {
      inline_keyboard: [
        [{ text: 'Зберегти', callback_data: draftCallbackData(id, version, 's') }],
        navigation(draft),
      ],
    },
  };
}

/** Shown instead of starting a second dialog: nothing entered is discarded silently. */
export function draftConflictView(draft: DraftView, purpose: 'new' | 'edit'): View {
  const what =
    draft.mode === 'CREATE'
      ? `створення завдання${draft.data.name ? ` «${draft.data.name}»` : ''}`
      : `редагування завдання «${draft.taskName ?? ''}»`;
  const rows: Button[][] = [
    [{ text: 'Продовжити', callback_data: draftCallbackData(draft.id, draft.version, 'r') }],
  ];
  rows.push(
    purpose === 'new'
      ? [
          {
            text: 'Відкинути й почати нове',
            callback_data: draftCallbackData(draft.id, draft.version, 'n'),
          },
        ]
      : [
          {
            text: 'Відкинути чернетку',
            callback_data: draftCallbackData(draft.id, draft.version, 'x'),
          },
        ],
  );
  return {
    text: `У вас є незавершене ${what}. Продовжити його чи відкинути?`,
    keyboard: { inline_keyboard: rows },
  };
}

export function taskCardView(task: TaskView, notice?: string): View {
  const id = task.id;
  const rev = task.revision;
  const lines = [
    ...(notice ? [notice, ''] : []),
    `Завдання: ${task.name}`,
    `Стан: ${task.state === 'ACTIVE' ? 'активне' : 'на паузі'}`,
    `Розклад: ${describeSchedule(task)}`,
    `Часовий пояс: ${task.timeZone}`,
    nextRunLine(task),
    `Запит: ${truncate(task.prompt, PROMPT_PREVIEW_CHARS)}`,
  ];
  return {
    text: lines.join('\n'),
    keyboard: {
      inline_keyboard: [
        [
          { text: 'Назва', callback_data: taskCallbackData(id, rev, 'en') },
          { text: 'Запит', callback_data: taskCallbackData(id, rev, 'ep') },
          { text: 'Розклад', callback_data: taskCallbackData(id, rev, 'es') },
        ],
        [
          task.state === 'ACTIVE'
            ? { text: 'Пауза', callback_data: taskCallbackData(id, rev, 'p') }
            : { text: 'Відновити', callback_data: taskCallbackData(id, rev, 'u') },
          { text: 'Видалити', callback_data: taskCallbackData(id, rev, 'd') },
        ],
        [
          { text: 'Останній результат', callback_data: taskCallbackData(id, rev, 'lr') },
          { text: 'Історія', callback_data: taskCallbackData(id, rev, 'h') },
        ],
        [
          { text: 'Запустити зараз', callback_data: taskCallbackData(id, rev, 'r') },
          { text: '« До списку', callback_data: taskListCallbackData(0) },
        ],
      ],
    },
  };
}

export function deleteConfirmView(task: TaskView): View {
  return {
    text:
      `Видалити завдання «${task.name}»? Його не можна буде відновити; ` +
      'збережені результати досліджень залишаться.',
    keyboard: {
      inline_keyboard: [
        [
          { text: 'Так, видалити', callback_data: taskCallbackData(task.id, task.revision, 'dy') },
          { text: 'Ні', callback_data: taskCallbackData(task.id, task.revision, 'v') },
        ],
      ],
    },
  };
}

export function taskListView(
  tasks: readonly TaskView[],
  page: number,
  counts: { saved: number; active: number; savedLimit: number; activeLimit: number },
  notice?: string,
): View {
  const newButton: Button = { text: '+ Нове завдання', callback_data: TASK_NEW_CALLBACK };
  const historyButton: Button = {
    text: 'Історія запусків',
    callback_data: historyCallbackData('all'),
  };
  if (counts.saved === 0) {
    return {
      text: [...(notice ? [notice, ''] : []), 'Завдань ще немає.'].join('\n'),
      keyboard: { inline_keyboard: [[newButton, historyButton]] },
    };
  }
  const pages = Math.max(1, Math.ceil(counts.saved / TASKS_PER_PAGE));
  const lines = [
    ...(notice ? [notice, ''] : []),
    `Ваші завдання: ${counts.saved} з ${counts.savedLimit}, активних ${counts.active} з ${counts.activeLimit}` +
      (pages > 1 ? ` (сторінка ${page + 1} з ${pages})` : '') +
      ':',
    ...tasks.map(
      (task, index) =>
        `${page * TASKS_PER_PAGE + index + 1}. ${task.name} — ${describeSchedule(task)}` +
        (task.state === 'PAUSED' ? ' (на паузі)' : ''),
    ),
  ];
  const rows: Button[][] = tasks.map((task) => [
    {
      text: truncate(task.name, BUTTON_NAME_CHARS),
      callback_data: taskCallbackData(task.id, task.revision, 'v'),
    },
  ]);
  const paging: Button[] = [];
  if (page > 0) paging.push({ text: '«', callback_data: taskListCallbackData(page - 1) });
  if (page + 1 < pages) paging.push({ text: '»', callback_data: taskListCallbackData(page + 1) });
  if (paging.length > 0) rows.push(paging);
  rows.push([newButton, historyButton]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}
