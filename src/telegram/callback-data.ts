/**
 * Inline-button payloads. Callback data is client-supplied: it never carries
 * a user or owner ID and is only a request about the presser's own records,
 * revalidated against the current database state. At most 64 bytes
 * (Telegram's limit). Formats:
 *   tz:<revision>:<zone>          confirm <zone> as the sender's time zone (onboarding)
 *   d:<draft id>:<version>:<op>   act on the sender's open task draft <draft id> at <version>;
 *                                 the ID binds a button to the draft that issued it (the
 *                                 earlier version-only form d:<version>:<op> is rejected)
 *   t:<task id>:<revision>:<op>   act on the sender's task at <revision>
 *   tl:<page>                     task list page
 *   tn                            start creating a task
 *   h:<scope>[:<o|n>:<run>]       run history (TRB-080): <scope> is a task ID or "*" (all
 *                                 the sender's runs); o/n = the page older/newer than <run>
 *   r:<run>:<scope>               the card of one of the sender's runs, opened from <scope>
 *   rs:<run>                      explicit resend of the sender's stored result
 *   au:<page>                     administrator: user list page (TRB-090)
 *   av:<user>                     administrator: one user's view
 *   ax:<user>:<revision>:<s|r>    administrator: suspend / reactivate the user at <revision>
 * In h/r/rs, IDs are UUIDs in base64url form (22 characters) to fit the limit.
 */
const MAX_CALLBACK_BYTES = 64;
const TIME_ZONE_CALLBACK = /^tz:(0|[1-9]\d{0,8}):([A-Za-z][A-Za-z0-9_+\-/]{0,39})$/;
const DRAFT_CALLBACK =
  /^d:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(0|[1-9]\d{0,8}):(b|x|k|s|r|n|km|kd|kw|w[1-7]|z)$/;
const TASK_CALLBACK =
  /^t:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([1-9]\d{0,8}):(v|en|ep|es|p|u|d|dy|r|lr|h)$/;
const LIST_CALLBACK = /^tl:(0|[1-9]\d{0,3})$/;
const HISTORY_CALLBACK = /^h:(\*|[A-Za-z0-9_-]{22})(?::([on]):([A-Za-z0-9_-]{22}))?$/;
const RUN_CALLBACK = /^r:([A-Za-z0-9_-]{22}):(\*|[A-Za-z0-9_-]{22})$/;
const RESEND_CALLBACK = /^rs:([A-Za-z0-9_-]{22})$/;
const ADMIN_LIST_CALLBACK = /^au:(0|[1-9]\d{0,3})$/;
const ADMIN_USER_CALLBACK = /^av:([A-Za-z0-9_-]{22})$/;
const ADMIN_ACCESS_CALLBACK = /^ax:([A-Za-z0-9_-]{22}):(0|[1-9]\d{0,8}):([sr])$/;

/**
 * Draft operations: b back, x cancel, k keep the current value, s save,
 * r resume, n discard and start a new task, km/kd/kw schedule kind,
 * w1-w7 weekday, z use the suggested time zone.
 */
export type DraftOp = 'b' | 'x' | 'k' | 's' | 'r' | 'n' | 'km' | 'kd' | 'kw' | `w${number}` | 'z';
/**
 * Task operations: v view card, en/ep/es edit name/prompt/schedule, p pause,
 * u resume, d ask to delete, dy confirm deletion, r run now (manual admission),
 * lr latest result, h run history (TRB-080; read-only, like v).
 */
export type TaskOp = 'v' | 'en' | 'ep' | 'es' | 'p' | 'u' | 'd' | 'dy' | 'r' | 'lr' | 'h';

/** History scope: one task of the sender, or all the sender's runs. */
export type HistoryScope = { taskId: string } | 'all';
export interface HistoryCursor {
  direction: 'older' | 'newer';
  runId: string;
}

export type CallbackAction =
  | { kind: 'confirm_time_zone'; revision: number; zone: string }
  | { kind: 'draft'; draftId: string; version: number; op: DraftOp }
  | { kind: 'task'; taskId: string; revision: number; op: TaskOp }
  | { kind: 'task_list'; page: number }
  | { kind: 'task_new' }
  | { kind: 'history'; scope: HistoryScope; cursor: HistoryCursor | null }
  | { kind: 'run'; runId: string; scope: HistoryScope }
  | { kind: 'resend'; runId: string }
  | { kind: 'admin_users'; page: number }
  | { kind: 'admin_user'; userId: string }
  | { kind: 'admin_access'; userId: string; revision: number; op: 'suspend' | 'reactivate' };

function bounded(data: string): string {
  if (Buffer.byteLength(data) > MAX_CALLBACK_BYTES) throw new Error('callback data too long');
  return data;
}

export function timeZoneCallbackData(revision: number, zone: string): string {
  const data = `tz:${revision}:${zone}`;
  if (!TIME_ZONE_CALLBACK.test(data)) throw new Error('time zone callback data out of bounds');
  return bounded(data);
}

export function draftCallbackData(draftId: string, version: number, op: DraftOp): string {
  const data = `d:${draftId}:${version}:${op}`;
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** UUID → 22-character base64url (16 bytes). */
export function compactId(uuid: string): string {
  if (!UUID.test(uuid)) throw new Error('not a UUID');
  return Buffer.from(uuid.replace(/-/g, ''), 'hex').toString('base64url');
}

/** 22-character base64url → UUID, or null for anything that is not exactly 16 canonical bytes. */
export function expandId(compact: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(compact)) return null;
  const bytes = Buffer.from(compact, 'base64url');
  if (bytes.length !== 16 || bytes.toString('base64url') !== compact) return null;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const scopeToken = (scope: HistoryScope) => (scope === 'all' ? '*' : compactId(scope.taskId));

function parseScope(token: string): HistoryScope | null {
  if (token === '*') return 'all';
  const taskId = expandId(token);
  return taskId ? { taskId } : null;
}

export function historyCallbackData(
  scope: HistoryScope,
  cursor: HistoryCursor | null = null,
): string {
  const page = cursor
    ? `:${cursor.direction === 'older' ? 'o' : 'n'}:${compactId(cursor.runId)}`
    : '';
  return bounded(`h:${scopeToken(scope)}${page}`);
}

export function runCallbackData(runId: string, scope: HistoryScope): string {
  return bounded(`r:${compactId(runId)}:${scopeToken(scope)}`);
}

export function adminUsersCallbackData(page: number): string {
  const data = `au:${page}`;
  if (!ADMIN_LIST_CALLBACK.test(data)) throw new Error('admin list callback data out of bounds');
  return data;
}

export function adminUserCallbackData(userId: string): string {
  return bounded(`av:${compactId(userId)}`);
}

export function adminAccessCallbackData(
  userId: string,
  revision: number,
  op: 'suspend' | 'reactivate',
): string {
  return bounded(`ax:${compactId(userId)}:${revision}:${op === 'suspend' ? 's' : 'r'}`);
}

export function resendCallbackData(runId: string): string {
  return bounded(`rs:${compactId(runId)}`);
}

export function parseCallbackData(data: string | null): CallbackAction | null {
  if (data === null || Buffer.byteLength(data) > MAX_CALLBACK_BYTES) return null;
  if (data === TASK_NEW_CALLBACK) return { kind: 'task_new' };
  let match = TIME_ZONE_CALLBACK.exec(data);
  if (match) return { kind: 'confirm_time_zone', revision: Number(match[1]), zone: match[2] ?? '' };
  match = DRAFT_CALLBACK.exec(data);
  if (match) {
    return {
      kind: 'draft',
      draftId: match[1] ?? '',
      version: Number(match[2]),
      op: (match[3] ?? 'x') as DraftOp,
    };
  }
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
  match = HISTORY_CALLBACK.exec(data);
  if (match) {
    const scope = parseScope(match[1] ?? '');
    if (!scope) return null;
    if (!match[2]) return { kind: 'history', scope, cursor: null };
    const runId = expandId(match[3] ?? '');
    if (!runId) return null;
    return {
      kind: 'history',
      scope,
      cursor: { direction: match[2] === 'o' ? 'older' : 'newer', runId },
    };
  }
  match = RUN_CALLBACK.exec(data);
  if (match) {
    const runId = expandId(match[1] ?? '');
    const scope = parseScope(match[2] ?? '');
    return runId && scope ? { kind: 'run', runId, scope } : null;
  }
  match = ADMIN_LIST_CALLBACK.exec(data);
  if (match) return { kind: 'admin_users', page: Number(match[1]) };
  match = ADMIN_USER_CALLBACK.exec(data);
  if (match) {
    const userId = expandId(match[1] ?? '');
    return userId ? { kind: 'admin_user', userId } : null;
  }
  match = ADMIN_ACCESS_CALLBACK.exec(data);
  if (match) {
    const userId = expandId(match[1] ?? '');
    return userId
      ? {
          kind: 'admin_access',
          userId,
          revision: Number(match[2]),
          op: match[3] === 's' ? 'suspend' : 'reactivate',
        }
      : null;
  }
  match = RESEND_CALLBACK.exec(data);
  if (match) {
    const runId = expandId(match[1] ?? '');
    return runId ? { kind: 'resend', runId } : null;
  }
  return null;
}
