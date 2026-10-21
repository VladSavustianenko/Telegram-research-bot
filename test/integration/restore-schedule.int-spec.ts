import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHold, setHold } from '../../src/operations/hold';
import { taskCallbackData } from '../../src/telegram/callback-data';
import { FakeClock, ScriptedProvider } from '../support/fakes';
import { httpServer } from '../support/http';
import { LIVE_TEST_ENV } from '../support/live-env';
import {
  ADMIN_ID,
  callbackQuery,
  resetDatabase,
  startHarness,
  type Harness,
} from '../support/research-harness';

// TRB-100 review fix (commit 062d2b2): a restored scheduled task whose overdue
// occurrence already ran after the backup, while its run is absent from the
// copy. docs/OPERATIONS.md §11.3: research stays disabled through the hold
// removal, the task is paused through Telegram, research is re-enabled, and
// the task is resumed. Real PostgreSQL and pg-boss, controlled clock, scripted
// provider (live configuration), recording sender.

/** Restored "now": Monday 2026-10-19 13:00 in Kyiv. */
const NOW = new Date('2026-10-19T10:00:00Z');
/** The task's 09:00 Kyiv occurrence that day: 4 h overdue (inside the 24 h catch-up window). */
const RESTORED_OCCURRENCE = new Date('2026-10-19T06:00:00Z');
const NEXT_OCCURRENCE = new Date('2026-10-20T06:00:00Z');

const LIVE = { ...LIVE_TEST_ENV, BACKGROUND_WORKERS: 'on', WORKER_POLL_INTERVAL_MS: '50' };
const DISABLED = { ...LIVE, RESEARCH_MODE: 'disabled' };

describe('TRB-100 restore: scheduled catch-up of an occurrence absent from the backup', () => {
  const open: Harness[] = [];
  let clock: FakeClock;
  let base: Harness;
  let taskId: string;

  const start = async (env: Record<string, string>) => {
    const harness = await startHarness(env, { clock, provider: new ScriptedProvider('openai') });
    open.push(harness);
    return harness;
  };
  const close = async (harness: Harness) => {
    open.splice(open.indexOf(harness), 1);
    await harness.close();
  };
  const task = () => base.prisma.task.findUniqueOrThrow({ where: { id: taskId } });
  const restoredOccurrence = async () => ({
    runs: await base.prisma.researchRun.count({ where: { occurrenceAt: RESTORED_OCCURRENCE } }),
    events: await base.prisma.scheduleEvent.count({
      where: { occurrenceAt: RESTORED_OCCURRENCE },
    }),
  });
  const totals = async () => ({
    runs: await base.prisma.researchRun.count(),
    reservations: await base.prisma.budgetReservation.count(),
    outbox: await base.prisma.outboxEvent.count(),
  });
  /** The scheduler loop of a process (absent when the configuration does not start it). */
  const schedulerLoop = (harness: Harness) =>
    (harness.scheduler as unknown as { loop?: unknown }).loop;

  beforeEach(async () => {
    clock = new FakeClock(NOW);
    base = await startHarness(LIVE_TEST_ENV, { clock });
    open.push(base);
    await resetDatabase(base.prisma);
    const owner = await base.prisma.appUser.findUniqueOrThrow({
      where: { telegramUserId: BigInt(ADMIN_ID) },
    });
    // The restored copy: an active daily task still pointing at an occurrence that,
    // in reality, ran after the backup; its run, reservation and events are absent.
    const created = await base.prisma.task.create({
      data: {
        userId: owner.id,
        name: 'Daily task',
        prompt: 'Football fixtures for the current week',
        scheduleKind: 'DAILY',
        localTime: '09:00',
        timeZone: 'Europe/Kyiv',
        nextRunAt: RESTORED_OCCURRENCE,
      },
    });
    taskId = created.id;
    // The fixture really is overdue and inside the catch-up window, with nothing
    // else that could prevent execution (no UNCERTAIN run, no prior usage).
    expect(RESTORED_OCCURRENCE.getTime()).toBeLessThan(NOW.getTime());
    expect(NOW.getTime() - RESTORED_OCCURRENCE.getTime()).toBeLessThan(24 * 3_600_000);
    expect(await totals()).toEqual({ runs: 0, reservations: 0, outbox: 0 });
    await setHold(base.prisma, { reason: 'restored backup', setBy: 'owner' });
  });

  afterEach(async () => {
    await clearHold(base.prisma);
    for (const harness of open.splice(0).reverse()) await harness.close();
  });

  it('unsafe order: clearing the hold with research enabled re-runs the restored occurrence', async () => {
    const live = await start(LIVE);
    expect(live.gate.state).toBe('held');
    expect(schedulerLoop(live)).toBeUndefined(); // held: nothing started

    await clearHold(base.prisma);
    expect(await live.gate.evaluateNow()).toBe('open');
    await vi.waitFor(
      async () => {
        const [run] = await base.prisma.researchRun.findMany();
        expect(run).toMatchObject({ occurrenceAt: RESTORED_OCCURRENCE, state: 'SUCCEEDED' });
      },
      { timeout: 15_000 },
    );
    // The occurrence that already ran after the backup was submitted (and billed) again.
    expect(live.provider.calls.submit).toBe(1);
    expect(await restoredOccurrence()).toEqual({ runs: 1, events: 1 });
  }, 30_000);

  it('documented order: disabled research, pause, enable, resume — no catch-up', async () => {
    // Step 1: every process restarted with RESEARCH_MODE=disabled while the hold is set.
    const quiet = await start(DISABLED);
    expect(quiet.gate.state).toBe('held');
    await request(httpServer(quiet.app))
      .get('/health/ready')
      .expect(200)
      .expect((res) => expect(res.body).toMatchObject({ status: 'held' }));

    // Step 2: clear the hold with research still disabled. The scheduler is not started.
    await clearHold(base.prisma);
    expect(await quiet.gate.evaluateNow()).toBe('open');
    expect(schedulerLoop(quiet)).toBeUndefined();

    // Step 3: the owner pauses the task through Telegram (normal ingress and task path).
    const before = await task();
    await quiet.post(callbackQuery(taskCallbackData(taskId, before.revision, 'p'))).expect(200);
    const paused = await task();
    expect(paused).toMatchObject({ state: 'PAUSED', nextRunAt: null });
    await close(quiet);

    // Step 4: restart with research enabled while the task stays paused.
    const live = await start(LIVE);
    expect(live.gate.state).toBe('open');
    await vi.waitFor(() => expect(schedulerLoop(live)).toBeDefined());
    await live.scheduler.tick(); // one complete pass at the restored "now"
    expect(await restoredOccurrence()).toEqual({ runs: 0, events: 0 });
    expect(await totals()).toEqual({ runs: 0, reservations: 0, outbox: 0 });
    expect(live.provider.calls.submit).toBe(0);

    // Step 5: resume explicitly; the next occurrence is strictly after the resume time.
    await live.post(callbackQuery(taskCallbackData(taskId, paused.revision, 'u'))).expect(200);
    const resumed = await task();
    expect(resumed.state).toBe('ACTIVE');
    expect(resumed.nextRunAt).toEqual(NEXT_OCCURRENCE);
    expect(resumed.nextRunAt!.getTime()).toBeGreaterThan(clock.now().getTime());
    await live.scheduler.tick();
    expect(await totals()).toEqual({ runs: 0, reservations: 0, outbox: 0 });
    expect(live.provider.calls.submit).toBe(0);

    // At that future occurrence, normal scheduling admits and executes exactly one run.
    clock.set(new Date(NEXT_OCCURRENCE.getTime() + 30_000));
    await live.scheduler.tick();
    await vi.waitFor(
      async () => {
        const runs = await base.prisma.researchRun.findMany();
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ occurrenceAt: NEXT_OCCURRENCE, state: 'SUCCEEDED' });
      },
      { timeout: 15_000 },
    );
    expect(live.provider.calls.submit).toBe(1);
    expect(await base.prisma.budgetReservation.count()).toBe(1);
    expect(await restoredOccurrence()).toEqual({ runs: 0, events: 0 });
  }, 60_000);
});
