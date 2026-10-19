import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSnapshot } from '../../src/research/provider/provider.types';
import {
  ReconciliationError,
  reconcileUncertainRun,
  type Resolution,
} from '../../src/research/reconciliation';
import {
  FAKE_MODE_BOUNDS,
  ScriptedProvider,
  UNCONFIRMED_BOUNDS,
  completed,
  echoed,
  snapshot,
  unknownOutcome,
} from '../support/fakes';
import {
  drainDeliveries,
  privateMessage,
  resetDatabase,
  startHarness,
  type Harness,
} from '../support/research-harness';
import { buildTextPart } from '../../src/research/provider/fake-fixtures';

const LIVE_ENV = {
  RESEARCH_MODE: 'live',
  OPENAI_API_KEY: 'sk-test-not-a-real-key',
  OPENAI_MODEL: 'operator-selected-model',
  OUTPUT_TOKEN_LIMIT: '3000',
  TOOL_CALL_LIMIT: '3',
  RUN_DEADLINE_SECONDS: '300',
};

const USAGE_POLL = {
  inputTokens: 900,
  outputTokens: 10,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  totalTokens: 910,
};
const USAGE_CANCEL = {
  inputTokens: 1500,
  outputTokens: 70,
  reasoningTokens: 20,
  cachedInputTokens: 0,
  totalTokens: 1570,
};
const ALL_BOUNDS_PROBLEMS = 'max_output_tokens,max_tool_calls,tool_choice,web_search_tool';
const networkFailure = () => Promise.reject(unknownOutcome('OPENAI_CONNECTION'));
const report = () =>
  completed([
    buildTextPart(['OUTCOME: FOUND\nClaim.', { cite: { url: 'https://a.example/', title: 'A' } }]),
  ]);

describe('bounds verification, cancellation outcomes and fail-closed uncertainty', () => {
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

  const runs = () => h.prisma.researchRun.findMany({ orderBy: { createdAt: 'asc' } });
  const reportDeliveries = () => h.prisma.delivery.count({ where: { kind: 'REPORT' } });

  /**
   * A worker saved the response ID (SUBMITTED, immutable request with the given
   * bounds) and died before verifying the provider's echoed bounds.
   */
  async function crashedAfterSavingResponseId(bounds = FAKE_MODE_BOUNDS): Promise<void> {
    await h.post(privateMessage('/research recovered')).expect(200);
    const request = JSON.stringify({ request: bounds });
    await h.prisma.$executeRawUnsafe(
      `UPDATE research_run SET state = 'RUNNING', fencing_token = 1, lease_owner = 'dead-worker',
              lease_until = now() - interval '1 minute', submission_state = 'SUBMITTED',
              provider_response_id = 'resp_saved', submitted_at = '2026-10-18T12:00:00Z',
              request_snapshot = request_snapshot || '${request}'::jsonb`,
    );
  }

  describe('Finding 1: recovered responses are verified like fresh ones', () => {
    it.each(['queued', 'in_progress'] as const)(
      'cancels a recovered %s response with unconfirmed bounds and never reports it',
      async (status) => {
        await crashedAfterSavingResponseId();
        h.provider.onRetrieve = (id) =>
          Promise.resolve(snapshot(null, { id, status, bounds: UNCONFIRMED_BOUNDS }));
        await h.research.tick();

        expect((await runs())[0]).toMatchObject({
          state: 'FAILED',
          failureCode: `BOUNDS_NOT_CONFIRMED:${ALL_BOUNDS_PROBLEMS}`,
          providerResponseId: 'resp_saved',
          providerStatus: 'cancelled',
        });
        expect(h.provider.calls).toEqual({ submit: 0, retrieve: 1, cancel: 1 });
        expect(await reportDeliveries()).toBe(0);
      },
    );

    it.each([
      ['missing', UNCONFIRMED_BOUNDS, ALL_BOUNDS_PROBLEMS],
      ['mismatched', echoed({ maxOutputTokens: 9000, maxToolCalls: 3 }), 'max_output_tokens'],
    ])(
      'discards a recovered completed response with %s bounds',
      async (_case, bounds, problems) => {
        await crashedAfterSavingResponseId();
        h.provider.onRetrieve = () => Promise.resolve({ ...report(), bounds });
        await h.research.tick();

        expect((await runs())[0]).toMatchObject({
          state: 'FAILED',
          failureCode: `BOUNDS_NOT_CONFIRMED:${problems}`,
          reportText: null,
          providerStatus: 'completed',
        });
        expect((await runs())[0]?.usage).toMatchObject({ outputTokens: 300 });
        expect(h.provider.calls).toEqual({ submit: 0, retrieve: 1, cancel: 0 });
        expect(await reportDeliveries()).toBe(0);
      },
    );

    it('completes a recovered response with confirmed bounds without a second submission', async () => {
      await crashedAfterSavingResponseId();
      await h.research.tick();
      expect((await runs())[0]).toMatchObject({ state: 'SUCCEEDED', outcome: 'FOUND' });
      expect(h.provider.calls).toEqual({ submit: 0, retrieve: 1, cancel: 0 });
      expect(await reportDeliveries()).toBe(1);
    });

    it('verifies against the run snapshot, not the current configuration', async () => {
      await crashedAfterSavingResponseId({ maxOutputTokens: 2000, maxToolCalls: 3 });
      const changed = await start({ OUTPUT_TOKEN_LIMIT: '5000', TOOL_CALL_LIMIT: '9' });
      // A provider echoing the *current* settings does not match the run's request.
      changed.provider.onRetrieve = () =>
        Promise.resolve({
          ...report(),
          bounds: echoed({ maxOutputTokens: 5000, maxToolCalls: 9 }),
        });
      await changed.research.tick();
      expect((await runs())[0]).toMatchObject({
        state: 'FAILED',
        failureCode: 'BOUNDS_NOT_CONFIRMED:max_output_tokens,max_tool_calls',
      });

      await resetDatabase(h.prisma);
      await crashedAfterSavingResponseId({ maxOutputTokens: 2000, maxToolCalls: 3 });
      changed.provider.onRetrieve = () =>
        Promise.resolve({
          ...report(),
          bounds: echoed({ maxOutputTokens: 2000, maxToolCalls: 3 }),
        });
      await changed.research.tick();
      expect((await runs())[0]?.state).toBe('SUCCEEDED');
    });

    it('treats a missing request snapshot as unverifiable', async () => {
      await h.post(privateMessage('/research legacy')).expect(200);
      await h.prisma.$executeRawUnsafe(
        `UPDATE research_run SET state = 'RUNNING', fencing_token = 1, lease_until = now() - interval '1 minute',
                submission_state = 'SUBMITTED', provider_response_id = 'resp_old', submitted_at = '2026-10-18T12:00:00Z'`,
      );
      h.provider.onRetrieve = () => Promise.resolve(report());
      await h.research.tick();
      expect((await runs())[0]).toMatchObject({
        state: 'FAILED',
        failureCode: 'BOUNDS_NOT_CONFIRMED:request_snapshot',
      });
    });
  });

  describe('Finding 2: cancellation outcomes', () => {
    /** Fresh run whose polls stay in progress until the 120 s fake deadline passes. */
    async function runIntoDeadline(): Promise<void> {
      h.provider.onRetrieve = (id) => {
        h.clock.advance(61_000);
        return Promise.resolve(snapshot(null, { id, status: 'in_progress', usage: USAGE_POLL }));
      };
      await h.post(privateMessage('/research slow')).expect(200);
      await h.research.tick();
    }

    it('keeps the run UNCERTAIN when deadline cancellation fails on the network', async () => {
      h.provider.onCancel = networkFailure;
      await runIntoDeadline();
      const [run] = await runs();
      expect(run).toMatchObject({
        state: 'UNCERTAIN',
        failureCode: 'DEADLINE_CANCEL_UNCONFIRMED',
        providerResponseId: 'resp_test_1',
        providerStatus: 'in_progress',
      });
      expect(run?.usage).toEqual(USAGE_POLL);
      await drainDeliveries(h);
      expect(h.sender.sent.at(-1)?.html).toContain('DEADLINE_CANCEL_UNCONFIRMED');
    });

    it.each(['queued', 'in_progress'] as const)(
      'keeps the run UNCERTAIN when cancellation only returns %s',
      async (status) => {
        h.provider.onCancel = (id) => Promise.resolve(snapshot(null, { id, status }));
        await runIntoDeadline();
        expect((await runs())[0]).toMatchObject({
          state: 'UNCERTAIN',
          failureCode: 'DEADLINE_CANCEL_UNCONFIRMED',
          providerStatus: status,
        });
      },
    );

    it('keeps the run UNCERTAIN when bounds-failure cancellation fails', async () => {
      h.provider.onSubmit = () =>
        Promise.resolve(snapshot(null, { status: 'queued', bounds: UNCONFIRMED_BOUNDS }));
      h.provider.onCancel = networkFailure;
      await h.post(privateMessage('/research x')).expect(200);
      await h.research.tick();
      expect((await runs())[0]).toMatchObject({
        state: 'UNCERTAIN',
        failureCode: `BOUNDS_NOT_CONFIRMED:${ALL_BOUNDS_PROBLEMS};CANCEL_UNCONFIRMED`,
        providerResponseId: 'resp_test_1',
      });
      expect(h.provider.calls).toMatchObject({ submit: 1, retrieve: 0, cancel: 1 });
    });

    it('records the usage returned by a confirmed cancellation', async () => {
      h.provider.onCancel = (id) =>
        Promise.resolve(snapshot(null, { id, status: 'cancelled', usage: USAGE_CANCEL }));
      await runIntoDeadline();
      const [run] = await runs();
      expect(run).toMatchObject({
        state: 'FAILED',
        failureCode: 'DEADLINE_EXCEEDED',
        providerStatus: 'cancelled',
      });
      expect(run?.usage).toEqual(USAGE_CANCEL);
    });

    it('keeps earlier usage when the cancellation response has none', async () => {
      await runIntoDeadline(); // default cancel: cancelled, no usage
      const [run] = await runs();
      expect(run).toMatchObject({ state: 'FAILED', failureCode: 'DEADLINE_EXCEEDED' });
      expect(run?.usage).toEqual(USAGE_POLL);
    });

    it.each([
      ['confirmed bounds', echoed(FAKE_MODE_BOUNDS), 'SUCCEEDED', null, 1],
      [
        'unconfirmed bounds',
        UNCONFIRMED_BOUNDS,
        'FAILED',
        `BOUNDS_NOT_CONFIRMED:${ALL_BOUNDS_PROBLEMS}`,
        0,
      ],
    ])(
      'accepts a completed cancellation response only with %s',
      async (_case, bounds, state, failureCode, reports) => {
        h.provider.onCancel = () => Promise.resolve({ ...report(), bounds });
        await runIntoDeadline();
        expect((await runs())[0]).toMatchObject({ state, failureCode });
        expect(await reportDeliveries()).toBe(reports);
      },
    );
  });

  describe('fail-closed live uncertainty', () => {
    const becomeUncertain = {
      'unknown submission outcome': async (live: Harness) => {
        live.provider.onSubmit = () => Promise.reject(unknownOutcome());
        await live.research.tick();
      },
      'interrupted submission without a response ID': async (live: Harness) => {
        await live.prisma.$executeRawUnsafe(
          `UPDATE research_run SET state = 'RUNNING', fencing_token = 1, lease_until = now() - interval '1 minute',
                  submission_state = 'SUBMITTING', submitted_at = now()
            WHERE id = (SELECT id FROM research_run ORDER BY created_at LIMIT 1)`,
        );
        await live.research.tick();
      },
    };

    it.each(Object.keys(becomeUncertain) as (keyof typeof becomeUncertain)[])(
      'blocks new and queued live work after %s until reconciliation',
      async (cause) => {
        const live = await start(LIVE_ENV, { provider: new ScriptedProvider('openai') });
        const second = await start(LIVE_ENV, { provider: new ScriptedProvider('openai') });
        await live.post(privateMessage('/research first')).expect(200);
        await live.post(privateMessage('/research second')).expect(200);
        await becomeUncertain[cause](live);
        live.provider.onSubmit = (request) => Promise.resolve(snapshot(request));
        const [first, queued] = await runs();
        expect(first).toMatchObject({ state: 'UNCERTAIN', reconciledAt: null });

        // Queued live work stays queued; no worker submits it.
        expect(await Promise.all([live.research.tick(), second.research.tick()])).toEqual([
          false,
          false,
        ]);
        expect(queued?.state).toBe('QUEUED');
        expect((await runs())[1]?.state).toBe('QUEUED');
        const submitsBefore = live.provider.calls.submit + second.provider.calls.submit;

        // New live work is refused, without creating a run.
        await live.post(privateMessage('/research third')).expect(200);
        expect(await live.prisma.researchRun.count()).toBe(2);
        await drainDeliveries(live);
        expect(live.sender.sent.at(-1)?.html).toContain('Live-дослідження тимчасово заблоковано');
        expect(live.sender.sent.some((s) => s.html.includes('оплачений'))).toBe(true);

        // Operator reconciliation lifts the block; the uncertain run is not resubmitted.
        await reconcileUncertainRun(live.prisma, {
          runId: first?.id ?? '',
          operator: 'owner',
          resolution: 'PROVIDER_CONFIRMED_TERMINAL',
          note: 'Checked the OpenAI dashboard: no running response.',
        });
        expect(await live.research.tick()).toBe(true);
        const after = await runs();
        expect(after[0]).toMatchObject({
          state: 'UNCERTAIN',
          failureCode: first?.failureCode,
        });
        expect(after[0]?.reconciledAt).toBeInstanceOf(Date);
        expect(after[1]?.state).toBe('SUCCEEDED');
        expect(live.provider.calls.submit + second.provider.calls.submit).toBe(submitsBefore + 1);
        expect(live.provider.requests.at(-1)?.runId).toBe(queued?.id);
      },
    );

    it('does not let simulated uncertainty block work or claim real cost', async () => {
      await h.post(privateMessage('/research first')).expect(200);
      await h.post(privateMessage('/research second')).expect(200);
      h.provider.onSubmit = () => Promise.reject(unknownOutcome());
      await h.research.tick();
      h.provider.onSubmit = (request) => Promise.resolve(snapshot(request));
      expect(await h.research.tick()).toBe(true);
      expect((await runs()).map((run) => run.state)).toEqual(['UNCERTAIN', 'SUCCEEDED']);
      await drainDeliveries(h);
      const uncertainNotice = h.sender.sent.find((s) => s.html.includes('невизначений'));
      expect(uncertainNotice?.html).toContain('СИМУЛЯЦІЯ');
      expect(uncertainNotice?.html).not.toContain('оплачений');
    });
  });

  describe('operator reconciliation', () => {
    async function uncertainRun(): Promise<string> {
      h.provider.onSubmit = () =>
        Promise.resolve(snapshot(null, { status: 'queued', bounds: UNCONFIRMED_BOUNDS }));
      h.provider.onCancel = networkFailure;
      await h.post(privateMessage('/research x')).expect(200);
      await h.research.tick();
      return (await runs())[0]?.id ?? '';
    }
    const input = (runId: string, resolution: Resolution = 'OPERATOR_ACCEPTED_RISK') => ({
      runId,
      operator: 'owner',
      resolution,
      note: 'Could not verify; accepting possible cost.',
    });

    it('appends an audit record and keeps all uncertainty evidence', async () => {
      const runId = await uncertainRun();
      const before = await h.prisma.researchRun.findUniqueOrThrow({ where: { id: runId } });
      const { reconciliationId } = await reconcileUncertainRun(h.prisma, input(runId));

      const after = await h.prisma.researchRun.findUniqueOrThrow({ where: { id: runId } });
      expect(after).toMatchObject({
        state: 'UNCERTAIN',
        failureCode: before.failureCode,
        providerResponseId: 'resp_test_1',
        submissionState: 'SUBMITTED',
      });
      expect(after.reconciledAt).toBeInstanceOf(Date);
      const audit = await h.prisma.researchReconciliation.findUniqueOrThrow({
        where: { id: reconciliationId },
      });
      expect(audit).toMatchObject({
        runId,
        operator: 'owner',
        resolution: 'OPERATOR_ACCEPTED_RISK',
      });
      expect(audit.evidence).toMatchObject({
        failureCode: before.failureCode,
        providerResponseId: 'resp_test_1',
        submissionState: 'SUBMITTED',
      });
      await expect(
        h.prisma.$executeRaw`UPDATE research_reconciliation SET note = 'edited'`,
      ).rejects.toThrow();
      await expect(h.prisma.$executeRaw`DELETE FROM research_reconciliation`).rejects.toThrow();
      expect(h.provider.calls.submit).toBe(1);
    });

    it('refuses runs that are not unreconciled UNCERTAIN runs, and bad input', async () => {
      const runId = await uncertainRun();
      await reconcileUncertainRun(h.prisma, input(runId));
      const refusal = (promise: Promise<unknown>) =>
        promise.then(
          () => 'accepted',
          (error: unknown) => (error instanceof ReconciliationError ? error.code : 'other'),
        );
      expect(await refusal(reconcileUncertainRun(h.prisma, input(runId)))).toBe(
        'ALREADY_RECONCILED',
      );

      await h.post(privateMessage('/research queued')).expect(200);
      const queued = (await runs())[1]?.id ?? '';
      expect(await refusal(reconcileUncertainRun(h.prisma, input(queued)))).toBe(
        'RUN_NOT_UNCERTAIN:QUEUED',
      );
      expect(
        await refusal(
          reconcileUncertainRun(h.prisma, input('11111111-2222-4333-8444-555555555555')),
        ),
      ).toBe('RUN_NOT_FOUND');
      expect(await refusal(reconcileUncertainRun(h.prisma, { ...input(queued), note: ' ' }))).toBe(
        'INVALID_NOTE',
      );
      expect(
        await refusal(
          reconcileUncertainRun(h.prisma, { ...input(queued), resolution: 'DONE' as Resolution }),
        ),
      ).toBe('INVALID_RESOLUTION');
    });
  });

  describe('stale workers', () => {
    it('cannot finalize after a newer worker completed the run', async () => {
      let releaseCancel: (value: ProviderSnapshot) => void = () => undefined;
      h.provider.onRetrieve = (id) => {
        h.clock.advance(200_000);
        return Promise.resolve(snapshot(null, { id, status: 'in_progress' }));
      };
      h.provider.onCancel = () => new Promise((resolve) => (releaseCancel = resolve));
      await h.post(privateMessage('/research x')).expect(200);
      const staleTick = h.research.tick();
      await vi.waitFor(() => expect(h.provider.calls.cancel).toBe(1));

      await h.prisma.$executeRaw`UPDATE research_run SET lease_until = now() - interval '1 second'`;
      const newer = await start();
      await newer.research.tick(); // resumes polling and completes
      expect((await runs())[0]?.state).toBe('SUCCEEDED');

      releaseCancel(snapshot(null, { status: 'cancelled', usage: USAGE_CANCEL }));
      await staleTick;
      expect((await runs())[0]).toMatchObject({ state: 'SUCCEEDED', failureCode: null });
      expect(await reportDeliveries()).toBe(1);
    });

    it('cannot overwrite a run that a newer worker made UNCERTAIN and the operator reconciled', async () => {
      let acceptLate: (value: ProviderSnapshot) => void = () => undefined;
      h.provider.onSubmit = () => new Promise((resolve) => (acceptLate = resolve));
      await h.post(privateMessage('/research x')).expect(200);
      const staleTick = h.research.tick();
      await vi.waitFor(() => expect(h.provider.calls.submit).toBe(1));

      await h.prisma.$executeRaw`UPDATE research_run SET lease_until = now() - interval '1 second'`;
      const newer = await start();
      await newer.research.tick();
      const [run] = await runs();
      await reconcileUncertainRun(h.prisma, {
        runId: run?.id ?? '',
        operator: 'owner',
        resolution: 'PROVIDER_REQUEST_ABSENT',
        note: 'No request visible in the dashboard.',
      });

      acceptLate(snapshot(h.provider.requests[0] ?? null, { id: 'resp_late' }));
      await staleTick;
      expect((await runs())[0]).toMatchObject({
        state: 'UNCERTAIN',
        failureCode: 'SUBMISSION_INTERRUPTED',
        providerResponseId: null,
      });
      expect((await runs())[0]?.reconciledAt).toBeInstanceOf(Date);
    });
  });
});
