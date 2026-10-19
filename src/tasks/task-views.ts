import {
  TASK_NEW_CALLBACK,
  draftCallbackData,
  taskCallbackData,
  taskListCallbackData,
} from '../telegram/callback-data';
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
}

/** Scheduling is configuration only until TRB-070; said once, briefly, wherever a schedule is shown. */
export const NOT_YET_SCHEDULED =
  'Автоматичні запуски за розкладом і запуск завдання з картки ще не працюють. ' +
  'Щоб дослідити зараз, надішліть /research <запит>.';

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
    ...(editing === null || editing === 'SCHEDULE' ? [NOT_YET_SCHEDULED] : []),
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
    `Запит: ${truncate(task.prompt, PROMPT_PREVIEW_CHARS)}`,
    '',
    NOT_YET_SCHEDULED,
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
        [{ text: '« До списку', callback_data: taskListCallbackData(0) }],
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
  if (counts.saved === 0) {
    return {
      text: [...(notice ? [notice, ''] : []), 'Завдань ще немає.'].join('\n'),
      keyboard: { inline_keyboard: [[newButton]] },
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
  rows.push([newButton]);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}
