import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { taskCallbackData } from '../../src/telegram/callback-data';
import { FakeClock, ScriptedProvider, snapshot } from '../support/fakes';
import { LIVE_TEST_ENV } from '../support/live-env';
import {
  ADMIN_ID,
  callbackQuery,
  drainDeliveries,
  privateMessage,
  resetDatabase,
  startHarness,
  type Harness,
} from '../support/research-harness';

const MEMBER_ID = 3003;
const IDENTITY_LOCK_CLASS = 30_030;
/** Monday 2026-10-19 09:00 in Kyiv (+03:00). */
const T0 = new Date('2026-10-19T06:00:00Z');
const at = (value: string) => new Date(value);
const MINUTE = 60_000;

/** A manually resolved gate for scripted provider calls. */
function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe('TRB-070 scheduling (fake clock, scripted provider, real PostgreSQL)', () => {
  const open: Harness[] = [];
  let clock: FakeClock;
  let h: Harness;

  const start = async (env: Record<string, string> = {}, live = false) => {
    const harness = await startHarness(live ? { ...LIVE_TEST_ENV, ...env } : env, {
      clock,
      ...(live ? { provider: new ScriptedProvider('openai') } : {}),
    });
    open.push(harness);
    return harness;
  };

  beforeEach(async () => {
    clock = new FakeClock(at('2026-10-19T05:00:00Z'));
    h = await start();
    await resetDatabase(h.prisma);
  });

  afterEach(async () => {
    for (const harness of open.splice(0)) await harness.close();
  });

  const userId = async (telegramId = ADMIN_ID) =>
    (await h.prisma.appUser.findUniqueOrThrow({ where: { telegramUserId: BigInt(telegramId) } }))
      .id;
  const newTask = async (
    fields: {
      scheduleKind?: 'DAILY' | 'WEEKLY';
      weekday?: number | null;
      localTime?: string;
      timeZone?: string;
      nextRunAt?: Date | null;
      owner?: number;
      prompt?: string;
    } = {},
  ) =>
    h.prisma.task.create({
      data: {
        userId: await userId(fields.owner),
        name: 'Daily task',
        prompt: fields.prompt ?? 'Football fixtures for the current week',
        scheduleKind: fields.scheduleKind ?? 'DAILY',
        weekday: fields.weekday ?? null,
        localTime: fields.localTime ?? '09:00',
        timeZone: fields.timeZone ?? 'Europe/Kyiv',
        nextRunAt: fields.nextRunAt === undefined ? T0 : fields.nextRunAt,
      },
    });
  const task = (id: string) => h.prisma.task.findUniqueOrThrow({ where: { id } });
  const events = (taskId?: string) =>
    h.prisma.scheduleEvent.findMany({
      where: taskId ? { taskId } : {},
      orderBy: { occurrenceAt: 'asc' },
    });
  const runs = () => h.prisma.researchRun.findMany({ orderBy: { createdAt: 'asc' } });
  const submissions = () => open.reduce((n, harness) => n + harness.provider.calls.submit, 0);
  const sent = () => open.flatMap((harness) => harness.sender.sent.map((m) => m.html));
  const press = async (data: string, from = ADMIN_ID, harness = h) => {
    await harness.post(callbackQuery(data, from)).expect(200);
    await drainDeliveries(harness);
  };
  const say = async (text: string, from = ADMIN_ID, harness = h) => {
    await harness.post(privateMessage(text, from)).expect(200);
    await drainDeliveries(harness);
  };
  const button = (label: string) => {
    const found = h.sender.sent
      .at(-1)
      ?.replyMarkup?.inline_keyboard.flat()
      .find((b) => b.text.includes(label));
    if (!found) throw new Error(`no button "${label}"`);
    return found.callback_data;
  };
  const addMember = () =>
    h.prisma.$executeRaw`
      INSERT INTO app_user (id, telegram_user_id, private_chat_id, role, onboarding_state, time_zone,
                            invited_at, onboarded_at, updated_at)
      VALUES (gen_random_uuid(), ${MEMBER_ID}, ${MEMBER_ID}, 'MEMBER', 'COMPLETED', 'Europe/Kyiv',
              now(), now(), now())`;

  describe('occurrences and time semantics', () => {
    it('admits an on-time occurrence through admission and advances by the local schedule', async () => {
      const t = await newTask();
      clock.set('2026-10-19T06:00:20Z');
      await h.scheduler.tick();

      expect(await events(t.id)).toEqual([
        expect.objectContaining({
          occurrenceAt: T0,
          disposition: 'ADMITTED',
          catchUp: false,
          latenessSeconds: 20,
          taskRevision: 1,
        }),
      ]);
      const [run] = await runs();
      expect(run).toMatchObject({
        trigger: 'SCHEDULED',
        occurrenceAt: T0,
        sourceUpdateId: null,
        taskId: t.id,
        chatId: BigInt(ADMIN_ID),
        state: 'QUEUED',
      });
      expect((await events(t.id))[0]?.runId).toBe(run?.id);
      expect((await task(t.id)).nextRunAt).toEqual(at('2026-10-20T06:00:00Z'));
      expect(await h.prisma.outboxEvent.count()).toBe(1);
      // Re-polling the same instant does nothing; no acknowledgement is sent.
      await h.scheduler.tick();
      expect(await events(t.id)).toHaveLength(1);
      await drainDeliveries(h);
      expect(h.sender.sent).toHaveLength(0);

      // The run goes through the queue like any other; the report shows the planned time.
      expect(await h.research.tick()).toBe(true);
      expect(h.provider.requests[0]?.input).toContain(
        'Scheduled run planned for 2026-10-19 09:00 local (2026-10-19T06:00:00Z); actually started 0 minute(s) later.',
      );
      await drainDeliveries(h);
      const report = h.sender.sent.at(-1)?.html ?? '';
      expect(report).toContain('Заплановано на: 2026-10-19 09:00 Europe/Kyiv');
      expect(report).not.toContain('затримкою');
    });

    it('follows the DST gap rule and runs an overlapping time once (Kyiv and New York)', async () => {
      // Kyiv 03:30 on 2026-03-29 does not exist (03:00 → 04:00): planned at 04:00 +03:00.
      clock.set('2026-03-29T00:00:00Z');
      const kyiv = await newTask({ localTime: '03:30', nextRunAt: at('2026-03-29T01:00:00Z') });
      clock.set('2026-03-29T01:00:05Z');
      await h.scheduler.tick();
      expect((await events(kyiv.id)).map((e) => [e.occurrenceAt, e.disposition])).toEqual([
        [at('2026-03-29T01:00:00Z'), 'ADMITTED'],
      ]);
      // The next one returns to 03:30 local (+03:00).
      expect((await task(kyiv.id)).nextRunAt).toEqual(at('2026-03-30T00:30:00Z'));

      // New York Sunday 01:30 on 2026-11-01 happens twice; only the earlier (EDT) runs.
      const ny = await newTask({
        scheduleKind: 'WEEKLY',
        weekday: 7,
        localTime: '01:30',
        timeZone: 'America/New_York',
        nextRunAt: at('2026-11-01T05:30:00Z'),
      });
      clock.set('2026-11-01T05:30:10Z');
      await h.scheduler.tick();
      clock.set('2026-11-01T06:30:10Z'); // the later 01:30 (EST)
      await h.scheduler.tick();
      expect((await events(ny.id)).map((e) => [e.occurrenceAt, e.disposition])).toEqual([
        [at('2026-11-01T05:30:00Z'), 'ADMITTED'],
      ]);
      expect((await task(ny.id)).nextRunAt).toEqual(at('2026-11-08T06:30:00Z'));
    });

    it('computes the first future occurrence on creation and never runs research when saving', async () => {
      await say('/new');
      await say('Fixtures');
      await say('Матчі на поточному тижні');
      await press(button('Щодня'));
      await say('09:00');
      await press(button('Використати'));
      expect(h.sender.sent.at(-1)?.html).toContain('щонайбільше один пропущений запуск');
      expect(h.sender.sent.at(-1)?.html).not.toContain('ще не працюють');
      await press(button('Зберегти'));
      const [saved] = await h.prisma.task.findMany();
      expect(saved?.nextRunAt).toEqual(T0); // now is 08:00 Kyiv: today 09:00
      expect(h.sender.sent.at(-1)?.html).toContain(
        'Наступний запуск: 2026-10-19 09:00 (Europe/Kyiv).',
      );
      expect(await runs()).toHaveLength(0);
    });

    it('initializes existing scheduled tasks to the next future occurrence without historical work', async () => {
      const legacy = await newTask({ nextRunAt: null });
      await h.prisma
        .$executeRaw`UPDATE task SET created_at = '2025-01-01T00:00:00Z' WHERE id = ${legacy.id}::uuid`;
      const paused = await newTask({ nextRunAt: null });
      await h.prisma.task.update({ where: { id: paused.id }, data: { state: 'PAUSED' } });
      await h.scheduler.tick();
      expect((await task(legacy.id)).nextRunAt).toEqual(T0);
      expect((await task(paused.id)).nextRunAt).toBeNull();
      expect(await events()).toHaveLength(0);
      expect(await runs()).toHaveLength(0);
    });
  });

  describe('downtime and catch-up', () => {
    it('admits one catch-up for the latest occurrence after a short outage and records the rest', async () => {
      const t = await newTask({ nextRunAt: at('2026-10-16T06:00:00Z') });
      clock.set('2026-10-19T07:00:00Z'); // Monday 10:00 Kyiv
      await h.scheduler.tick();
      expect(await events(t.id)).toEqual([
        expect.objectContaining({
          occurrenceAt: at('2026-10-16T06:00:00Z'),
          disposition: 'SKIPPED_MISSED',
          reason: 'SUPERSEDED_BY_LATER_OCCURRENCE',
          rangeEnd: at('2026-10-18T06:00:00Z'),
          skippedCount: 3,
        }),
        expect.objectContaining({
          occurrenceAt: T0,
          disposition: 'ADMITTED',
          catchUp: true,
          latenessSeconds: 3_600,
        }),
      ]);
      expect((await runs()).map((r) => r.occurrenceAt)).toEqual([T0]);
      expect((await task(t.id)).nextRunAt).toEqual(at('2026-10-20T06:00:00Z'));
    });

    it('keeps a long outage bounded: skipped history, at most one catch-up, no burst', async () => {
      const daily = await newTask({ nextRunAt: at('2025-09-01T06:00:00Z') });
      const weekly = await newTask({
        scheduleKind: 'WEEKLY',
        weekday: 5,
        nextRunAt: at('2026-09-04T06:00:00Z'),
      });
      clock.set('2026-10-19T07:00:00Z');
      await h.scheduler.tick();

      expect(await events(daily.id)).toEqual([
        expect.objectContaining({ disposition: 'SKIPPED_MISSED', skippedCount: 413 }),
        expect.objectContaining({ occurrenceAt: T0, disposition: 'ADMITTED' }),
      ]);
      // The weekly task's latest occurrence (Friday) is older than 24 hours: no catch-up.
      expect(await events(weekly.id)).toEqual([
        expect.objectContaining({
          occurrenceAt: at('2026-09-04T06:00:00Z'),
          rangeEnd: at('2026-10-09T06:00:00Z'),
          skippedCount: 6,
        }),
        expect.objectContaining({
          occurrenceAt: at('2026-10-16T06:00:00Z'),
          disposition: 'SKIPPED_MISSED',
          reason: 'CATCH_UP_WINDOW_EXCEEDED',
        }),
      ]);
      expect((await task(weekly.id)).nextRunAt).toEqual(at('2026-10-23T06:00:00Z'));
      expect(await runs()).toHaveLength(1);
      await h.scheduler.tick();
      expect(await h.prisma.scheduleEvent.count()).toBe(4);
      expect(await runs()).toHaveLength(1);
    });

    it.each([
      ['exactly 24 hours old', 0, 'ADMITTED'],
      ['one minute older', MINUTE, 'SKIPPED_MISSED'],
    ])('treats a catch-up %s as %s', async (_name, extra, disposition) => {
      const t = await newTask({
        scheduleKind: 'WEEKLY',
        weekday: 1,
        nextRunAt: at('2026-10-12T06:00:00Z'),
      });
      clock.set(new Date(at('2026-10-13T06:00:00Z').getTime() + extra));
      await h.scheduler.tick();
      expect(await events(t.id)).toEqual([
        expect.objectContaining({ occurrenceAt: at('2026-10-12T06:00:00Z'), disposition }),
      ]);
      expect(await runs()).toHaveLength(disposition === 'ADMITTED' ? 1 : 0);
      expect((await task(t.id)).nextRunAt).toEqual(T0);
    });

    it('does not replay missed occurrences after pause and resume', async () => {
      const t = await newTask();
      await press(taskCallbackData(t.id, 1, 'p'));
      expect((await task(t.id)).nextRunAt).toBeNull();
      clock.set('2026-10-22T12:00:00Z');
      await h.scheduler.tick();
      await press(taskCallbackData(t.id, 2, 'u'));
      expect((await task(t.id)).nextRunAt).toEqual(at('2026-10-23T06:00:00Z'));
      await h.scheduler.tick();
      expect(await events()).toHaveLength(0);
      expect(await runs()).toHaveLength(0);
    });
  });

  describe('denials, overlap and manual runs', () => {
    it.each([
      ['a budget', { USER_MONTHLY_BUDGET_USD: '0.1' }, 'USER_BUDGET_EXHAUSTED'],
      ['missing pricing', { PRICING_VERSION: '' }, 'LIVE_ACCOUNTING_PRICING_NOT_CONFIGURED'],
    ])(
      'records %s denial once per occurrence, advances and reports it once',
      async (_n, env, reason) => {
        const l = await start(env, true);
        const t = await newTask();
        clock.set('2026-10-19T06:00:10Z');
        await l.scheduler.tick();
        await l.scheduler.tick(); // the same instant again: nothing new
        expect(await events(t.id)).toEqual([
          expect.objectContaining({ disposition: 'SKIPPED_DENIED', reason, notified: true }),
        ]);
        expect((await task(t.id)).nextRunAt).toEqual(at('2026-10-20T06:00:00Z'));
        clock.set('2026-10-20T06:00:10Z');
        await l.scheduler.tick();
        expect((await events(t.id)).map((e) => [e.disposition, e.reason, e.notified])).toEqual([
          ['SKIPPED_DENIED', reason, true],
          ['SKIPPED_DENIED', reason, false],
        ]);
        await drainDeliveries(l);
        expect(sent().filter((html) => html.includes('Заплановане дослідження'))).toHaveLength(1);
        expect(await runs()).toHaveLength(0);
        expect(await h.prisma.budgetReservation.count()).toBe(0);
        expect(await h.prisma.outboxEvent.count()).toBe(0);
      },
    );

    it('records a quota denial with its reason', async () => {
      const limited = await start({ USER_DAILY_RUN_LIMIT: '1' });
      await say('/research earlier today', ADMIN_ID, limited);
      const t = await newTask();
      clock.set('2026-10-19T06:00:10Z');
      await limited.scheduler.tick();
      expect(await events(t.id)).toEqual([
        expect.objectContaining({ disposition: 'SKIPPED_DENIED', reason: 'DAILY_RUN_LIMIT' }),
      ]);
      expect(await runs()).toHaveLength(1);
    });

    it('skips occurrences of a suspended owner silently', async () => {
      await addMember();
      const t = await newTask({ owner: MEMBER_ID });
      await say(`/admin suspend ${MEMBER_ID}`);
      clock.set('2026-10-19T06:00:10Z');
      await h.scheduler.tick();
      expect(await events(t.id)).toEqual([
        expect.objectContaining({
          disposition: 'SKIPPED_DENIED',
          reason: 'SUSPENDED',
          notified: false,
        }),
      ]);
      expect(await runs()).toHaveLength(0);
    });

    it('records a scheduled overlap with an active manual or scheduled run and keeps the schedule', async () => {
      const t = await newTask();
      await press(taskCallbackData(t.id, 1, 'r')); // manual run, QUEUED
      expect((await task(t.id)).nextRunAt).toEqual(T0); // Run now does not move the schedule
      const [manual] = await runs();
      clock.set('2026-10-19T06:00:10Z');
      await h.scheduler.tick();
      expect(await events(t.id)).toEqual([
        expect.objectContaining({
          disposition: 'SKIPPED_OVERLAP',
          reason: 'TASK_RUN_ACTIVE',
          runId: manual?.id,
        }),
      ]);
      expect(await runs()).toHaveLength(1);
      expect(await h.prisma.outboxEvent.count()).toBe(1); // nothing deferred
      expect((await task(t.id)).nextRunAt).toEqual(at('2026-10-20T06:00:00Z'));

      // A still-queued scheduled run makes the next occurrence an overlap too.
      await h.research.tick();
      clock.set('2026-10-20T06:00:10Z');
      await h.scheduler.tick();
      const scheduled = (await runs())[1];
      expect(scheduled).toMatchObject({ trigger: 'SCHEDULED', state: 'QUEUED' });
      clock.set('2026-10-21T06:00:10Z');
      await h.scheduler.tick();
      expect((await events(t.id)).map((e) => [e.disposition, e.runId])).toEqual([
        ['SKIPPED_OVERLAP', manual?.id],
        ['ADMITTED', scheduled?.id],
        ['SKIPPED_OVERLAP', scheduled?.id],
      ]);
      expect(await runs()).toHaveLength(2);
    });
  });

  describe('concurrency and crash recovery', () => {
    /** Holds the owner's identity lock until `waiters` sessions wait for it, then runs `meanwhile` and commits. */
    async function whileIdentityLocked(
      waiters: number,
      work: () => Promise<unknown>,
      meanwhile?: (blocker: Client) => Promise<void>,
    ): Promise<unknown> {
      const blocker = new Client({ connectionString: inject('databaseUrl') });
      await blocker.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))', [
          IDENTITY_LOCK_CLASS,
          String(ADMIN_ID),
        ]);
        const running = work();
        await vi.waitFor(async () => {
          const rows = await blocker.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
          );
          expect(rows.rows[0]?.n).toBe(waiters);
        });
        if (meanwhile) await meanwhile(blocker);
        await blocker.query('COMMIT');
        return await running;
      } finally {
        await blocker.end();
      }
    }

    it('lets two schedulers contend for one occurrence: one disposition, one run and reservation', async () => {
      const first = await start({}, true);
      const second = await start({}, true);
      const t = await newTask();
      clock.set('2026-10-19T06:00:10Z');
      await whileIdentityLocked(2, () =>
        Promise.all([first.scheduler.tick(), second.scheduler.tick()]),
      );
      expect(await events(t.id)).toEqual([expect.objectContaining({ disposition: 'ADMITTED' })]);
      expect(await runs()).toHaveLength(1);
      expect(await h.prisma.budgetReservation.count()).toBe(1);
      expect(await h.prisma.outboxEvent.count()).toBe(1);
    });

    it('leaves the occurrence due when its transaction rolls back, then admits it once', async () => {
      const l = await start({}, true);
      const t = await newTask();
      clock.set('2026-10-19T06:00:10Z');
      await h.prisma.$executeRawUnsafe(`
        CREATE FUNCTION test_fail_schedule_event() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`);
      await h.prisma.$executeRawUnsafe(`
        CREATE TRIGGER test_fail_schedule_event BEFORE INSERT ON schedule_event
        FOR EACH ROW EXECUTE FUNCTION test_fail_schedule_event()`);
      try {
        await l.scheduler.tick();
        expect(await runs()).toHaveLength(0);
        expect(await h.prisma.budgetReservation.count()).toBe(0);
        expect(await h.prisma.outboxEvent.count()).toBe(0);
        expect((await task(t.id)).nextRunAt).toEqual(T0);
        expect(
          open.some((x) =>
            x.logger.lines.some((line) => line.includes('Scheduled occurrence failed')),
          ),
        ).toBe(true);
      } finally {
        await h.prisma.$executeRawUnsafe('DROP TRIGGER test_fail_schedule_event ON schedule_event');
        await h.prisma.$executeRawUnsafe('DROP FUNCTION test_fail_schedule_event()');
      }
      await l.scheduler.tick();
      expect(await events(t.id)).toEqual([expect.objectContaining({ disposition: 'ADMITTED' })]);
      expect(await h.prisma.budgetReservation.count()).toBe(1);
    });

    it('publishes and executes an admitted occurrence after a crash before publication, once', async () => {
      await newTask();
      clock.set('2026-10-19T06:00:10Z');
      await h.scheduler.tick();
      expect(await h.prisma.outboxEvent.count({ where: { dispatchedAt: null } })).toBe(1);
      const crashed = h;
      open.splice(open.indexOf(crashed), 1);
      await crashed.close();
      h = await start();
      await h.scheduler.tick();
      expect(await h.research.tick()).toBe(true);
      expect(await runs()).toEqual([expect.objectContaining({ state: 'SUCCEEDED' })]);
      expect(await events()).toHaveLength(1);
      expect(h.provider.calls.submit).toBe(1);
    });

    it('lets a deletion committed while the scheduler waits win (no run)', async () => {
      const t = await newTask();
      clock.set('2026-10-19T06:00:10Z');
      await whileIdentityLocked(
        1,
        () => h.scheduler.tick(),
        async (blocker) => {
          await blocker.query(
            `UPDATE task SET state = 'DELETED', deleted_at = now(), revision = revision + 1, next_run_at = NULL
              WHERE id = $1`,
            [t.id],
          );
        },
      );
      expect(await events()).toHaveLength(0);
      expect(await runs()).toHaveLength(0);
    });

    it('does nothing for a stale candidate after a schedule edit', async () => {
      const t = await newTask();
      clock.set('2026-10-19T06:00:10Z');
      const candidate = {
        id: t.id,
        revision: t.revision,
        nextRunAt: T0,
        telegramUserId: BigInt(ADMIN_ID),
      };
      // The user changes the time to 10:00 before the scheduler takes its locks.
      await press(taskCallbackData(t.id, 1, 'es'));
      await press(button('Щодня'));
      await say('10:00');
      await press(button('Використати'));
      await press(button('Зберегти'));
      expect(await task(t.id)).toMatchObject({
        revision: 2,
        nextRunAt: at('2026-10-19T07:00:00Z'),
      });
      expect(await h.scheduler.processOccurrence(candidate, clock.now())).toBe('STALE');
      expect(await events()).toHaveLength(0);
      expect(await runs()).toHaveLength(0);
    });
  });

  describe('lifecycle of admitted scheduled work', () => {
    it.each([
      ['pause', 'TASK_PAUSED'],
      ['prompt edit', 'TASK_EDITED'],
    ])(
      'cancels a queued scheduled run on %s and releases its reservation once',
      async (action, code) => {
        const l = await start({}, true);
        const t = await newTask();
        clock.set('2026-10-19T06:00:10Z');
        await l.scheduler.tick();
        if (action === 'pause') {
          await press(taskCallbackData(t.id, 1, 'p'), ADMIN_ID, l);
        } else {
          await press(taskCallbackData(t.id, 1, 'ep'), ADMIN_ID, l);
          await say('New prompt', ADMIN_ID, l);
          const save = l.sender.sent
            .at(-1)
            ?.replyMarkup?.inline_keyboard.flat()
            .find((b) => b.text === 'Зберегти');
          await press(save?.callback_data ?? '', ADMIN_ID, l);
        }
        const [run] = await runs();
        expect(run).toMatchObject({ state: 'CANCELLED', failureCode: code });
        const ledger = await h.prisma.usageLedger.findMany({
          where: { runId: run?.id },
          orderBy: { createdAt: 'asc' },
        });
        expect(ledger.map((e) => e.kind)).toEqual(['RESERVE', 'RELEASE']);
        expect(await l.research.tick()).toBe(false);
        expect(submissions()).toBe(0);
      },
    );

    it('cancels queued scheduled work of a member suspended after admission', async () => {
      await addMember();
      await newTask({ owner: MEMBER_ID });
      clock.set('2026-10-19T06:00:10Z');
      await h.scheduler.tick();
      await say(`/admin suspend ${MEMBER_ID}`);
      expect(await runs()).toEqual([
        expect.objectContaining({ state: 'CANCELLED', failureCode: 'USER_SUSPENDED' }),
      ]);
      expect(await h.research.tick()).toBe(false);
    });

    it('keeps the running snapshot on edit and suppresses delivery after deletion', async () => {
      const t = await newTask({ prompt: 'Original prompt' });
      clock.set('2026-10-19T06:00:10Z');
      await h.scheduler.tick();
      const polled = gate();
      const answered = gate();
      h.provider.onRetrieve = async (id) => {
        polled.open();
        await answered.promise;
        return new ScriptedProvider().onRetrieve(id);
      };
      const executing = h.research.tick();
      await polled.promise;

      await press(taskCallbackData(t.id, 1, 'ep'));
      await say('Edited prompt');
      await press(button('Зберегти'));
      expect(await runs()).toEqual([
        expect.objectContaining({ state: 'RUNNING', prompt: 'Original prompt' }),
      ]);
      await press(taskCallbackData(t.id, 2, 'd'));
      await press(taskCallbackData(t.id, 2, 'dy'));
      answered.open();
      expect(await executing).toBe(true);
      const [run] = await runs();
      expect(run).toMatchObject({ state: 'SUCCEEDED', deliverySuppressionReason: 'TASK_DELETED' });
      expect(h.provider.requests[0]?.input).toContain('Original prompt');
      expect(
        await h.prisma.delivery.findFirstOrThrow({ where: { runId: run?.id, kind: 'REPORT' } }),
      ).toMatchObject({ state: 'SUPPRESSED' });
      expect((await task(t.id)).nextRunAt).toBeNull();
    });

    it('uses the actual execution time for a delayed run and keeps the request on recovery', async () => {
      await newTask();
      clock.set('2026-10-19T06:00:05Z');
      await h.scheduler.tick();
      clock.set('2026-10-19T08:00:05Z'); // the queue was delayed by two hours
      h.provider.onRetrieve = (id) =>
        Promise.resolve(snapshot(h.provider.echo, { id, status: 'in_progress' }));
      const shutdown = new AbortController();
      const executing = h.research.tick(shutdown.signal);
      await vi.waitFor(() => expect(h.provider.calls.retrieve).toBeGreaterThan(0));
      shutdown.abort();
      await executing;
      const input = h.provider.requests[0]?.input ?? '';
      expect(input).toContain('Current time (UTC): 2026-10-19T08:00:05Z');
      expect(input).toContain('Current local time: 2026-10-19 11:00');
      expect(input).toContain('actually started 120 minute(s) later');
      const stored = (await runs())[0]?.requestSnapshot as { request: { input: string } };
      expect(stored.request.input).toBe(input);

      // Another process resumes the saved response later, without a new request.
      clock.advance(30_000);
      const resumed = await start();
      resumed.provider.onRetrieve = (id) => new ScriptedProvider().onRetrieve(id);
      expect(await resumed.research.tick()).toBe(true);
      expect(resumed.provider.calls.submit).toBe(0);
      const [run] = await runs();
      expect(run?.state).toBe('SUCCEEDED');
      expect((run?.requestSnapshot as { request: { input: string } }).request.input).toBe(input);
      await drainDeliveries(resumed);
      const report = sent().find((html) => html.includes('Заплановано на')) ?? '';
      expect(report).toContain(
        'Заплановано на: 2026-10-19 09:00 Europe/Kyiv — виконано із затримкою',
      );
    });
  });
});
