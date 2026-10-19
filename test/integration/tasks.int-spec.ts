import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { parseEnv } from '../../src/config/env.schema';
import {
  onDraftAction,
  onDraftText,
  onTaskAction,
  showTasks,
  startCreate,
} from '../../src/tasks/task-service';
import { draftCallbackData, taskCallbackData } from '../../src/telegram/callback-data';
import {
  ADMIN_ID,
  OTHER_ADMIN_ID,
  callbackQuery,
  drainDeliveries,
  groupMessage,
  privateMessage,
  resetDatabase,
  startHarness,
  type Harness,
} from '../support/research-harness';

const MEMBER = 3003;
const STRANGER = 3999;
const FOREIGN_ID = 'abcdef01-2222-4333-8444-555555555555';

describe('TRB-040 tasks and durable dialogs (fakes, real PostgreSQL)', () => {
  const open: Harness[] = [];
  /** Every instance started in the test, including closed ones (their sent messages count). */
  const all: Harness[] = [];
  const start = async (...args: Parameters<typeof startHarness>) => {
    const harness = await startHarness(...args);
    open.push(harness);
    all.push(harness);
    return harness;
  };
  let h: Harness;

  beforeEach(async () => {
    h = await start();
    await resetDatabase(h.prisma);
  });

  afterEach(async () => {
    // Task management never starts research.
    expect(await h.prisma.researchRun.count()).toBe(0);
    for (const harness of all.splice(0)) expect(harness.provider.calls.submit).toBe(0);
    for (const harness of open.splice(0)) await harness.close();
  });

  const messagesTo = (id: number) =>
    all.flatMap((harness) => harness.sender.sent).filter((m) => m.chatId === BigInt(id));
  const last = (id = ADMIN_ID) => messagesTo(id).at(-1);
  const lastText = (id = ADMIN_ID) => last(id)?.html ?? '';
  /** Callback data of the button whose label contains `label` in the user's last message. */
  const button = (label: string, id = ADMIN_ID) => {
    const found = last(id)
      ?.replyMarkup?.inline_keyboard.flat()
      .find((b) => b.text.includes(label));
    if (!found) throw new Error(`no button "${label}" in: ${lastText(id).slice(0, 200)}`);
    return found.callback_data;
  };
  const say = async (text: string, from = ADMIN_ID, harness = h) => {
    await harness.post(privateMessage(text, from)).expect(200);
    await drainDeliveries(harness);
  };
  const press = async (data: string, from = ADMIN_ID, harness = h) => {
    await harness.post(callbackQuery(data, from)).expect(200);
    await drainDeliveries(harness);
  };
  const tasks = () => h.prisma.task.findMany({ orderBy: { createdAt: 'asc' } });
  const draft = (id = ADMIN_ID) =>
    h.prisma.taskDraft.findFirst({ where: { user: { telegramUserId: BigInt(id) } } });
  const reasons = async (n: number) =>
    (await h.prisma.telegramUpdate.findMany({ orderBy: { updateId: 'desc' }, take: n }))
      .map((u) => u.reason)
      .reverse();

  /** Creation up to the preview. */
  async function toPreview(
    name: string,
    schedule:
      | { kind: 'Вручну' }
      | { kind: 'Щодня'; time: string }
      | { kind: 'Щотижня'; day: string; time: string },
    zone?: string,
    from = ADMIN_ID,
  ) {
    await say('/new', from);
    await say(name, from);
    await say(`Запит для ${name}: матчі на наступні 7 днів`, from);
    await press(button(schedule.kind, from), from);
    if (schedule.kind === 'Щотижня') await press(button(schedule.day, from), from);
    if (schedule.kind !== 'Вручну') await say(schedule.time, from);
    if (zone) await say(zone, from);
    else await press(button('Використати', from), from);
  }

  async function create(name: string, from = ADMIN_ID) {
    await toPreview(name, { kind: 'Щодня', time: '09:00' }, undefined, from);
    await press(button('Зберегти', from), from);
  }

  async function onboardMember(id = MEMBER) {
    await say('/admin invite');
    const token = /\?start=([A-Za-z0-9_-]{43})/.exec(lastText())?.[1];
    await say(`/start ${token}`, id);
    await press(button('Europe/Kyiv', id), id);
  }

  describe('creation', () => {
    it('creates manual, daily and weekly tasks through the guided steps', async () => {
      await say('/tasks');
      expect(lastText()).toBe('Завдань ще немає.');
      await press(button('Нове завдання'));
      expect(lastText()).toContain('Надішліть назву завдання');
      await say('Огляд');
      await say('Новини <b>&</b> аналіз');
      await press(button('Вручну'));
      // Manual tasks skip weekday and time.
      expect(lastText()).toContain('Часовий пояс завдання');
      await press(button('Використати Europe/Kyiv'));
      expect(lastText()).toContain('Назва: Огляд');
      expect(lastText()).toContain('Розклад: Вручну (без розкладу)');
      expect(lastText()).toContain('Новини &lt;b&gt;&amp;&lt;/b&gt; аналіз');
      expect(lastText()).toContain('Збереження не запускає дослідження.');
      await press(button('Зберегти'));
      expect(lastText()).toContain('Завдання збережено.');

      await toPreview('Щоденне', { kind: 'Щодня', time: '7:30' });
      await press(button('Зберегти'));
      await toPreview(
        'Тижневе',
        { kind: 'Щотижня', day: "п'ятниця", time: '18:45' },
        'America/New_York',
      );
      expect(lastText()).toContain("Розклад: Щотижня: п'ятниця о 18:45");
      expect(lastText()).toContain('Часовий пояс: America/New_York');
      await press(button('Зберегти'));

      expect(
        (await tasks()).map((t) => [
          t.name,
          t.scheduleKind,
          t.weekday,
          t.localTime,
          t.timeZone,
          t.state,
          t.revision,
        ]),
      ).toEqual([
        ['Огляд', 'MANUAL', null, null, 'Europe/Kyiv', 'ACTIVE', 1],
        ['Щоденне', 'DAILY', null, '07:30', 'Europe/Kyiv', 'ACTIVE', 1],
        ['Тижневе', 'WEEKLY', 5, '18:45', 'America/New_York', 'ACTIVE', 1],
      ]);
      expect((await tasks())[0]?.prompt).toBe('Новини <b>&</b> аналіз');
      expect(await draft()).toBeNull();
      await say('/tasks');
      expect(lastText()).toContain('Ваші завдання: 3 з 20, активних 3 з 5');
      expect(lastText()).toContain("3. Тижневе — Щотижня: п'ятниця о 18:45");
    });

    it('supports Back and Cancel and clears fields a new schedule kind does not use', async () => {
      await toPreview('Назва', { kind: 'Щотижня', day: 'середа', time: '10:00' });
      expect(() => button('Назад')).not.toThrow();
      await press(button('Назад')); // time zone
      await press(button('Назад')); // local time
      expect(lastText()).toContain('Зараз: 10:00');
      await press(button('Назад')); // weekday
      expect(() => button('✓ середа')).not.toThrow();
      await press(button('Назад')); // schedule kind
      await press(button('Щодня'));
      expect((await draft())?.data).not.toHaveProperty('weekday');
      await press(button('Залишити як є')); // keeps 10:00
      await press(button('Використати'));
      expect(lastText()).toContain('Розклад: Щодня о 10:00');
      await press(button('Назад'));
      await press(button('Назад'));
      await press(button('Назад')); // schedule kind
      await press(button('Вручну'));
      expect((await draft())?.data).not.toHaveProperty('localTime');
      await press(button('Скасувати'));
      expect(lastText()).toBe('Створення завдання скасовано; нічого не збережено.');
      expect(await draft()).toBeNull();

      // /cancel at the first step (which has no Back button).
      await say('/new');
      expect(
        last()
          ?.replyMarkup?.inline_keyboard.flat()
          .map((b) => b.text),
      ).toEqual(['Скасувати']);
      await say('/cancel');
      await say('/cancel');
      expect(lastText()).toBe('Немає незавершеної чернетки.');
      expect(await tasks()).toEqual([]);
    });

    it('validates every input with a clear message and keeps the step', async () => {
      const limited = await start({ RESEARCH_PROMPT_MAX_CHARS: '20' });
      const sayL = (text: string) => say(text, ADMIN_ID, limited);
      await sayL('/new');
      await sayL('   ');
      expect(lastText()).toContain('Назва не може бути порожньою.');
      await sayL('я'.repeat(101));
      expect(lastText()).toContain('Назва задовга: максимум 100 символів.');
      await sayL('рядок\nдругий');
      expect(lastText()).toContain('Назва має бути одним рядком.');
      await sayL('я'.repeat(100));
      await sayL('x'.repeat(21));
      expect(lastText()).toContain('Запит задовгий: максимум 20 символів.');
      await sayL('коротко');
      await sayL('щодня');
      expect(lastText()).toContain('Оберіть варіант кнопкою нижче.');
      await press(button('Щотижня'), ADMIN_ID, limited);
      const version = (await draft())?.version ?? -1;
      await press(`d:${version}:w8`, ADMIN_ID, limited); // invalid weekday payload
      expect((await draft())?.step).toBe('WEEKDAY');
      await press(button('неділя'), ADMIN_ID, limited);
      for (const time of ['24:00', '9.00', 'завтра']) {
        await sayL(time);
        expect(lastText()).toContain('Невірний час. Формат ГГ:ХХ, від 00:00 до 23:59.');
      }
      await sayL('23:59');
      for (const zone of ['EST', 'Mars/Olympus', '+03:00']) {
        await sayL(zone);
        expect(lastText()).toContain('Невідомий часовий пояс.');
      }
      expect((await draft())?.step).toBe('TIME_ZONE');
      expect((await reasons(3)).every((r) => r === 'DRAFT_ZONE_INVALID')).toBe(true);
      expect(await tasks()).toEqual([]);
    });

    it('creates exactly one task from repeated, duplicate and concurrent Save presses', async () => {
      await toPreview('Один', { kind: 'Вручну' });
      const save = button('Зберегти');
      const update = callbackQuery(save);
      const other = await start();
      // The same update twice, and a second press of the same button from another instance.
      await Promise.all([h.post(update), h.post(update), other.post(callbackQuery(save))]);
      await h.post(callbackQuery(save)).expect(200);
      expect(await tasks()).toHaveLength(1);
      expect(await draft()).toBeNull();
      expect(await h.prisma.telegramUpdate.count({ where: { reason: 'TASK_CREATED' } })).toBe(1);
    });

    it('offers to resume or replace an open draft instead of discarding it', async () => {
      await say('/new');
      await say('Перша');
      await say('/new');
      expect(lastText()).toContain('У вас є незавершене створення завдання «Перша»');
      await press(button('Продовжити'));
      expect(lastText()).toContain('Надішліть запит для дослідження');
      await say('/new');
      await press(button('Відкинути й почати нове'));
      expect(lastText()).toContain('Надішліть назву завдання');
      expect((await draft())?.data).toEqual({ suggestedTimeZone: 'Europe/Kyiv' });
    });
  });

  describe('durability', () => {
    it('resumes creation and editing after a restart', async () => {
      await say('/new');
      await say('Після рестарту');
      await h.close();
      open.splice(open.indexOf(h), 1);

      const restarted = await start();
      await say('Запит після рестарту', ADMIN_ID, restarted);
      await press(button('Вручну'), ADMIN_ID, restarted);
      await press(button('Використати'), ADMIN_ID, restarted);
      await press(button('Зберегти'), ADMIN_ID, restarted);
      const [task] = await restarted.prisma.task.findMany();
      expect(task).toMatchObject({ name: 'Після рестарту', prompt: 'Запит після рестарту' });

      await press(button('Назва'), ADMIN_ID, restarted);
      await say('Нова назва', ADMIN_ID, restarted);
      await restarted.close();
      open.splice(open.indexOf(restarted), 1);
      h = await start();
      await press(button('Зберегти'), ADMIN_ID, h);
      expect(await h.prisma.task.findFirstOrThrow()).toMatchObject({
        name: 'Нова назва',
        revision: 2,
      });
    });

    it('never resumes or saves an expired draft', async () => {
      await toPreview('Прострочене', { kind: 'Вручну' });
      const save = button('Зберегти');
      await h.prisma.$executeRaw`UPDATE task_draft SET expires_at = now() - interval '1 second'`;
      await press(save);
      expect(lastText()).toContain('Чернетку нового завдання прострочено (24 год без змін)');
      expect(await draft()).toBeNull();
      await press(save);
      expect(await tasks()).toEqual([]);

      await say('/new');
      await say('Текст');
      await h.prisma.$executeRaw`UPDATE task_draft SET expires_at = now() - interval '1 second'`;
      await say('Запит');
      expect(lastText()).toContain('прострочено');
      // Expired: the text was not taken as the prompt of anything.
      expect(await draft()).toBeNull();
      await say('/new');
      expect(lastText()).toContain('Надішліть назву завдання');
    });

    it('extends the expiry on each successful step only', async () => {
      await say('/new');
      await h.prisma.$executeRaw`UPDATE task_draft SET expires_at = now() + interval '1 minute'`;
      await say('я'.repeat(101)); // rejected: no extension
      const rejected = await draft();
      expect(rejected?.expiresAt.getTime()).toBeLessThan(Date.now() + 120_000);
      await say('Назва');
      const accepted = await draft();
      expect(accepted?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    });

    it('ignores old buttons of an earlier step or draft', async () => {
      await say('/new');
      await say('Назва');
      await say('Запит');
      const kindButton = button('Щодня');
      await press(kindButton);
      const before = await draft();
      await press(kindButton); // same button again: older version
      await press(draftCallbackData((before?.version ?? 0) + 7, 's'));
      expect(await draft()).toEqual(before);
      expect(await reasons(2)).toEqual(['CALLBACK_STALE', 'CALLBACK_STALE']);
      await press(button('Скасувати'));
      await press(kindButton); // no draft any more
      expect(await reasons(1)).toEqual(['DRAFT_NONE']);
    });
  });

  describe('editing and revisions', () => {
    it('leaves the saved task unchanged until confirmation and keeps edits to their section', async () => {
      await create('Початкова');
      const before = (await tasks())[0];
      await press(button('Розклад'));
      await press(button('Щотижня'));
      await press(button('понеділок'));
      await press(button('Залишити як є'));
      await press(button('Використати Europe/Kyiv'));
      expect(lastText()).toContain('Розклад: Щотижня: понеділок о 09:00');
      expect(lastText()).not.toContain('Запит:');
      expect((await tasks())[0]).toEqual(before);
      await press(button('Зберегти'));
      expect((await tasks())[0]).toMatchObject({
        name: 'Початкова',
        scheduleKind: 'WEEKLY',
        weekday: 1,
        localTime: '09:00',
        revision: 2,
      });

      // Cancel and expiry of an edit never change the task.
      await press(button('Запит'));
      await say('Інший запит');
      await press(button('Скасувати'));
      expect(lastText()).toBe('Редагування скасовано; завдання не змінено.');
      await say('/tasks');
      await press(button('Початкова'));
      await press(button('Запит'));
      await say('Ще інший');
      await h.prisma.$executeRaw`UPDATE task_draft SET expires_at = now() - interval '1 second'`;
      await press(button('Зберегти'));
      expect(lastText()).toContain('Чернетку редагування прострочено');
      expect((await tasks())[0]?.prompt).toBe(before?.prompt);
      expect((await tasks())[0]?.revision).toBe(2);
    });

    it('rejects a stale edit without overwriting the newer change', async () => {
      await create('Задача');
      const pause = button('Пауза');
      await press(button('Назва'));
      await say('Перейменована');
      // Meanwhile the task changes (another device or an older card).
      await press(pause);
      expect((await tasks())[0]).toMatchObject({ state: 'PAUSED', revision: 2 });
      // The pause card is the last message; the draft's Save is on the earlier preview.
      const saveFromDraft = draftCallbackData((await draft())?.version ?? -1, 's');
      await press(saveFromDraft);
      expect(lastText()).toContain(
        'Завдання змінилося після початку редагування, тому зміни не збережено.',
      );
      expect((await tasks())[0]).toMatchObject({ name: 'Задача', state: 'PAUSED', revision: 2 });
      expect(await draft()).toBeNull();
    });

    it('lets exactly one of two overlapping changes win', async () => {
      await create('Гонка');
      const pause = button('Пауза');
      await press(button('Назва'));
      await say('Гонка 2');
      const save = button('Зберегти');
      const other = await start();
      const blocker = new Client({ connectionString: inject('databaseUrl') });
      await blocker.connect();
      try {
        // Hold the user's identity lock so that both transactions are waiting at the database.
        await blocker.query('SELECT pg_advisory_lock(30030, hashtext($1))', [String(ADMIN_ID)]);
        const waiters = async () =>
          (
            await blocker.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'`,
            )
          ).rows[0]?.n ?? 0;
        const both = Promise.all([
          h.post(callbackQuery(save)).then((r) => r.status),
          other.post(callbackQuery(pause)).then((r) => r.status),
        ]);
        await vi.waitFor(async () => expect(await waiters()).toBe(2));
        await blocker.query('SELECT pg_advisory_unlock(30030, hashtext($1))', [String(ADMIN_ID)]);
        expect(await both).toEqual([200, 200]);
      } finally {
        await blocker.end();
      }
      const [task] = await tasks();
      expect(task?.revision).toBe(2);
      // Exactly one change applied; the other was refused as stale.
      expect([task?.name === 'Гонка 2', task?.state === 'PAUSED'].filter(Boolean)).toHaveLength(1);
      expect(
        await h.prisma.telegramUpdate.count({
          where: { reason: { in: ['TASK_EDIT_STALE', 'TASK_STALE'] } },
        }),
      ).toBe(1);
    });
  });

  describe('pause, resume and delete', () => {
    it('pauses and resumes idempotently', async () => {
      await create('Пауза');
      const pause = button('Пауза');
      await press(pause);
      expect(lastText()).toContain('Завдання призупинено.');
      await press(pause); // same (now stale) button
      const [task] = await tasks();
      expect(task).toMatchObject({ state: 'PAUSED', revision: 2 });
      // A pause at the current revision while paused changes nothing.
      await press(taskCallbackData(task?.id ?? '', 2, 'p'));
      expect(lastText()).toContain('Завдання вже на паузі.');
      await press(button('Відновити'));
      expect((await tasks())[0]).toMatchObject({ state: 'ACTIVE', revision: 3 });
    });

    it('enforces the active and saved task limits', async () => {
      const small = await start({ TASK_ACTIVE_LIMIT: '1', TASK_SAVED_LIMIT: '2' });
      await say('/new', ADMIN_ID, small);
      await say('А', ADMIN_ID, small);
      await say('Запит', ADMIN_ID, small);
      await press(button('Вручну'), ADMIN_ID, small);
      await press(button('Використати'), ADMIN_ID, small);
      await press(button('Зберегти'), ADMIN_ID, small);
      const pauseA = button('Пауза');
      await say('/new', ADMIN_ID, small);
      await say('Б', ADMIN_ID, small);
      await say('Запит', ADMIN_ID, small);
      await press(button('Вручну'), ADMIN_ID, small);
      await press(button('Використати'), ADMIN_ID, small);
      await press(button('Зберегти'), ADMIN_ID, small);
      expect(lastText()).toContain('Досягнуто ліміту активних завдань (1)');
      await press(pauseA, ADMIN_ID, small);
      await say('/new', ADMIN_ID, small);
      await press(button('Продовжити'), ADMIN_ID, small);
      await press(button('Зберегти'), ADMIN_ID, small);
      expect(lastText()).toContain('Завдання збережено.');
      await press(button('Пауза'), ADMIN_ID, small);
      await say('/tasks', ADMIN_ID, small);
      await press(button('А'), ADMIN_ID, small);
      await press(button('Відновити'), ADMIN_ID, small);
      await say('/new', ADMIN_ID, small);
      expect(lastText()).toContain('Досягнуто ліміту збережених завдань (2)');
      expect((await tasks()).map((t) => t.state)).toEqual(['ACTIVE', 'PAUSED']);
    });

    it('deletes only with a current confirmation and refuses actions on deleted tasks', async () => {
      await create('Видалити');
      const pause = button('Пауза');
      await press(button('Видалити'));
      expect(lastText()).toContain('Видалити завдання «Видалити»?');
      const confirm = button('Так, видалити');
      // Changed after the confirmation was requested: the stale confirmation does nothing.
      await press(pause);
      await press(confirm);
      expect(lastText()).toContain('Завдання змінилося; ось його актуальний стан.');
      expect((await tasks())[0]?.state).toBe('PAUSED');

      // An edit draft open while the task is deleted fails safely afterwards.
      await press(button('Назва'));
      await say('/tasks');
      await press(button('Видалити'));
      await press(button('Видалити'));
      await press(button('Так, видалити'));
      expect(lastText()).toContain('Завдання «Видалити» видалено.');
      expect(lastText()).toContain('Завдань ще немає.');
      const deleted = (await tasks())[0];
      expect(deleted).toMatchObject({ state: 'DELETED', revision: 3 });
      expect(deleted?.deletedAt).not.toBeNull();
      await say('Нова назва');
      expect(lastText()).toBe('Завдання більше не існує; редагування скасовано.');
      for (const op of ['v', 'u', 'en', 'dy'] as const) {
        await press(taskCallbackData(deleted?.id ?? '', 3, op));
        expect(lastText()).toBe('Завдання не знайдено.');
      }
      expect((await tasks())[0]).toMatchObject({ name: 'Видалити', state: 'DELETED', revision: 3 });
    });
  });

  describe('ownership and access', () => {
    it('keeps every user to their own tasks and drafts', async () => {
      await create('Чуже');
      const [task] = await tasks();
      await say('/new');
      await say('Чернетка A');
      const draftA = await draft();
      const before = JSON.stringify(await tasks());

      for (const op of ['v', 'p', 'd', 'dy', 'en'] as const) {
        await press(taskCallbackData(task?.id ?? '', 1, op), OTHER_ADMIN_ID);
        expect(lastText(OTHER_ADMIN_ID)).toBe('Завдання не знайдено.');
        await press(taskCallbackData(FOREIGN_ID, 1, op), OTHER_ADMIN_ID);
        expect(lastText(OTHER_ADMIN_ID)).toBe('Завдання не знайдено.');
      }
      // A's draft buttons pressed by B act on B's (absent) draft only.
      await press(draftCallbackData(draftA?.version ?? 0, 's'), OTHER_ADMIN_ID);
      await press(draftCallbackData(draftA?.version ?? 0, 'x'), OTHER_ADMIN_ID);
      await say('/tasks', OTHER_ADMIN_ID);
      expect(lastText(OTHER_ADMIN_ID)).toBe('Завдань ще немає.');
      await say('/cancel', OTHER_ADMIN_ID);
      expect(lastText(OTHER_ADMIN_ID)).toBe('Немає незавершеної чернетки.');

      expect(JSON.stringify(await tasks())).toBe(before);
      expect(await draft()).toEqual(draftA);
      expect(messagesTo(OTHER_ADMIN_ID).some((m) => m.html.includes('Чуже'))).toBe(false);
    });

    it('denies suspended, unknown and group senders without changing anything', async () => {
      await onboardMember();
      await say('/new', MEMBER);
      await say('Учасник', MEMBER);
      const memberDraft = await draft(MEMBER);
      await say(`/admin suspend ${MEMBER}`);
      for (const text of ['/tasks', '/new', '/cancel', 'текст']) await say(text, MEMBER);
      await press(draftCallbackData(memberDraft?.version ?? 0, 'x'), MEMBER);
      expect(
        new Set(
          messagesTo(MEMBER)
            .slice(-4)
            .map((m) => m.html),
        ),
      ).toEqual(new Set(['Ваш доступ призупинено адміністратором.']));
      expect(await draft(MEMBER)).toEqual(memberDraft);

      for (const text of ['/tasks', '/new', '/cancel']) await say(text, STRANGER);
      expect(new Set(messagesTo(STRANGER).map((m) => m.html))).toEqual(
        new Set(['Цей бот приватний. Доступ лише за запрошенням.']),
      );
      await h.post(groupMessage('/new')).expect(200);
      await h.post(groupMessage('/tasks')).expect(200);
      await h.post(callbackQuery('tn', ADMIN_ID, undefined, { id: -100123, type: 'supergroup' }));
      await drainDeliveries(h);
      expect(await h.prisma.taskDraft.count()).toBe(1);
      expect(await h.prisma.task.count()).toBe(0);
      expect(await reasons(3)).toEqual([
        'NOT_PRIVATE_CHAT',
        'NOT_PRIVATE_CHAT',
        'NOT_PRIVATE_CHAT',
      ]);
    });

    it('rechecks access inside the task services, not only in the router', async () => {
      await create('Сервіс');
      const [task] = await tasks();
      await say('/new');
      const open = await draft();
      await h.prisma.appUser.update({
        where: { telegramUserId: BigInt(ADMIN_ID) },
        data: { status: 'SUSPENDED', suspendedAt: new Date() },
      });
      const user = await h.prisma.appUser.findUniqueOrThrow({
        where: { telegramUserId: BigInt(ADMIN_ID) },
      });
      const config = parseEnv({
        DATABASE_URL: 'postgresql://unused@localhost:1/x',
        ADMIN_TELEGRAM_IDS: `${ADMIN_ID}`,
      });
      const outcomes = await h.prisma.$transaction(async (tx) => {
        const ctx = { tx, config, user, chatId: BigInt(ADMIN_ID) };
        return [
          await showTasks(ctx),
          await startCreate(ctx),
          await onDraftText(ctx, 'значення'),
          await onDraftAction(ctx, open?.version ?? 0, 'x'),
          await onTaskAction(ctx, task?.id ?? '', 1, 'p'),
          await onTaskAction(ctx, task?.id ?? '', 1, 'dy'),
        ];
      });
      expect(outcomes.map((outcome) => outcome?.reason)).toEqual(Array(6).fill('SUSPENDED'));
      expect(await draft()).toEqual(open);
      expect((await tasks())[0]).toEqual(task);
    });

    it("keeps a task's zone when the user's default zone changes", async () => {
      await create('Пояс');
      await h.prisma.appUser.update({
        where: { telegramUserId: BigInt(ADMIN_ID) },
        data: { timeZone: 'America/New_York' },
      });
      expect((await tasks())[0]?.timeZone).toBe('Europe/Kyiv');
      await say('/tasks');
      await press(button('Пояс'));
      expect(lastText()).toContain('Часовий пояс: Europe/Kyiv');
      // Editing the schedule suggests the task's own zone; new tasks suggest the user's.
      await press(button('Розклад'));
      await press(button('Щодня'));
      await press(button('Залишити як є'));
      expect(button('Використати')).toBeDefined();
      expect(lastText()).not.toContain('America/New_York');
      await press(button('Скасувати'));
      await toPreview('Новий', { kind: 'Вручну' });
      expect(lastText()).toContain('Часовий пояс: America/New_York');
      expect((await tasks())[0]?.timeZone).toBe('Europe/Kyiv');
    });
  });

  it('keeps prompts and draft contents out of logs', async () => {
    await toPreview('СЕКРЕТНА-НАЗВА', { kind: 'Вручну' });
    await press(button('Зберегти'));
    const logs = open.flatMap((harness) => harness.logger.lines).join('\n');
    expect(logs).toContain('TASK_CREATED');
    expect(logs).not.toContain('СЕКРЕТНА-НАЗВА');
    expect(logs).not.toContain('матчі на наступні 7 днів');
  });
});
