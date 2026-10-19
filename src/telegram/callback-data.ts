/**
 * Inline-button payloads. Callback data is client-supplied: it never carries
 * a user or owner ID and is only a request about the presser's own records,
 * revalidated against the current database state. At most 64 bytes
 * (Telegram's limit). Formats:
 *   tz:<revision>:<zone>          confirm <zone> as the sender's time zone (onboarding)
 *   d:<version>:<op>              act on the sender's open task draft at <version>
 *   t:<task id>:<revision>:<op>   act on the sender's task at <revision>
 *   tl:<page>                     task list page
 *   tn                            start creating a task
 */
const MAX_CALLBACK_BYTES = 64;
const TIME_ZONE_CALLBACK = /^tz:(0|[1-9]\d{0,8}):([A-Za-z][A-Za-z0-9_+\-/]{0,39})$/;
const DRAFT_CALLBACK = /^d:(0|[1-9]\d{0,8}):(b|x|k|s|r|n|km|kd|kw|w[1-7]|z)$/;
const TASK_CALLBACK =
  /^t:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9]\d{0,8}):(v|en|ep|es|p|u|d|dy)$/;
const LIST_CALLBACK = /^tl:(0|[1-9]\d{0,3})$/;

/**
 * Draft operations: b back, x cancel, k keep the current value, s save,
 * r resume, n discard and start a new task, km/kd/kw schedule kind,
 * w1-w7 weekday, z use the suggested time zone.
 */
export type DraftOp = 'b' | 'x' | 'k' | 's' | 'r' | 'n' | 'km' | 'kd' | 'kw' | `w${number}` | 'z';
/**
 * Task operations: v view card, en/ep/es edit name/prompt/schedule, p pause,
 * u resume, d ask to delete, dy confirm deletion.
 */
export type TaskOp = 'v' | 'en' | 'ep' | 'es' | 'p' | 'u' | 'd' | 'dy';

export type CallbackAction =
  | { kind: 'confirm_time_zone'; revision: number; zone: string }
  | { kind: 'draft'; version: number; op: DraftOp }
  | { kind: 'task'; taskId: string; revision: number; op: TaskOp }
  | { kind: 'task_list'; page: number }
  | { kind: 'task_new' };

function bounded(data: string): string {
  if (Buffer.byteLength(data) > MAX_CALLBACK_BYTES) throw new Error('callback data too long');
  return data;
}

export function timeZoneCallbackData(revision: number, zone: string): string {
  const data = `tz:${revision}:${zone}`;
  if (!TIME_ZONE_CALLBACK.test(data)) throw new Error('time zone callback data out of bounds');
  return bounded(data);
}

export function draftCallbackData(version: number, op: DraftOp): string {
  const data = `d:${version}:${op}`;
  if (!DRAFT_CALLBACK.test(data)) throw new Error('draft callback data out of bounds');
  return bounded(data);
}

export function taskCallbackData(taskId: string, revision: number, op: TaskOp): string {
  const data = `t:${taskId}:${revision}:${op}`;
  if (!TASK_CALLBACK.test(data)) throw new Error('task callback data out of bounds');
  return bounded(data);
}

export function taskListCallbackData(page: number): string {
  const data = `tl:${page}`;
  if (!LIST_CALLBACK.test(data)) throw new Error('task list callback data out of bounds');
  return data;
}

export const TASK_NEW_CALLBACK = 'tn';

export function parseCallbackData(data: string | null): CallbackAction | null {
  if (data === null || Buffer.byteLength(data) > MAX_CALLBACK_BYTES) return null;
  if (data === TASK_NEW_CALLBACK) return { kind: 'task_new' };
  let match = TIME_ZONE_CALLBACK.exec(data);
  if (match) return { kind: 'confirm_time_zone', revision: Number(match[1]), zone: match[2] ?? '' };
  match = DRAFT_CALLBACK.exec(data);
  if (match) return { kind: 'draft', version: Number(match[1]), op: (match[2] ?? 'x') as DraftOp };
  match = TASK_CALLBACK.exec(data);
  if (match) {
    return {
      kind: 'task',
      taskId: match[1] ?? '',
      revision: Number(match[2]),
      op: (match[3] ?? 'v') as TaskOp,
    };
  }
  match = LIST_CALLBACK.exec(data);
  if (match) return { kind: 'task_list', page: Number(match[1]) };
  return null;
}
