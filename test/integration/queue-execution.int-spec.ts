import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { RESEARCH_QUEUE } from '../../src/queue/queue.service';
import {
  ProviderError,
  type ProviderSnapshot,
  type ProviderUsage,
} from '../../src/research/provider/provider.types';
import { buildTextPart } from '../../src/research/provider/fake-fixtures';
import { wakeRun } from '../../src/research/wake';
import { taskCallbackData } from '../../src/telegram/callback-data';
import { ScriptedProvider, completed, echoed, snapshot, unknownOutcome } from '../support/fakes';
import { httpServer } from '../support/http';
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

const MEMBER_ID = 3003;

/** A manually resolved gate for scripted provider calls (deterministic overlap). */
function gate<T>() {
  let open: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

const rateLimited = (retryAfterMs: number | null = 5_000) =>
  new ProviderError('OPENAI_HTTP_429_rate_limit_exceeded', 'not_accepted', false, retryAfterMs);

const finished = (harness: Harness, id: string, usage?: ProviderUsage): ProviderSnapshot => ({
  ...completed(
    [
      buildTextPart([
        'OUTCOME: FOUND\nClaim.',
        { cite: { url: 'https://a.example/', title: 'A' } },
      ]),
    ],
    usage ? { usage, webSearchCalls: 0 } : {},
  ),
  id,
  bounds: echoed(harness.provider.echo),
});

/** Several runs complete in one test: each submission gets its own response ID. */
function distinctResponses(...harnesses: Harness[]): void {
  for (const harness of harnesses) {
    harness.provider.onSubmit = (request) =>
      Promise.resolve(snapshot(request, { id: `resp_${request.runId}` }));
  }
}

describe('TRB-060 queue execution (real pg-boss, scripted provider, real PostgreSQL)', () => {
  const open: Harness[] = [];
  let h: Harness;

  const start = async (...args: Parameters<typeof startHarness>) => {
    const harness = await startHarness(...args);
    open.push(harness);
    return harness;
  };
  const live = (env: Record<string, string> = {}) =>
    start({ ...LIVE_TEST_ENV, ...env }, { provider: new ScriptedProvider('openai') });
  const close = async (harness: Harness) => {
    open.splice(open.indexOf(harness), 1);
    await harness.close();
  };

  beforeEach(async () => {
    h = await start();
    await resetDatabase(h.prisma);
  });

  afterEach(async () => {
    for (const harness of open.splice(0)) await harness.close();
  });

  const research = (harness: Harness, text = 'topic', from = ADMIN_ID) =>
    harness.post(privateMessage(`/research ${text}`, from)).expect(200);
  const runs = () => h.prisma.researchRun.findMany({ orderBy: { createdAt: 'asc' } });
  const onlyRun = () => h.prisma.researchRun.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const jobs = () =>
    h.prisma.$queryRawUnsafe<{ id: string; state: string; runId: string }[]>(
      `SELECT id::text, state::text, data->>'runId' AS "runId" FROM pgboss.job
        WHERE name = '${RESEARCH_QUEUE}' ORDER BY created_on, id`,
    );
  const events = () => h.prisma.outboxEvent.findMany({ orderBy: { createdAt: 'asc' } });
  const pending = () =>
    h.prisma.outboxEvent.findMany({ where: { dispatchedAt: null, cancelledAt: null } });
  const reservations = (runId: string) =>
    h.prisma.budgetReservation.findMany({ where: { runId }, orderBy: { attemptNo: 'asc' } });
  const ledger = async (runId: string) =>
    (
      await h.prisma.usageLedger.findMany({
        where: { runId },
        orderBy: [{ reservation: { attemptNo: 'asc' } }, { createdAt: 'asc' }],
        include: { reservation: { select: { attemptNo: true } } },
      })
    ).map((entry) => [entry.reservation.attemptNo, entry.kind]);
  const attempts = (runId: string) =>
    h.prisma.researchAttempt.findMany({ where: { runId }, orderBy: { attemptNo: 'asc' } });
  const reports = (runId: string) => h.prisma.delivery.count({ where: { runId, kind: 'REPORT' } });
  const submissions = () => open.reduce((n, harness) => n + harness.provider.calls.submit, 0);
  /** Nest's logger is process-wide, so any harness may have captured a line. */
  const logged = (text: string) =>
    open.some((harness) => harness.logger.lines.some((line) => line.includes(text)));
  /** Simulates a worker that died while holding the run (its lease is in the past). */
  const expireLease = () =>
    h.prisma
      .$executeRaw`UPDATE research_run SET lease_until = now() - interval '1 second' WHERE state = 'RUNNING'`;
  /** Makes deferred wake-ups and retry delays due now (instead of waiting in real time). */
  const makeDue = async () => {
    await h.prisma
      .$executeRaw`UPDATE research_run SET next_attempt_at = now() WHERE next_attempt_at IS NOT NULL`;
    await h.prisma
      .$executeRaw`UPDATE outbox_event SET available_at = now() WHERE dispatched_at IS NULL AND cancelled_at IS NULL`;
  };
  const newTask = async () =>
    h.prisma.task.create({
      data: {
        userId: (
          await h.prisma.appUser.findUniqueOrThrow({
            where: { telegramUserId: BigInt(ADMIN_ID) },
          })
        ).id,
        name: 'Task',
        prompt: 'Task prompt',
        scheduleKind: 'DAILY',
        localTime: '09:00',
        timeZone: 'Europe/Kyiv',
      },
    });

  describe('transactional outbox → pg-boss', () => {
    it('publishes an event committed before a crash once, after the restart', async () => {
      await research(h);
      expect(await pending()).toHaveLength(1);
      expect(await jobs()).toHaveLength(0);

      // The process dies before the dispatcher ran.
      await close(h);
      const restarted = await start();
      h = restarted;
      expect(await restarted.research.tick()).toBe(true);

      const [event] = await events();
      expect(await jobs()).toEqual([{ id: event?.id, state: 'completed', runId: event?.runId }]);
      expect(event?.dispatchedAt).toBeInstanceOf(Date);
      expect(await onlyRun()).toMatchObject({ state: 'SUCCEEDED' });
      expect(submissions()).toBe(1);
    });

    it('rolls the job back with an interrupted acknowledgement and republishes it once', async () => {
      await research(h);
      const [event] = await events();
      const data = { runId: event?.runId ?? '', eventId: event?.id ?? '' };
      // Publication succeeded, then the dispatcher crashed before its commit.
      await expect(
        h.prisma.$transaction(async (tx) => {
          expect(await h.queue.publish(tx, data)).toBe(data.eventId);
          throw new Error('crash before acknowledgement');
        }),
      ).rejects.toThrow('crash before acknowledgement');
      expect(await jobs()).toHaveLength(0);
      expect(await pending()).toHaveLength(1);

      expect(await h.dispatcher.dispatchDue()).toBe(1);
      expect(await jobs()).toEqual([{ id: data.eventId, state: 'created', runId: data.runId }]);
      // Even a repeated publication of the same event (at-least-once) adds no job.
      expect(await h.prisma.$transaction((tx) => h.queue.publish(tx, data))).toBeNull();
      expect(await jobs()).toHaveLength(1);
      expect(await h.research.tick()).toBe(true);
      expect(submissions()).toBe(1);
    });

    it('lets concurrent dispatchers publish every event exactly once', async () => {
      const second = await start();
      for (const topic of ['a', 'b', 'c']) await research(h, topic);
      const [first] = await events();

      // A third session holds the first event, as a dispatcher in mid-publication would.
      const blocker = new Client({ connectionString: inject('databaseUrl') });
      await blocker.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM outbox_event WHERE id = $1 FOR UPDATE', [first?.id]);
        const counts = await Promise.all([
          h.dispatcher.dispatchDue(),
          second.dispatcher.dispatchDue(),
        ]);
        expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
        expect(await pending()).toEqual([expect.objectContaining({ id: first?.id })]);
        await blocker.query('COMMIT');
      } finally {
        await blocker.end();
      }
      await Promise.all([h.dispatcher.dispatchDue(), second.dispatcher.dispatchDue()]);

      const published = await jobs();
      expect(published.map((job) => job.id).sort()).toEqual(
        (await events()).map((event) => event.id).sort(),
      );
      expect(await pending()).toHaveLength(0);
    });

    it('never publishes cancelled or finished work', async () => {
      const task = await newTask();
      await h.post(callbackQuery(taskCallbackData(task.id, 1, 'r'))).expect(200);
      await h.post(callbackQuery(taskCallbackData(task.id, 1, 'p'))).expect(200);
      expect(await onlyRun()).toMatchObject({ state: 'CANCELLED', failureCode: 'TASK_PAUSED' });
      expect(await h.dispatcher.dispatchDue()).toBe(0);
      expect(await jobs()).toHaveLength(0);

      // A wake-up of a run that is already finished is cancelled, not published.
      const run = await onlyRun();
      await wakeRun(h.prisma, run.id, 'TEST');
      expect(await h.dispatcher.dispatchDue()).toBe(1);
      expect(await jobs()).toHaveLength(0);
      expect(await pending()).toHaveLength(0);
      expect(submissions()).toBe(0);
    });
  });

  describe('duplicate job delivery', () => {
    it('does nothing for duplicates before, during and after execution', async () => {
      const l = await live();
      const other = await live();
      await research(l);
      const run = await onlyRun();
      // Two jobs for the same run before anything executed.
      await l.dispatcher.dispatchDue();
      await wakeRun(h.prisma, run.id, 'DUPLICATE');
      await l.dispatcher.dispatchDue();
      expect(await jobs()).toHaveLength(2);

      const polled = gate<void>();
      const answered = gate<void>();
      l.provider.onRetrieve = async (id) => {
        polled.open();
        await answered.promise;
        return finished(l, id);
      };
      const executing = l.research.tick();
      await polled.promise;
      // During execution: the duplicate finds a live lease.
      expect(await other.research.tick()).toBe(false);
      expect(submissions()).toBe(1);
      answered.open();
      expect(await executing).toBe(true);

      // After completion: another job for the finished run.
      await l.prisma.$transaction((tx) =>
        l.queue.publish(tx, { runId: run.id, eventId: randomUUID() }),
      );
      expect(await other.research.tick()).toBe(false);
      expect(await onlyRun()).toMatchObject({ state: 'SUCCEEDED', fencingToken: 1 });
      expect(submissions()).toBe(1);
      expect(await reports(run.id)).toBe(1);
      expect(await ledger(run.id)).toEqual([
        [1, 'RESERVE'],
        [1, 'SETTLE'],
      ]);
      expect((await jobs()).map((job) => job.state)).toEqual([
        'completed',
        'completed',
        'completed',
      ]);
    });
  });

  describe('crash recovery and fencing', () => {
    it('executes a run whose worker died before the submission intent, once', async () => {
      const l = await live();
      await research(l);
      await l.dispatcher.dispatchDue();
      // The dead worker had fetched the job and claimed the run, then vanished.
      expect(await l.queue.fetchOne()).not.toBeNull();
      await h.prisma.$executeRaw`
        UPDATE research_run SET state = 'RUNNING', fencing_token = 1, lease_owner = 'dead-worker',
                                lease_until = now() - interval '1 minute'`;

      const next = await live();
      expect(await next.research.tick()).toBe(true);
      const run = await onlyRun();
      expect(run).toMatchObject({ state: 'SUCCEEDED', fencingToken: 2 });
      expect(submissions()).toBe(1);
      expect(await attempts(run.id)).toEqual([
        expect.objectContaining({ attemptNo: 1, outcome: 'PROVIDER_TERMINAL', fencingToken: 2 }),
      ]);
      expect((await reservations(run.id)).map((r) => r.status)).toEqual(['SETTLED']);
    });

    it('marks an interrupted submission UNCERTAIN, keeps its exposure and never resubmits', async () => {
      const l = await live({ RESEARCH_SUBMISSION_RETRY_LIMIT: '2' });
      await research(l);
      const accepted = gate<ProviderSnapshot>();
      l.provider.onSubmit = () => accepted.promise;
      const frozen = l.research.tick();
      await vi.waitFor(() => expect(l.provider.calls.submit).toBe(1));

      // The worker froze inside the provider call; its lease expired.
      await expireLease();
      const next = await live({ RESEARCH_SUBMISSION_RETRY_LIMIT: '2' });
      expect(await next.research.tick()).toBe(true);
      const run = await onlyRun();
      expect(run).toMatchObject({
        state: 'UNCERTAIN',
        failureCode: 'SUBMISSION_INTERRUPTED',
        providerResponseId: null,
      });
      expect(await attempts(run.id)).toEqual([
        expect.objectContaining({
          attemptNo: 1,
          submissionState: 'SUBMITTING',
          outcome: 'UNCERTAIN',
        }),
      ]);
      expect(await reservations(run.id)).toEqual([
        expect.objectContaining({ status: 'UNRESOLVED', exposureMicros: TEST_RESERVATION_MICROS }),
      ]);

      // The frozen request was accepted after all: the stale worker cannot record it.
      accepted.open(snapshot(l.provider.echo, { id: 'resp_late' }));
      expect(await frozen).toBe(true);
      expect(await onlyRun()).toMatchObject({ state: 'UNCERTAIN', providerResponseId: null });
      expect(logged('resp_late')).toBe(true);

      // No automatic resubmission, and live work stays blocked.
      expect(await next.research.tick()).toBe(false);
      await research(next, 'blocked');
      expect(await h.prisma.researchRun.count()).toBe(1);
      expect(submissions()).toBe(1);
    });

    it('hands a saved response over on shutdown and resumes it after restart', async () => {
      const l = await live();
      await research(l);
      l.provider.onRetrieve = (id) =>
        Promise.resolve(snapshot(l.provider.echo, { id, status: 'in_progress' }));
      const shutdown = new AbortController();
      const executing = l.research.tick(shutdown.signal);
      await vi.waitFor(() => expect(l.provider.calls.retrieve).toBeGreaterThan(0));
      shutdown.abort();
      expect(await executing).toBe(true);

      const handedOver = await onlyRun();
      expect(handedOver).toMatchObject({ state: 'RUNNING', submissionState: 'SUBMITTED' });
      expect(handedOver.leaseUntil?.getTime()).toBeLessThanOrEqual(Date.now());
      expect((await pending()).map((event) => event.payload)).toEqual([
        { runId: handedOver.id, reason: 'SHUTDOWN_HANDOVER' },
      ]);
      await close(l);

      const restarted = await live();
      const polled: string[] = [];
      restarted.provider.onRetrieve = (id) => {
        polled.push(id);
        return Promise.resolve(finished(restarted, id));
      };
      restarted.provider.echo = { maxOutputTokens: 3000, maxToolCalls: 3 };
      expect(await restarted.research.tick()).toBe(true);
      expect(polled).toEqual([handedOver.providerResponseId]);
      expect(restarted.provider.calls.submit).toBe(0);
      const run = await onlyRun();
      expect(run.state).toBe('SUCCEEDED');
      expect(await attempts(run.id)).toEqual([
        expect.objectContaining({
          attemptNo: 1,
          providerResponseId: handedOver.providerResponseId,
          outcome: 'PROVIDER_TERMINAL',
        }),
      ]);
      expect(await ledger(run.id)).toEqual([
        [1, 'RESERVE'],
        [1, 'SETTLE'],
      ]);
    });

    it('lets no stale worker finalize, settle or deliver after a takeover', async () => {
      const l = await live();
      await research(l);
      const stalePoll = gate<void>();
      const staleAnswer = gate<void>();
      l.provider.onRetrieve = async (id) => {
        stalePoll.open();
        await staleAnswer.promise;
        return finished(l, id);
      };
      const stale = l.research.tick();
      await stalePoll.promise;

      await expireLease();
      const next = await live();
      next.provider.echo = { maxOutputTokens: 3000, maxToolCalls: 3 };
      next.provider.onRetrieve = (id) => Promise.resolve(finished(next, id));
      expect(await next.research.tick()).toBe(true);
      const run = await onlyRun();
      expect(run).toMatchObject({ state: 'SUCCEEDED', fencingToken: 2 });

      staleAnswer.open();
      expect(await stale).toBe(true);
      expect(await onlyRun()).toMatchObject({ state: 'SUCCEEDED', fencingToken: 2 });
      expect(await reports(run.id)).toBe(1);
      expect(await ledger(run.id)).toEqual([
        [1, 'RESERVE'],
        [1, 'SETTLE'],
      ]);
      expect(submissions()).toBe(1);
      expect(logged('lease lost')).toBe(true);
    });

    it('does not resubmit when pg-boss redelivers an expired job during provider work', async () => {
      const l = await live();
      await research(l);
      const polled = gate<void>();
      const answered = gate<void>();
      l.provider.onRetrieve = async (id) => {
        polled.open();
        await answered.promise;
        return finished(l, id);
      };
      const executing = l.research.tick();
      await polled.promise;

      // The job outlived its expiry while the provider request was still running.
      await h.prisma.$executeRawUnsafe(
        `UPDATE pgboss.job SET started_on = now() - interval '1 day' WHERE state = 'active'`,
      );
      await l.queue.supervise();
      expect((await jobs()).map((job) => job.state)).toEqual(['retry']);
      await h.prisma.$executeRawUnsafe(`UPDATE pgboss.job SET start_after = now()`);

      const other = await live();
      expect(await other.research.tick()).toBe(false);
      expect(submissions()).toBe(1);

      answered.open();
      expect(await executing).toBe(true);
      const run = await onlyRun();
      expect(run.state).toBe('SUCCEEDED');
      expect(await reports(run.id)).toBe(1);
      expect(submissions()).toBe(1);
    });
  });

  describe('bounded retries and accounting', () => {
    it.each([
      ['a connection failure', unknownOutcome('OPENAI_CONNECTION')],
      ['a timeout', unknownOutcome('OPENAI_ABORTED')],
      ['a server error', new ProviderError('OPENAI_HTTP_500', 'unknown')],
    ])('never resubmits after %s, even with retries enabled', async (_name, error) => {
      const l = await live({ RESEARCH_SUBMISSION_RETRY_LIMIT: '2' });
      await research(l);
      l.provider.onSubmit = () => Promise.reject(error);
      await l.research.tick();
      await makeDue();
      await l.research.tick();
      const run = await onlyRun();
      expect(run).toMatchObject({ state: 'UNCERTAIN', currentAttemptNo: 1 });
      expect((await reservations(run.id)).map((r) => r.status)).toEqual(['UNRESOLVED']);
      expect(submissions()).toBe(1);
    });

    it('fails a rate-limited submission without resubmitting by default', async () => {
      const l = await live();
      await research(l);
      l.provider.onSubmit = () => Promise.reject(rateLimited());
      await l.research.tick();
      const run = await onlyRun();
      expect(run).toMatchObject({
        state: 'FAILED',
        failureCode: 'OPENAI_HTTP_429_rate_limit_exceeded',
      });
      expect(await attempts(run.id)).toEqual([
        expect.objectContaining({ attemptNo: 1, outcome: 'NOT_ACCEPTED' }),
      ]);
      expect((await reservations(run.id)).map((r) => r.status)).toEqual(['RELEASED']);
      expect(submissions()).toBe(1);
    });

    it('resubmits a rate-limited request once, after the delay, with its own reservation', async () => {
      const l = await live({ RESEARCH_SUBMISSION_RETRY_LIMIT: '1' });
      await research(l);
      l.provider.onSubmit = () => Promise.reject(rateLimited(5_000));
      expect(await l.research.tick()).toBe(true);

      let run = await onlyRun();
      expect(run).toMatchObject({
        state: 'QUEUED',
        currentAttemptNo: 2,
        submissionState: 'NOT_SUBMITTED',
      });
      const delay = (run.nextAttemptAt?.getTime() ?? 0) - Date.now();
      expect(delay).toBeGreaterThan(3_000);
      expect(delay).toBeLessThanOrEqual(5_000);
      expect((await reservations(run.id)).map((r) => [r.attemptNo, r.status])).toEqual([
        [1, 'RELEASED'],
        [2, 'RESERVED'],
      ]);
      // Not due yet: even an early job claims nothing; it re-defers to the retry time.
      expect(await l.research.tick()).toBe(false);
      await wakeRun(h.prisma, run.id, 'EARLY');
      expect(await l.research.tick()).toBe(false);
      expect(submissions()).toBe(1);
      expect((await pending())[0]?.availableAt).toEqual(run.nextAttemptAt);

      l.provider.onSubmit = (request) => Promise.resolve(snapshot(request));
      await makeDue();
      expect(await l.research.tick()).toBe(true);
      run = await onlyRun();
      expect(run).toMatchObject({ state: 'SUCCEEDED', currentAttemptNo: 2 });
      expect(submissions()).toBe(2);
      expect(l.provider.requests[0]).toEqual(l.provider.requests[1]);
      expect((await attempts(run.id)).map((a) => [a.attemptNo, a.outcome])).toEqual([
        [1, 'NOT_ACCEPTED'],
        [2, 'PROVIDER_TERMINAL'],
      ]);
      expect(await ledger(run.id)).toEqual([
        [1, 'RESERVE'],
        [1, 'RELEASE'],
        [2, 'RESERVE'],
        [2, 'SETTLE'],
      ]);
      // One run against the daily quota, however many attempts.
      expect(await h.prisma.researchRun.count()).toBe(1);
    });

    it('stops after the retry limit and accounts for every attempt', async () => {
      const l = await live({ RESEARCH_SUBMISSION_RETRY_LIMIT: '1' });
      await research(l);
      l.provider.onSubmit = () => Promise.reject(rateLimited(null));
      await l.research.tick();
      expect((await onlyRun()).nextAttemptAt).toBeInstanceOf(Date);
      await makeDue();
      await l.research.tick();
      await makeDue();
      expect(await l.research.tick()).toBe(false);

      const run = await onlyRun();
      expect(run).toMatchObject({ state: 'FAILED', currentAttemptNo: 2 });
      expect(submissions()).toBe(2);
      expect((await reservations(run.id)).map((r) => [r.status, r.exposureMicros])).toEqual([
        ['RELEASED', 0n],
        ['RELEASED', 0n],
      ]);
      expect((await attempts(run.id)).map((a) => a.outcome)).toEqual([
        'NOT_ACCEPTED',
        'NOT_ACCEPTED',
      ]);
    });

    it('refuses an additional attempt that the budget no longer allows', async () => {
      // Both admissions fit (2 x $0.284 <= $0.6); the first run then overruns.
      const l = await live({
        RESEARCH_SUBMISSION_RETRY_LIMIT: '1',
        GLOBAL_MONTHLY_BUDGET_USD: '0.6',
      });
      await research(l, 'expensive', OTHER_ADMIN_ID);
      await research(l, 'retried', ADMIN_ID);
      const [expensive, retried] = await runs();
      l.provider.onRetrieve = (id) =>
        Promise.resolve(
          finished(l, id, {
            inputTokens: 1_000_000,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            totalTokens: 1_000_000,
          }),
        );
      expect(await l.research.tick()).toBe(true);
      expect((await reservations(expensive?.id ?? ''))[0]?.exposureMicros).toBe(2_060_000n);

      l.provider.onSubmit = () => Promise.reject(rateLimited());
      expect(await l.research.tick()).toBe(true);
      const run = await h.prisma.researchRun.findUniqueOrThrow({ where: { id: retried?.id } });
      expect(run).toMatchObject({
        state: 'FAILED',
        failureCode: 'OPENAI_HTTP_429_rate_limit_exceeded;RETRY_REFUSED:GLOBAL_BUDGET_EXHAUSTED',
        currentAttemptNo: 1,
      });
      expect((await reservations(run.id)).map((r) => r.status)).toEqual(['RELEASED']);
      expect(submissions()).toBe(2);
    });

    it('releases the reservation of a run cancelled while it waits for a retry', async () => {
      const l = await live({ RESEARCH_SUBMISSION_RETRY_LIMIT: '1' });
      const task = await newTask();
      await l.post(callbackQuery(taskCallbackData(task.id, 1, 'r'))).expect(200);
      l.provider.onSubmit = () => Promise.reject(rateLimited());
      await l.research.tick();
      expect(await onlyRun()).toMatchObject({ state: 'QUEUED', currentAttemptNo: 2 });

      await l.post(callbackQuery(taskCallbackData(task.id, 1, 'p'))).expect(200);
      await makeDue();
      expect(await l.research.tick()).toBe(false);
      const run = await onlyRun();
      expect(run).toMatchObject({ state: 'CANCELLED', failureCode: 'TASK_PAUSED' });
      expect(await ledger(run.id)).toEqual([
        [1, 'RESERVE'],
        [1, 'RELEASE'],
        [2, 'RESERVE'],
        [2, 'RELEASE'],
      ]);
      expect(submissions()).toBe(1);
    });
  });

  describe('lifecycle changes while a job waits in the queue', () => {
    it.each(['p', 'd'] as const)(
      'task action %s cancels published work before submission',
      async (op) => {
        const l = await live();
        const task = await newTask();
        await l.post(callbackQuery(taskCallbackData(task.id, 1, 'r'))).expect(200);
        await l.dispatcher.dispatchDue();
        expect(await jobs()).toHaveLength(1);

        await l.post(callbackQuery(taskCallbackData(task.id, 1, op))).expect(200);
        if (op === 'd') await l.post(callbackQuery(taskCallbackData(task.id, 1, 'dy'))).expect(200);
        expect(await l.research.tick()).toBe(false);

        const run = await onlyRun();
        expect(run).toMatchObject({
          state: 'CANCELLED',
          failureCode: op === 'p' ? 'TASK_PAUSED' : 'TASK_DELETED',
          submissionState: 'NOT_SUBMITTED',
        });
        expect(await ledger(run.id)).toEqual([
          [1, 'RESERVE'],
          [1, 'RELEASE'],
        ]);
        expect((await jobs()).map((job) => job.state)).toEqual(['completed']);
        expect(submissions()).toBe(0);
      },
    );

    it('cancels published work of a user suspended before it started', async () => {
      await h.prisma.$executeRaw`
        INSERT INTO app_user (id, telegram_user_id, private_chat_id, role, onboarding_state, time_zone,
                              invited_at, onboarded_at, updated_at)
        VALUES (gen_random_uuid(), ${MEMBER_ID}, ${MEMBER_ID}, 'MEMBER', 'COMPLETED', 'Europe/Kyiv',
                now(), now(), now())`;
      await research(h, 'member work', MEMBER_ID);
      await h.dispatcher.dispatchDue();
      await h.post(privateMessage(`/admin suspend ${MEMBER_ID}`, ADMIN_ID)).expect(200);
      expect(await h.research.tick()).toBe(false);
      expect(await onlyRun()).toMatchObject({ state: 'CANCELLED', failureCode: 'USER_SUSPENDED' });
      expect(submissions()).toBe(0);
    });
  });

  describe('fair dispatch and capacity', () => {
    it('serves two users fairly under single global capacity', async () => {
      const fair = await start({ RESEARCH_QUEUE_LIMIT: '10' });
      distinctResponses(fair);
      for (const topic of ['a1', 'a2', 'a3']) await research(fair, topic, ADMIN_ID);
      await research(fair, 'b1', OTHER_ADMIN_ID);
      const owner = new Map((await runs()).map((run) => [run.id, run.prompt]));

      for (let i = 0; i < 4; i += 1) expect(await fair.research.tick()).toBe(true);
      expect(fair.provider.requests.map((r) => owner.get(r.runId))).toEqual([
        'a1',
        'b1',
        'a2',
        'a3',
      ]);
      expect(await fair.research.tick()).toBe(false);
    });

    it('defers a capacity-denied run durably and wakes it when capacity frees', async () => {
      const second = await start();
      distinctResponses(h, second);
      await research(h, 'first', ADMIN_ID);
      await research(h, 'second', OTHER_ADMIN_ID);
      const [first, waiting] = await runs();
      const polled = gate<void>();
      const answered = gate<void>();
      h.provider.onRetrieve = async (id) => {
        polled.open();
        await answered.promise;
        return finished(h, id);
      };
      const executing = h.research.tick();
      await polled.promise;

      expect(await second.research.tick()).toBe(false);
      const [deferred] = await pending();
      expect(deferred).toMatchObject({ runId: waiting?.id, type: 'RESEARCH_WAKE' });
      expect((deferred?.availableAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(10_000);
      // No tight loop: nothing is ready until the deferral is due.
      expect(await second.research.tick()).toBe(false);
      expect(await jobs()).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ state: 'created' })]),
      );

      answered.open();
      expect(await executing).toBe(true);
      // Completion woke the waiting run at once (the earlier time wins).
      expect((await pending())[0]?.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(await second.research.tick()).toBe(true);
      expect(await runs()).toEqual([
        expect.objectContaining({ id: first?.id, state: 'SUCCEEDED' }),
        expect.objectContaining({ id: waiting?.id, state: 'SUCCEEDED' }),
      ]);
    });

    it('lets simulated work progress while live work is blocked by an unresolved run', async () => {
      distinctResponses(h);
      await research(h, 'one');
      await research(h, 'two');
      expect(await h.research.tick()).toBe(true);
      // The first run is turned into an unreconciled live UNCERTAIN run.
      const [blocking] = await runs();
      await h.prisma.$executeRaw`
        UPDATE research_run SET state = 'UNCERTAIN', provider_kind = 'openai', failure_code = 'SUBMISSION_INTERRUPTED' WHERE id = ${blocking?.id}::uuid`;
      expect(await h.research.tick()).toBe(true);
      expect((await runs())[1]?.state).toBe('SUCCEEDED');
    });
  });

  describe('background workers, shutdown and readiness', () => {
    const BACKGROUND = {
      BACKGROUND_WORKERS: 'on',
      WORKER_POLL_INTERVAL_MS: '50',
      OPENAI_POLL_INTERVAL_MS: '20',
    };

    it('runs work through pg-boss and hands unfinished work over on shutdown', async () => {
      const first = await start(BACKGROUND);
      first.provider.onRetrieve = (id) =>
        Promise.resolve(snapshot(first.provider.echo, { id, status: 'in_progress' }));
      await research(first);
      await vi.waitFor(() => expect(first.provider.calls.retrieve).toBeGreaterThan(1), {
        timeout: 15_000,
      });

      const stopping = Date.now();
      await close(first);
      expect(Date.now() - stopping).toBeLessThan(15_000);
      const handedOver = await onlyRun();
      expect(handedOver).toMatchObject({ state: 'RUNNING', submissionState: 'SUBMITTED' });
      expect(handedOver.leaseUntil?.getTime()).toBeLessThanOrEqual(Date.now());

      const second = await start(BACKGROUND);
      second.provider.onRetrieve = (id) => Promise.resolve(finished(second, id));
      await vi.waitFor(async () => expect((await onlyRun()).state).toBe('SUCCEEDED'), {
        timeout: 15_000,
      });
      expect(first.provider.calls.submit + second.provider.calls.submit).toBe(1);
      expect(second.provider.calls.retrieve).toBeGreaterThan(0);
      expect(await reports(handedOver.id)).toBe(1);
    }, 60_000);

    it('reports the started queue in readiness without external calls', async () => {
      await request(httpServer(h.app))
        .get('/health/ready')
        .expect(200, {
          status: 'ok',
          checks: {
            config: 'up',
            database: 'up',
            queue: 'up',
            schema: 'up',
            workers: 'disabled',
            execution: 'open',
          },
        });
      expect(h.provider.calls).toEqual({ submit: 0, retrieve: 0, cancel: 0 });
      expect(h.sender.attempts).toHaveLength(0);
    });
  });

  it('leaves no work behind after a full drain', async () => {
    await research(h);
    expect(await h.research.tick()).toBe(true);
    await drainDeliveries(h);
    expect(await pending()).toHaveLength(0);
    expect((await jobs()).every((job) => job.state === 'completed')).toBe(true);
  });
});
