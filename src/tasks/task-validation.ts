import { codePointLength } from '../research/report';

/** SPEC §3 proposed name limit, also enforced by a database check. */
export const TASK_NAME_MAX_CHARS = 100;
/** SPEC §3: a draft expires after 24 hours without a successful step. */
export const DRAFT_TTL_HOURS = 24;

export type ScheduleKind = 'MANUAL' | 'DAILY' | 'WEEKLY';

/** ISO weekdays, 1 = Monday … 7 = Sunday. */
export const WEEKDAY_NAMES = [
  'понеділок',
  'вівторок',
  'середа',
  'четвер',
  "п'ятниця",
  'субота',
  'неділя',
] as const;

export type FieldError =
  | 'NAME_EMPTY'
  | 'NAME_TOO_LONG'
  | 'NAME_MULTILINE'
  | 'PROMPT_EMPTY'
  | 'PROMPT_TOO_LONG'
  | 'TIME_INVALID'
  | 'ZONE_INVALID';

export type Validated = { ok: true; value: string } | { ok: false; error: FieldError };

export function validateName(input: string): Validated {
  const value = input.trim();
  if (value.length === 0) return { ok: false, error: 'NAME_EMPTY' };
  if (/[\r\n]/.test(value)) return { ok: false, error: 'NAME_MULTILINE' };
  if (codePointLength(value) > TASK_NAME_MAX_CHARS) return { ok: false, error: 'NAME_TOO_LONG' };
  return { ok: true, value };
}

export function validatePrompt(input: string, maxChars: number): Validated {
  const value = input.trim();
  if (value.length === 0) return { ok: false, error: 'PROMPT_EMPTY' };
  if (codePointLength(value) > maxChars) return { ok: false, error: 'PROMPT_TOO_LONG' };
  return { ok: true, value };
}

/** Local wall-clock time: "H:mm" or "HH:mm", 00:00-23:59, normalised to "HH:mm". */
export function parseLocalTime(input: string): Validated {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(input.trim());
  if (!match) return { ok: false, error: 'TIME_INVALID' };
  return { ok: true, value: `${(match[1] ?? '').padStart(2, '0')}:${match[2] ?? ''}` };
}

export function isWeekday(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7;
}

export interface ScheduleView {
  scheduleKind: ScheduleKind;
  weekday: number | null;
  localTime: string | null;
}

/** "Вручну", "Щодня о 09:00", "Щотижня: понеділок о 09:00". */
export function describeSchedule(schedule: ScheduleView): string {
  switch (schedule.scheduleKind) {
    case 'MANUAL':
      return 'Вручну (без розкладу)';
    case 'DAILY':
      return `Щодня о ${schedule.localTime ?? '?'}`;
    case 'WEEKLY':
      return `Щотижня: ${WEEKDAY_NAMES[(schedule.weekday ?? 1) - 1] ?? '?'} о ${schedule.localTime ?? '?'}`;
  }
}
