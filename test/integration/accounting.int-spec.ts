import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { AccountingResolutionError, resolveRun, settleRun } from '../../src/accounting/ledger';
import { reconcileUncertainRun } from '../../src/research/reconciliation';
import { buildTextPart } from '../../src/research/provider/fake-fixtures';
import type { ProviderSnapshot } from '../../src/research/provider/provider.types';
import { taskCallbackData } from '../../src/telegram/callback-data';
import {
  FakeClock,
  ScriptedProvider,
  completed,
  echoed,
  notAccepted,
  snapshot,
  unknownOutcome,
} from '../support/fakes';
import { LIVE_TEST_ENV, TEST_RESERVATION_MICROS } from '../support/live-env';
import {
  ADMIN_ID,
  OTHER_ADMIN_ID,
  callbackQuery,
  drainDeliveries,
  privateMessage,
  resetDatabase,
  startHarness,
  type Harness,
} from '../support/research-harness';

/** Default scripted completion: 1 200 input, 300 output tokens, 1 search item; model "test-model". */
const ESTIMATED = 14_800n; // 1 200 x 2 + 300 x 8 + 1 x 10 000
const UNCERTAIN = 50_000n; // (6 - 1) x 10 000
const ADMISSION_LOCK = 20_020;

describe('TRB-050 admission, quotas and accounting (scripted provider, real PostgreSQL)', () => {
  const open: Harness[] = [];
  const start = async (...args: Parameters<typeof startHarness>) => {
    const harness = await startHarness(...args);
    open.push(harness);
    return harness;
  };
  let h: Harness;

  beforeEach(async () => {
    h = await start();
    await resetDatabase(h.prisma);
  });

  afterEach(async () => {
    for (const harness of open.splice(0)) await harness.close();
  });

  const live = (env: Record<string, string> = {}, deps: Parameters<typeof startHarness>[1] = {}) =>
    start({ ...LIVE_TEST_ENV, ...env }, { provider: new ScriptedProvider('openai'), ...deps });
  const research = (harness: Harness, text = 'football', from = ADMIN_ID) =>
    harness.post(privateMessage(`/research ${text}`, from)).expect(200);
  const runs = () => h.prisma.researchRun.findMany({ orderBy: { createdAt: 'asc' } });
  const reservationOf = (runId: string) =>
    h.prisma.budgetReservation.findUniqueOrThrow({ where: { runId } });
  const ledgerOf = (runId: string) =>
    h.prisma.usageLedger.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } });
  const ledgerSum = async (runId: string) =>
    (await ledgerOf(runId)).reduce((sum, entry) => sum + entry.amountMicros, 0n);
  const reasons = async (n: number) =>
    (await h.prisma.telegramUpdate.findMany({ orderBy: { updateId: 'desc' }, take: n }))
      .map((u) => u.reason)
      .reverse();
  const submissions = () => open.reduce((n, harness) => n + harness.provider.calls.submit, 0);
  const userId = async (telegramId = ADMIN_ID) =>
    (await h.prisma.appUser.findUniqueOrThrow({ where: { telegramUserId: BigInt(telegramId) } }))
      .id;
  const newTask = async (telegramId = ADMIN_ID, state: 'ACTIVE' | 'PAUSED' = 'ACTIVE') =>
    h.prisma.task.create({
      data: {
        userId: await userId(telegramId),
        name: 'Задача',
        prompt: 'Запит задачі',
        scheduleKind: 'DAILY',
        localTime: '09:00',
        timeZone: 'America/New_York',
        state,
      },
    });
  const runNow = (
    harness: Harness,
    taskId: string,
    revision = 1,
    from = ADMIN_ID,
    updateId?: number,
  ) =>
    harness
      .post(callbackQuery(taskCallbackData(taskId, revision, 'r'), from, updateId))
      .expect(200);

  /** Holds the global admission lock until `waiters` sessions wait at PostgreSQL, then releases it. */
  async function overlapping<T>(waiters: number, requests: () => Promise<T>[]): Promise<T[]> {
    const blocker = new Client({ connectionString: inject('databaseUrl') });
    await blocker.connect();
    try {
      await blocker.query('SELECT pg_advisory_lock($1)', [ADMISSION_LOCK]);
      const all = Promise.all(requests());
      await vi.waitFor(async () => {
        const rows = await blocker.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        expect(rows.rows[0]?.n).toBe(waiters);
      });
      await blocker.query('SELECT pg_advisory_unlock($1)', [ADMISSION_LOCK]);
      return await all;
    } finally {
      await blocker.end();
    }
  }

  describe('admission and settlement', () => {
    it('reserves, records evidence and the execution event, then settles once', async () => {
      const l = await live();
      await research(l);
      const [run] = await runs();
      const reservation = await reservationOf(run?.id ?? '');
      expect(reservation).toMatchObject({
        status: 'RESERVED',
        reservedMicros: TEST_RESERVATION_MICROS,
        exposureMicros: TEST_RESERVATION_MICROS,
        periodMonth: '2026-10',
        pricingVersion: 'synthetic-test-1',
        policyVersion: 'reservation-policy-2026-10-19.1',
      });
      expect(reservation.policy).toMatchObject({
        webSearchCallAllowance: 6,
        toolCallLimit: 3,
        inputTokenAllowance: 100_000,
        components: { inputMicros: '200000', outputMicros: '24000', webSearchMicros: '60000' },
      });
      expect(run).toMatchObject({
        admittedDay: '2026-10-18',
        admittedMonth: '2026-10',
        trigger: 'MANUAL',
      });
      expect(run?.requestSnapshot).toMatchObject({
        accounting: { pricingVersion: 'synthetic-test-1', reservedMicros: '284000' },
      });
      expect(await h.prisma.outboxEvent.findMany()).toMatchObject([
        { type: 'RESEARCH_EXECUTE', runId: run?.id, dispatchedAt: null, cancelledAt: null },
      ]);

      await l.research.tick();
      expect((await h.prisma.outboxEvent.findFirstOrThrow()).dispatchedAt).not.toBeNull();
      expect(await reservationOf(run?.id ?? '')).toMatchObject({
        status: 'SETTLED',
        estimatedMicros: ESTIMATED,
        uncertainMicros: UNCERTAIN,
        exposureMicros: ESTIMATED + UNCERTAIN,
      });
      expect((await ledgerOf(run?.id ?? '')).map((e) => e.kind)).toEqual(['RESERVE', 'SETTLE']);
      expect(await ledgerSum(run?.id ?? '')).toBe(ESTIMATED + UNCERTAIN);

      // Replayed settlement and release change nothing.
      const replay = await h.prisma.$transaction(async (tx) => [
        await settleRun(tx, run?.id ?? '', { outcome: 'release', reason: 'REPLAY' }),
        await settleRun(tx, run?.id ?? '', {
          outcome: 'settle',
          reason: 'REPLAY',
          usage: null,
          returnedModel: null,
          observedSearchItems: 0,
        }),
      ]);
      expect(replay).toEqual(['ALREADY_FINAL', 'ALREADY_FINAL']);
      expect(await ledgerOf(run?.id ?? '')).toHaveLength(2);
      expect(submissions()).toBe(1);
    });

    it.each([
      ['USER_MONTHLY_BUDGET_USD', 'LIVE_ACCOUNTING_BUDGETS_NOT_CONFIGURED'],
      ['GLOBAL_MONTHLY_BUDGET_USD', 'LIVE_ACCOUNTING_BUDGETS_NOT_CONFIGURED'],
      ['PRICING_VERSION', 'LIVE_ACCOUNTING_PRICING_NOT_CONFIGURED'],
      ['OPENAI_PRICE_OUTPUT_PER_MTOK_USD', 'LIVE_ACCOUNTING_PRICING_NOT_CONFIGURED'],
      ['RESERVATION_WEB_SEARCH_CALLS', 'LIVE_ACCOUNTING_RESERVATION_NOT_CONFIGURED'],
    ])('refuses live admission without %s and submits nothing', async (variable, reason) => {
      const l = await live({ [variable]: '' });
      await research(l);
      await l.research.tick();
      expect(await reasons(1)).toEqual([reason]);
      expect(await h.prisma.researchRun.count()).toBe(0);
      expect(await h.prisma.budgetReservation.count()).toBe(0);
      expect(await h.prisma.outboxEvent.count()).toBe(0);
      expect(submissions()).toBe(0);
      await drainDeliveries(l);
      expect(l.sender.sent.at(-1)?.html).toContain('оператор не налаштував бюджети або ціни');
    });

    it('refuses an unmapped model and a reused pricing label with different rates', async () => {
      const unmapped = await live({ PRICING_MODEL: 'another-model' });
      await research(unmapped);
      expect(await reasons(1)).toEqual(['LIVE_ACCOUNTING_MODEL_NOT_PRICED']);
      const first = await live();
      await research(first, 'one');
      const changed = await live({ OPENAI_PRICE_INPUT_PER_MTOK_USD: '4' });
      await research(changed, 'two');
      expect(await reasons(1)).toEqual(['LIVE_ACCOUNTING_PRICING_VERSION_CONFLICT']);
      expect(await h.prisma.researchRun.count()).toBe(1);
      expect(submissions()).toBe(0);
    });

    it('keeps accepted runs on their own pricing after the configuration changes', async () => {
      const v1 = await live();
      await research(v1, 'under v1');
      const [run] = await runs();
      const before = await reservationOf(run?.id ?? '');
      await v1.close();
      open.splice(open.indexOf(v1), 1);
      // New label and higher prices; the worker of the new configuration settles the old run.
      const v2 = await live({
        PRICING_VERSION: 'synthetic-test-2',
        OPENAI_PRICE_INPUT_PER_MTOK_USD: '4',
        OPENAI_PRICE_OUTPUT_PER_MTOK_USD: '16',
      });
      await v2.research.tick();
      const settled = await reservationOf(run?.id ?? '');
      expect(settled).toMatchObject({
        estimatedMicros: ESTIMATED,
        pricingVersion: 'synthetic-test-1',
      });
      expect(settled.policy).toEqual(before.policy);
      await research(v2, 'under v2');
      const newer = (await runs())[1];
      expect(await reservationOf(newer?.id ?? '')).toMatchObject({
        pricingVersion: 'synthetic-test-2',
        reservedMicros: 400_000n + 48_000n + 60_000n,
      });
      expect(await h.prisma.pricingVersion.count()).toBe(2);
    });

    it('keeps live research administrator-only and fake runs out of live accounting', async () => {
      await h.prisma.appUser.update({
        where: { telegramUserId: BigInt(OTHER_ADMIN_ID) },
        data: { role: 'MEMBER', invitedAt: new Date() },
      });
      const l = await live({ ADMIN_TELEGRAM_IDS: `${ADMIN_ID}` });
      await research(l, 'member', OTHER_ADMIN_ID);
      expect(await reasons(1)).toEqual(['LIVE_ADMIN_ONLY']);
      expect(await h.prisma.budgetReservation.count()).toBe(0);

      // Simulated runs: no reservation, no money, and they do not block live budgets.
      await research(h, 'simulated');
      await h.research.tick();
      expect(await h.prisma.budgetReservation.count()).toBe(0);
      await h.post(privateMessage('/usage')).expect(200);
      await drainDeliveries(h);
      expect(h.sender.sent.at(-1)?.html).toContain('Режим симуляції: реальних витрат немає.');
      await research(l, 'live after fake');
      expect(await h.prisma.budgetReservation.count()).toBe(1);
      expect(l.provider.calls.submit).toBe(0);
    });
  });

  describe('concurrent capacity', () => {
    it('admits no more than the user budget allows under overlapping requests', async () => {
      const instances = [
        await live({ USER_MONTHLY_BUDGET_USD: '0.6' }),
        await live({ USER_MONTHLY_BUDGET_USD: '0.6' }),
        await live({ USER_MONTHLY_BUDGET_USD: '0.6' }),
      ];
      // One request waits for the admission lock, the other two for the sender's identity lock.
      await overlapping(3, () => instances.map((instance, i) => research(instance, `topic ${i}`)));
      expect(await h.prisma.researchRun.count()).toBe(2);
      expect(await h.prisma.budgetReservation.count()).toBe(2);
      expect(
        await h.prisma.telegramUpdate.count({ where: { reason: 'USER_BUDGET_EXHAUSTED' } }),
      ).toBe(1);
      expect(await h.prisma.outboxEvent.count()).toBe(2);
    });

    it('shares the global budget between users without exceeding it', async () => {
      const env = { GLOBAL_MONTHLY_BUDGET_USD: '0.6' };
      const instances = [await live(env), await live(env), await live(env), await live(env)];
      await overlapping(4, () =>
        instances.map((instance, i) =>
          research(instance, `t${i}`, i % 2 === 0 ? ADMIN_ID : OTHER_ADMIN_ID),
        ),
      );
      expect(await h.prisma.budgetReservation.count()).toBe(2);
      const total = await h.prisma.budgetReservation.aggregate({ _sum: { exposureMicros: true } });
      expect(total._sum.exposureMicros).toBe(2n * TEST_RESERVATION_MICROS);
      expect(
        await h.prisma.telegramUpdate.count({ where: { reason: 'GLOBAL_BUDGET_EXHAUSTED' } }),
      ).toBe(2);
    });

    it('enforces daily and active-run quotas under overlapping requests', async () => {
      const env = {
        USER_DAILY_RUN_LIMIT: '2',
        USER_ACTIVE_RUN_LIMIT: '10',
        RESEARCH_QUEUE_LIMIT: '10',
      };
      const instances = [await start(env), await start(env), await start(env)];
      await overlapping(3, () => instances.map((instance, i) => research(instance, `q${i}`)));
      expect(await h.prisma.researchRun.count()).toBe(2);
      expect(await reasons(3)).toContain('DAILY_RUN_LIMIT');

      const active = await start({ USER_ACTIVE_RUN_LIMIT: '2', RESEARCH_QUEUE_LIMIT: '10' });
      await research(active, 'third', OTHER_ADMIN_ID);
      await research(active, 'fourth', OTHER_ADMIN_ID);
      await research(active, 'fifth', OTHER_ADMIN_ID);
      expect(await reasons(1)).toEqual(['USER_ACTIVE_LIMIT']);
      const manual = await start({ USER_DAILY_MANUAL_RUN_LIMIT: '2', RESEARCH_QUEUE_LIMIT: '10' });
      await research(manual, 'm', OTHER_ADMIN_ID);
      expect(await reasons(1)).toEqual(['DAILY_MANUAL_LIMIT']);
    });

    it('starts one run per task for duplicate and concurrent Run now presses', async () => {
      const task = await newTask();
      const other = await start();
      const press = callbackQuery(taskCallbackData(task.id, 1, 'r'));
      await overlapping(3, () => [
        h.post(press),
        h.post(press),
        other.post(callbackQuery(taskCallbackData(task.id, 1, 'r'))),
      ]);
      await runNow(h, task.id);
      const taskRuns = await h.prisma.researchRun.findMany({ where: { taskId: task.id } });
      expect(taskRuns).toHaveLength(1);
      expect(taskRuns[0]).toMatchObject({ prompt: 'Запит задачі', taskRevision: 1 });
      expect(taskRuns[0]?.requestSnapshot).toMatchObject({
        config: { timeZone: 'America/New_York' },
      });
      expect(await reasons(1)).toEqual(['TASK_RUN_ACTIVE']);
      // The task itself is unchanged: no schedule or revision change.
      expect(await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
      // The database also forbids a second active run of the task.
      await expect(
        h.prisma.$executeRaw`UPDATE research_run SET task_id = ${task.id}::uuid, task_revision = 1
                              WHERE id = (SELECT id FROM research_run WHERE task_id IS NULL LIMIT 1)`,
      ).resolves.toBe(0);
    });
  });

  describe('lifecycle and accounting', () => {
    it('releases a queued live run cancelled by task pause exactly once and leaves nothing executable', async () => {
      const l = await live();
      const task = await newTask();
      await runNow(l, task.id);
      const [run] = await runs();
      await drainDeliveries(l);
      await l.post(callbackQuery(taskCallbackData(task.id, 1, 'p'))).expect(200);
      expect(
        await h.prisma.researchRun.findUniqueOrThrow({ where: { id: run?.id } }),
      ).toMatchObject({
        state: 'CANCELLED',
        failureCode: 'TASK_PAUSED',
        submissionState: 'NOT_SUBMITTED',
      });
      expect(await reservationOf(run?.id ?? '')).toMatchObject({
        status: 'RELEASED',
        exposureMicros: 0n,
      });
      expect((await ledgerOf(run?.id ?? '')).map((e) => [e.kind, e.amountMicros])).toEqual([
        ['RESERVE', TEST_RESERVATION_MICROS],
        ['RELEASE', -TEST_RESERVATION_MICROS],
      ]);
      expect((await h.prisma.outboxEvent.findFirstOrThrow()).cancelledAt).not.toBeNull();
      await h.prisma.$transaction((tx) =>
        settleRun(tx, run?.id ?? '', { outcome: 'release', reason: 'REPLAY' }),
      );
      expect(await ledgerOf(run?.id ?? '')).toHaveLength(2);
      expect(await l.research.tick()).toBe(false);
      expect(submissions()).toBe(0);
      // A paused task can still be run manually; the cancelled run does not count against quotas.
      await runNow(l, task.id, 2);
      expect(await h.prisma.researchRun.count({ where: { state: 'QUEUED' } })).toBe(1);
    });

    it('does not count a run cancelled before submission against the daily quota', async () => {
      const one = await start({ USER_DAILY_RUN_LIMIT: '1', USER_DAILY_MANUAL_RUN_LIMIT: '1' });
      const task = await newTask();
      await runNow(one, task.id);
      await research(one, 'blocked');
      expect(await reasons(1)).toEqual(['DAILY_RUN_LIMIT']);
      await one.post(callbackQuery(taskCallbackData(task.id, 1, 'p'))).expect(200);
      expect((await runs())[0]).toMatchObject({
        state: 'CANCELLED',
        submissionState: 'NOT_SUBMITTED',
      });
      await research(one, 'allowed again');
      expect(await reasons(1)).toEqual([null]);
      // A run that reached the provider keeps counting.
      await one.research.tick();
      await research(one, 'still blocked');
      expect(await reasons(1)).toEqual(['DAILY_RUN_LIMIT']);
    });

    it('releases on deletion and suspension paths and cancels execution events', async () => {
      const task = await newTask();
      await runNow(h, task.id);
      await h.post(callbackQuery(taskCallbackData(task.id, 1, 'd'))).expect(200);
      await h.post(callbackQuery(taskCallbackData(task.id, 1, 'dy'))).expect(200);
      expect((await runs())[0]).toMatchObject({ state: 'CANCELLED', failureCode: 'TASK_DELETED' });
      expect((await h.prisma.outboxEvent.findFirstOrThrow()).cancelledAt).not.toBeNull();
      expect(await h.research.tick()).toBe(false);
      expect(submissions()).toBe(0);
    });

    it('suppresses delivery of a deleted task’s running work without cancelling the request', async () => {
      const l = await live();
      const task = await newTask();
      let polls = 0;
      l.provider.onRetrieve = async (id) => {
        polls += 1;
        if (polls === 1) {
          await l.post(callbackQuery(taskCallbackData(task.id, 1, 'd'))).expect(200);
          await l.post(callbackQuery(taskCallbackData(task.id, 1, 'dy'))).expect(200);
          return snapshot(l.provider.echo, { id, status: 'in_progress' });
        }
        return {
          ...completed([
            buildTextPart([
              'OUTCOME: FOUND\nX',
              { cite: { url: 'https://a.example/', title: 'A' } },
            ]),
          ]),
          id,
          bounds: echoed(l.provider.echo),
        };
      };
      await runNow(l, task.id);
      await drainDeliveries(l);
      await l.research.tick();
      const [run] = await runs();
      expect(run).toMatchObject({ state: 'SUCCEEDED', deliverySuppressionReason: 'TASK_DELETED' });
      expect(l.provider.calls.cancel).toBe(0);
      expect(
        await h.prisma.delivery.findFirstOrThrow({ where: { runId: run?.id, kind: 'REPORT' } }),
      ).toMatchObject({
        state: 'SUPPRESSED',
        lastErrorCode: 'TASK_DELETED',
      });
      expect((await reservationOf(run?.id ?? '')).status).toBe('SETTLED');
    });

    it.each([
      ['an unknown submission outcome', 'UNCERTAIN'],
      ['a provider refusal', 'FAILED'],
    ])('accounts for %s', async (_case, state) => {
      const l = await live();
      l.provider.onSubmit = () =>
        Promise.reject(state === 'FAILED' ? notAccepted() : unknownOutcome());
      await research(l);
      await l.research.tick();
      const [run] = await runs();
      expect(run?.state).toBe(state);
      expect(await reservationOf(run?.id ?? '')).toMatchObject(
        state === 'FAILED'
          ? { status: 'RELEASED', exposureMicros: 0n }
          : { status: 'UNRESOLVED', exposureMicros: TEST_RESERVATION_MICROS },
      );
      expect(l.provider.calls.submit).toBe(1);
    });

    it('retains exposure after a deadline whose cancellation failed', async () => {
      const l = await live();
      l.provider.onRetrieve = (id) => {
        l.clock.advance(400_000);
        return Promise.resolve(snapshot(l.provider.echo, { id, status: 'in_progress' }));
      };
      l.provider.onCancel = () => Promise.reject(new Error('network'));
      await research(l);
      await l.research.tick();
      const [run] = await runs();
      expect(run).toMatchObject({ state: 'UNCERTAIN', failureCode: 'DEADLINE_CANCEL_UNCONFIRMED' });
      expect(await reservationOf(run?.id ?? '')).toMatchObject({
        status: 'UNRESOLVED',
        exposureMicros: TEST_RESERVATION_MICROS,
      });
    });

    it.each([
      ['missing usage', { usage: null }, 'USAGE_MISSING'],
      [
        'partial usage',
        {
          usage: {
            inputTokens: 1200,
            outputTokens: null,
            reasoningTokens: null,
            cachedInputTokens: null,
            totalTokens: null,
          },
        },
        'USAGE_PARTIAL',
      ],
      ['an unmapped returned model', { model: 'surprise-model' }, 'MODEL_NOT_PRICED'],
    ] as const)('never settles %s as zero', async (_case, overrides, unknownBecause) => {
      const l = await live();
      l.provider.onRetrieve = (id) =>
        Promise.resolve({
          ...completed(
            [
              buildTextPart([
                'OUTCOME: FOUND\nX',
                { cite: { url: 'https://a.example/', title: 'A' } },
              ]),
            ],
            overrides as Partial<ProviderSnapshot>,
          ),
          id,
          bounds: echoed(l.provider.echo),
        });
      l.provider.onSubmit = (request) =>
        Promise.resolve(
          snapshot(request, {
            model: 'model' in overrides ? (overrides.model as string) : 'test-model',
          }),
        );
      await research(l);
      await l.research.tick();
      const [run] = await runs();
      expect(await reservationOf(run?.id ?? '')).toMatchObject({
        status: 'UNRESOLVED',
        exposureMicros: TEST_RESERVATION_MICROS,
      });
      expect((await ledgerOf(run?.id ?? '')).at(-1)?.basis).toMatchObject({ unknownBecause });
    });

    it('records an overrun in full and refuses further admission once the budget is exhausted', async () => {
      const l = await live({ USER_MONTHLY_BUDGET_USD: '1' });
      l.provider.onRetrieve = (id) =>
        Promise.resolve({
          ...completed(
            [
              buildTextPart([
                'OUTCOME: FOUND\nX',
                { cite: { url: 'https://a.example/', title: 'A' } },
              ]),
            ],
            {
              usage: {
                inputTokens: 400_000,
                outputTokens: 3_000,
                reasoningTokens: 0,
                cachedInputTokens: 0,
                totalTokens: 403_000,
              },
              webSearchCalls: 9,
            },
          ),
          id,
          bounds: echoed(l.provider.echo),
        });
      await research(l);
      await l.research.tick();
      const [run] = await runs();
      // 400 000 x 2 + 3 000 x 8 + 9 x 10 000 = 914 000, above the 284 000 reservation.
      expect(await reservationOf(run?.id ?? '')).toMatchObject({
        status: 'SETTLED',
        estimatedMicros: 914_000n,
        uncertainMicros: 0n,
        exposureMicros: 914_000n,
      });
      expect((await ledgerOf(run?.id ?? '')).map((e) => [e.kind, e.amountMicros])).toEqual([
        ['RESERVE', 284_000n],
        ['SETTLE', 0n],
        ['OVERRUN', 630_000n],
      ]);
      await research(l, 'next');
      expect(await reasons(1)).toEqual(['USER_BUDGET_EXHAUSTED']);
      expect(submissions()).toBe(1);
    });

    it('requires an explicit, single operator resolution; research reconciliation is not financial', async () => {
      const l = await live();
      l.provider.onSubmit = () => Promise.reject(unknownOutcome());
      await research(l);
      await l.research.tick();
      const [run] = await runs();
      await reconcileUncertainRun(h.prisma, {
        runId: run?.id ?? '',
        resolution: 'OPERATOR_ACCEPTED_RISK',
        operator: 'owner',
        note: 'could not verify',
      });
      // Accepting the risk is not zero spend: the reservation stays exposed.
      expect(await reservationOf(run?.id ?? '')).toMatchObject({
        status: 'UNRESOLVED',
        exposureMicros: TEST_RESERVATION_MICROS,
      });
      const resolve = (confirmedMicros: bigint) =>
        h.prisma.$transaction((tx) =>
          resolveRun(tx, {
            runId: run?.id ?? '',
            confirmedMicros,
            operator: 'owner',
            note: 'dashboard: $0.12',
          }),
        );
      await expect(resolve(120_000n)).resolves.toMatchObject({ exposureMicros: 120_000n });
      await expect(resolve(0n)).rejects.toBeInstanceOf(AccountingResolutionError);
      expect(await reservationOf(run?.id ?? '')).toMatchObject({
        status: 'RESOLVED',
        confirmedMicros: 120_000n,
        exposureMicros: 120_000n,
      });
      expect(await ledgerSum(run?.id ?? '')).toBe(120_000n);
      expect((await ledgerOf(run?.id ?? '')).map((e) => e.kind)).toEqual([
        'RESERVE',
        'UNRESOLVED',
        'RESOLVE',
      ]);
      await expect(h.prisma.$executeRaw`UPDATE usage_ledger SET amount_micros = 0`).rejects.toThrow(
        /append-only/,
      );
    });

    it('refuses to resolve a run that has not finished', async () => {
      const l = await live();
      await research(l);
      const [run] = await runs();
      await expect(
        h.prisma.$transaction((tx) =>
          resolveRun(tx, { runId: run?.id ?? '', confirmedMicros: 1n, operator: 'o', note: 'n' }),
        ),
      ).rejects.toThrow(/NOT_RESOLVABLE_RESERVED/);
    });
  });

  describe('periods, recovery and isolation', () => {
    it('keeps ledger entries in the admission month across a month boundary', async () => {
      const clock = new FakeClock(new Date('2026-10-31T23:59:30Z'));
      const l = await live({}, { clock });
      await research(l, 'october');
      clock.advance(60_000); // 2026-11-01T00:00:30Z
      await l.research.tick();
      await research(l, 'november');
      const [october, november] = await runs();
      expect(october).toMatchObject({ admittedDay: '2026-10-31', admittedMonth: '2026-10' });
      expect(november).toMatchObject({ admittedDay: '2026-11-01', admittedMonth: '2026-11' });
      expect(new Set((await ledgerOf(october?.id ?? '')).map((e) => e.periodMonth))).toEqual(
        new Set(['2026-10']),
      );
      expect((await reservationOf(november?.id ?? '')).periodMonth).toBe('2026-11');
      await l.post(privateMessage('/usage')).expect(200);
      await drainDeliveries(l);
      const usage = l.sender.sent.at(-1)?.html ?? '';
      expect(usage).toContain('доба 2026-11-01, місяць 2026-11');
      expect(usage).toContain('зарезервовано для поточних запусків: $0.284');
      expect(usage).toContain('оцінено за звітами провайдера: $0.00');
    });

    it('executes an admitted run exactly once after a restart between commit and execution', async () => {
      const first = await live();
      await research(first);
      await first.close();
      open.splice(open.indexOf(first), 1);
      const second = await live();
      expect(await second.research.tick()).toBe(true);
      expect(await second.research.tick()).toBe(false);
      expect(second.provider.calls.submit).toBe(1);
      expect((await runs())[0]?.state).toBe('SUCCEEDED');
    });

    it('lets a stale worker neither settle nor release', async () => {
      const l = await live();
      let release: (value: ProviderSnapshot) => void = () => undefined;
      let call = 0;
      l.provider.onRetrieve = () => {
        call += 1;
        return new Promise((resolve) => (release = resolve));
      };
      await research(l);
      const stale = l.research.tick();
      await vi.waitFor(() => expect(call).toBe(1));
      await h.prisma.$executeRaw`UPDATE research_run SET lease_until = now() - interval '1 second'`;
      const newer = await live();
      newer.provider.echo = l.provider.echo; // the recovered response echoes the run's bounds
      await newer.research.tick();
      release({
        ...completed([], {
          usage: {
            inputTokens: 900_000,
            outputTokens: 1,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            totalTokens: 1,
          },
        }),
        status: 'failed',
        bounds: echoed(l.provider.echo),
      });
      await stale;
      const [run] = await runs();
      expect(run?.state).toBe('SUCCEEDED');
      expect((await ledgerOf(run?.id ?? '')).map((e) => e.kind)).toEqual(['RESERVE', 'SETTLE']);
      expect((await reservationOf(run?.id ?? '')).exposureMicros).toBe(ESTIMATED + UNCERTAIN);
    });

    it('scopes /usage and Run now to the sender and charges nothing for /result or task changes', async () => {
      const l = await live();
      await research(l);
      await l.research.tick();
      const [run] = await runs();
      await l.post(privateMessage('/usage', OTHER_ADMIN_ID)).expect(200);
      await l.post(privateMessage('/usage')).expect(200);
      await drainDeliveries(l);
      const usageOf = (id: number) =>
        l.sender.sent.filter((m) => m.chatId === BigInt(id)).at(-1)?.html ?? '';
      expect(usageOf(OTHER_ADMIN_ID)).toContain('Разом враховано: $0.00 з бюджету $10.00');
      expect(usageOf(ADMIN_ID)).toContain('оцінено за звітами провайдера: $0.0148');
      expect(usageOf(ADMIN_ID)).toContain(
        'невизначено (непідтверджені пошуки, невідомі витрати): $0.05',
      );
      expect(usageOf(ADMIN_ID)).toContain('не рахунок OpenAI');

      const othersTask = await newTask(OTHER_ADMIN_ID);
      await runNow(l, othersTask.id, 1, ADMIN_ID);
      expect(await reasons(1)).toEqual(['TASK_NOT_FOUND']);

      const ledgerBefore = await h.prisma.usageLedger.count();
      await l.post(privateMessage(`/result ${run?.id}`)).expect(200);
      await l.post(privateMessage('/new')).expect(200);
      await l.post(privateMessage('/tasks')).expect(200);
      expect(await h.prisma.usageLedger.count()).toBe(ledgerBefore);
      expect(await h.prisma.budgetReservation.count()).toBe(1);
      expect(await h.prisma.researchRun.count()).toBe(1);
      expect(submissions()).toBe(1);
    });

    it('never submits a queued live run that lacks a reservation', async () => {
      const l = await live();
      await research(l);
      const [run] = await runs();
      // Evidence removed (as for a run admitted outside this path): the reservation is gone.
      await h.prisma
        .$executeRaw`ALTER TABLE usage_ledger DISABLE TRIGGER usage_ledger_no_update_delete`;
      await h.prisma.$executeRaw`DELETE FROM usage_ledger`;
      await h.prisma
        .$executeRaw`ALTER TABLE usage_ledger ENABLE TRIGGER usage_ledger_no_update_delete`;
      await h.prisma.$executeRaw`DELETE FROM budget_reservation`;
      await l.research.tick();
      expect(
        await h.prisma.researchRun.findUniqueOrThrow({ where: { id: run?.id } }),
      ).toMatchObject({
        state: 'CANCELLED',
        failureCode: 'ACCOUNTING_MISSING',
      });
      expect(submissions()).toBe(0);
    });
  });
});
