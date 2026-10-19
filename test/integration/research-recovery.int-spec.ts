import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, type ProviderSnapshot } from '../../src/research/provider/provider.types';
import { ScriptedProvider, snapshot } from '../support/fakes';
import {
  drainDeliveries,
  privateMessage,
  resetDatabase,
  startHarness,
  type Harness,
} from '../support/research-harness';

const LIVE_ENV = {
  RESEARCH_MODE: 'live',
  OPENAI_API_KEY: 'sk-test-not-a-real-key',
  OPENAI_MODEL: 'operator-selected-model',
  OUTPUT_TOKEN_LIMIT: '3000',
  TOOL_CALL_LIMIT: '3',
  RUN_DEADLINE_SECONDS: '300',
};

describe('research recovery (real PostgreSQL)', () => {
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
    await h.post(privateMessage('/research football')).expect(200);
  });

  afterEach(async () => {
    for (const harness of open.splice(0)) await harness.close();
  });

  const run = () => h.prisma.researchRun.findFirstOrThrow();

  /** Simulates a process that died while holding the run. */
  async function crashWhileRunning(fields: string): Promise<void> {
    await h.prisma.$executeRawUnsafe(
      `UPDATE research_run SET state = 'RUNNING', fencing_token = 1, lease_owner = 'dead-worker',
              lease_until = now() - interval '1 minute', ${fields}`,
    );
  }

  it('executes queued work after an application restart', async () => {
    await h.close();
    open.splice(open.indexOf(h), 1);
    const restarted = await start();
    expect(await restarted.research.tick()).toBe(true);
    expect(await restarted.prisma.researchRun.findFirstOrThrow()).toMatchObject({
      state: 'SUCCEEDED',
    });
    h = restarted;
  });

  it('runs NOT_SUBMITTED work normally after a crash before submission', async () => {
    await crashWhileRunning(`submission_state = 'NOT_SUBMITTED'`);
    await h.research.tick();
    expect(await run()).toMatchObject({ state: 'SUCCEEDED', fencingToken: 2 });
    expect(h.provider.calls.submit).toBe(1);
  });

  it('marks a run UNCERTAIN instead of resubmitting when the crash happened during submission', async () => {
    await crashWhileRunning(`submission_state = 'SUBMITTING', submitted_at = now()`);
    await h.research.tick();
    await h.research.tick();

    expect(await run()).toMatchObject({
      state: 'UNCERTAIN',
      failureCode: 'SUBMISSION_INTERRUPTED',
    });
    expect(h.provider.calls).toEqual({ submit: 0, retrieve: 0, cancel: 0 });
    await drainDeliveries(h);
    expect(h.sender.sent.at(-1)?.html).toContain('міг бути виконаний і оплачений');
  });

  it('resumes polling a saved response ID without resubmitting', async () => {
    const polled: string[] = [];
    h.provider.onRetrieve = (id) => {
      polled.push(id);
      return new ScriptedProvider().onRetrieve(id);
    };
    await crashWhileRunning(
      `submission_state = 'SUBMITTED', provider_response_id = 'resp_saved', submitted_at = '2026-10-18T12:00:00Z'`,
    );
    await h.research.tick();

    expect(polled).toEqual(['resp_saved']);
    expect(h.provider.calls.submit).toBe(0);
    expect(await run()).toMatchObject({ state: 'SUCCEEDED', providerResponseId: 'resp_saved' });
  });

  it('marks a saved response that can no longer be retrieved as UNCERTAIN', async () => {
    h.provider.onRetrieve = () =>
      Promise.reject(new ProviderError('OPENAI_HTTP_404', 'not_accepted', true));
    await crashWhileRunning(
      `submission_state = 'SUBMITTED', provider_response_id = 'resp_gone', submitted_at = '2026-10-18T12:00:00Z'`,
    );
    await h.research.tick();
    expect(await run()).toMatchObject({
      state: 'UNCERTAIN',
      failureCode: 'RESPONSE_NOT_RETRIEVABLE',
    });
    expect(h.provider.calls.submit).toBe(0);
  });

  it('prevents a stale worker from finalizing after another worker took over', async () => {
    let acceptLate: (value: ProviderSnapshot) => void = () => undefined;
    h.provider.onSubmit = () => new Promise((resolve) => (acceptLate = resolve));
    const staleTick = h.research.tick();
    await vi.waitFor(() => expect(h.provider.calls.submit).toBe(1));

    // The first worker's lease expires (e.g. it froze); a second worker recovers the run.
    await h.prisma.$executeRaw`UPDATE research_run SET lease_until = now() - interval '1 second'`;
    const other = await start();
    await other.research.tick();
    expect(await run()).toMatchObject({
      state: 'UNCERTAIN',
      failureCode: 'SUBMISSION_INTERRUPTED',
      fencingToken: 2,
    });

    // The stale worker's provider call now returns; its fenced writes must fail.
    acceptLate(snapshot(h.provider.requests[0] ?? null, { id: 'resp_late' }));
    await staleTick;
    expect(await run()).toMatchObject({ state: 'UNCERTAIN', providerResponseId: null });
    expect(await h.prisma.delivery.count({ where: { kind: 'REPORT' } })).toBe(0);
    // Kept for operator reconciliation. Nest's static logger follows the most recently created app.
    expect([...h.logger.lines, ...other.logger.lines].join(' ')).toContain('resp_late');
    expect(other.provider.calls.submit).toBe(0);
  });

  it('never runs a run admitted for one provider with another', async () => {
    await h.close();
    open.splice(open.indexOf(h), 1);
    const live = await start(LIVE_ENV, { provider: new ScriptedProvider('openai') });
    await live.research.tick();
    expect(await live.prisma.researchRun.findFirstOrThrow()).toMatchObject({
      state: 'FAILED',
      failureCode: 'PROVIDER_CHANGED',
    });
    expect(live.provider.calls.submit).toBe(0);
    h = live;
  });

  it('freezes the admitted configuration for live runs and passes the bounds to the adapter', async () => {
    await resetDatabase(h.prisma);
    const live = await start(LIVE_ENV, { provider: new ScriptedProvider('openai') });
    await live.post(privateMessage('/research markets')).expect(200);
    await live.research.tick();
    expect(live.provider.requests).toHaveLength(1);
    expect(live.provider.requests[0]).toMatchObject({
      model: 'operator-selected-model',
      maxOutputTokens: 3000,
      maxToolCalls: 3,
    });
    expect(await live.prisma.researchRun.findFirstOrThrow()).toMatchObject({
      providerKind: 'openai',
      state: 'SUCCEEDED',
    });
    await drainDeliveries(live);
    expect(live.sender.sent.some((s) => s.html.includes('СИМУЛЯЦІЯ'))).toBe(false);
  });
});
