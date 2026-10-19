import { normalizeTimeZone } from '../identity/time-zone';
import {
  isWeekday,
  parseLocalTime,
  validateName,
  validatePrompt,
  type FieldError,
  type ScheduleKind,
} from './task-validation';

/**
 * Pure state machine of the task dialog (TRB-040). Persistence, ownership and
 * staleness checks live in task-service.ts; this module only decides the next
 * step and values for one event.
 *
 * Creation: NAME → PROMPT → SCHEDULE_KIND → WEEKDAY (weekly) → LOCAL_TIME
 * (daily, weekly) → TIME_ZONE → PREVIEW. Editing runs only its section's steps
 * and then PREVIEW.
 */
export type DraftStep =
  'NAME' | 'PROMPT' | 'SCHEDULE_KIND' | 'WEEKDAY' | 'LOCAL_TIME' | 'TIME_ZONE' | 'PREVIEW';
export type DraftSection = 'NAME' | 'PROMPT' | 'SCHEDULE';

export interface DraftData {
  name?: string;
  prompt?: string;
  scheduleKind?: ScheduleKind;
  weekday?: number;
  localTime?: string;
  timeZone?: string;
  /** Zone offered by the "use suggested" button: the user's zone (creation) or the task's (editing). */
  suggestedTimeZone: string;
}

export interface DraftShape {
  mode: 'CREATE' | 'EDIT';
  section: DraftSection | null;
  step: DraftStep;
  data: DraftData;
}

export type DraftEvent =
  | { type: 'text'; text: string }
  | { type: 'kind'; kind: ScheduleKind }
  | { type: 'weekday'; weekday: number }
  | { type: 'suggested_zone' }
  | { type: 'keep' }
  | { type: 'back' };

export type DraftError = FieldError | 'NEEDS_BUTTON' | 'NOTHING_TO_KEEP' | 'NOT_APPLICABLE';

export type Transition = { ok: true; shape: DraftShape } | { ok: false; error: DraftError };

const SCHEDULE_STEPS = (data: DraftData): DraftStep[] => [
  'SCHEDULE_KIND',
  ...(data.scheduleKind === 'WEEKLY' ? (['WEEKDAY'] as const) : []),
  ...(data.scheduleKind && data.scheduleKind !== 'MANUAL' ? (['LOCAL_TIME'] as const) : []),
  'TIME_ZONE',
];

/** Steps of this dialog given the values entered so far. */
export function stepSequence(shape: Pick<DraftShape, 'mode' | 'section' | 'data'>): DraftStep[] {
  if (shape.mode === 'CREATE') {
    return ['NAME', 'PROMPT', ...SCHEDULE_STEPS(shape.data), 'PREVIEW'];
  }
  switch (shape.section) {
    case 'NAME':
      return ['NAME', 'PREVIEW'];
    case 'PROMPT':
      return ['PROMPT', 'PREVIEW'];
    default:
      return [...SCHEDULE_STEPS(shape.data), 'PREVIEW'];
  }
}

export function previousStep(shape: DraftShape): DraftStep | null {
  const steps = stepSequence(shape);
  const index = steps.indexOf(shape.step);
  return index > 0 ? (steps[index - 1] ?? null) : null;
}

function advance(shape: DraftShape, data: DraftData): Transition {
  const steps = stepSequence({ ...shape, data });
  const next = steps[steps.indexOf(shape.step) + 1] ?? 'PREVIEW';
  return { ok: true, shape: { ...shape, data, step: next } };
}

const TEXT_STEPS: readonly DraftStep[] = ['NAME', 'PROMPT', 'LOCAL_TIME', 'TIME_ZONE'];

/** Whether free text is a value for this step (otherwise a button is required). */
export function acceptsText(step: DraftStep): boolean {
  return TEXT_STEPS.includes(step);
}

/** Current value shown for "keep" at text steps, if any. */
export function currentValue(shape: DraftShape): string | undefined {
  switch (shape.step) {
    case 'NAME':
      return shape.data.name;
    case 'PROMPT':
      return shape.data.prompt;
    case 'LOCAL_TIME':
      return shape.data.localTime;
    case 'TIME_ZONE':
      return shape.data.timeZone;
    default:
      return undefined;
  }
}

export function applyEvent(
  shape: DraftShape,
  event: DraftEvent,
  limits: { promptMaxChars: number },
): Transition {
  const { step, data } = shape;
  if (event.type === 'back') {
    const previous = previousStep(shape);
    // Values are kept when moving back; they are offered again as "keep".
    return previous
      ? { ok: true, shape: { ...shape, step: previous } }
      : { ok: false, error: 'NOT_APPLICABLE' };
  }
  if (event.type === 'keep') {
    if (!acceptsText(step)) return { ok: false, error: 'NOT_APPLICABLE' };
    return currentValue(shape) === undefined
      ? { ok: false, error: 'NOTHING_TO_KEEP' }
      : advance(shape, data);
  }
  if (event.type === 'text') {
    const field = (() => {
      switch (step) {
        case 'NAME':
          return { result: validateName(event.text), key: 'name' as const };
        case 'PROMPT':
          return {
            result: validatePrompt(event.text, limits.promptMaxChars),
            key: 'prompt' as const,
          };
        case 'LOCAL_TIME':
          return { result: parseLocalTime(event.text), key: 'localTime' as const };
        case 'TIME_ZONE': {
          const zone = normalizeTimeZone(event.text);
          return {
            result: zone
              ? ({ ok: true, value: zone } as const)
              : ({ ok: false, error: 'ZONE_INVALID' } as const),
            key: 'timeZone' as const,
          };
        }
        default:
          return null;
      }
    })();
    if (!field) return { ok: false, error: 'NEEDS_BUTTON' };
    if (!field.result.ok) return { ok: false, error: field.result.error };
    return advance(shape, { ...data, [field.key]: field.result.value });
  }
  if (event.type === 'kind') {
    if (step !== 'SCHEDULE_KIND') return { ok: false, error: 'NOT_APPLICABLE' };
    // Fields the new kind does not use are cleared, never carried over.
    const next: DraftData = { ...data, scheduleKind: event.kind };
    if (event.kind !== 'WEEKLY') delete next.weekday;
    if (event.kind === 'MANUAL') delete next.localTime;
    return advance(shape, next);
  }
  if (event.type === 'weekday') {
    if (step !== 'WEEKDAY' || !isWeekday(event.weekday)) {
      return { ok: false, error: 'NOT_APPLICABLE' };
    }
    return advance(shape, { ...data, weekday: event.weekday });
  }
  // suggested_zone
  if (step !== 'TIME_ZONE') return { ok: false, error: 'NOT_APPLICABLE' };
  const zone = normalizeTimeZone(data.suggestedTimeZone);
  return zone ? advance(shape, { ...data, timeZone: zone }) : { ok: false, error: 'ZONE_INVALID' };
}

export interface TaskConfig {
  name: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  weekday: number | null;
  localTime: string | null;
  timeZone: string;
}

/**
 * The complete configuration a creation draft would save, revalidated, or null
 * when anything is missing or inconsistent (a tampered or partial draft).
 */
export function completeConfiguration(
  data: DraftData,
  limits: { promptMaxChars: number },
): TaskConfig | null {
  const name = validateName(data.name ?? '');
  const prompt = validatePrompt(data.prompt ?? '', limits.promptMaxChars);
  const zone = data.timeZone ? normalizeTimeZone(data.timeZone) : null;
  const schedule = scheduleOf(data);
  if (!name.ok || !prompt.ok || !zone || !schedule) return null;
  return { name: name.value, prompt: prompt.value, timeZone: zone, ...schedule };
}

/** Schedule part of a draft, validated; null when incomplete or inconsistent. */
export function scheduleOf(
  data: DraftData,
): Pick<TaskConfig, 'scheduleKind' | 'weekday' | 'localTime'> | null {
  const time = data.localTime === undefined ? null : parseLocalTime(data.localTime);
  switch (data.scheduleKind) {
    case 'MANUAL':
      return { scheduleKind: 'MANUAL', weekday: null, localTime: null };
    case 'DAILY':
      return time?.ok ? { scheduleKind: 'DAILY', weekday: null, localTime: time.value } : null;
    case 'WEEKLY':
      return time?.ok && isWeekday(data.weekday)
        ? { scheduleKind: 'WEEKLY', weekday: data.weekday, localTime: time.value }
        : null;
    default:
      return null;
  }
}
