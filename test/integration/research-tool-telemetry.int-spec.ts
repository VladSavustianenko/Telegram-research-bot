import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ObservedToolItem,
  ProviderSnapshot,
} from '../../src/research/provider/provider.types';
import { buildTextPart } from '../../src/research/provider/fake-fixtures';
import { summarizeToolTelemetry } from '../../src/research/tool-telemetry';
import { completed, notAccepted, snapshot } from '../support/fakes';
import {
  privateMessage,
  resetDatabase,
  startHarness,
  type Harness,
} from '../support/research-harness';

const item = (
  itemId: string | null,
  status: string | null,
  actionType: string | null,
  position = 0,
): ObservedToolItem => ({ itemId, position, type: 'web_search_call', status, actionType });

const inProgress = (toolItems: ObservedToolItem[]): ProviderSnapshot =>
  snapshot(null, { status: 'in_progress', toolItems, webSearchCalls: toolItems.length });

const done = (toolItems: ObservedToolItem[]): ProviderSnapshot =>
  completed(
    [
      buildTextPart([
        'OUTCOME: FOUND\nClaim.',
        { cite: { url: 'https://a.example/', title: 'A' } },
      ]),
    ],
    { toolItems, webSearchCalls: toolItems.length },
  );

describe('diagnostic tool telemetry (fake provider, real PostgreSQL)', () => {
  const open: Harness[] = [];
  const start = async () => {
    const harness = await startHarness();
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

  const items = () =>
    h.prisma.researchToolItem.findMany({
      orderBy: { itemKey: 'asc' },
      select: {
        itemKey: true,
        status: true,
        actionType: true,
        observations: true,
        itemIdReported: true,
      },
    });
  const onlyRun = () => h.prisma.researchRun.findFirstOrThrow();

  /** Scripts successive poll results. */
  function polls(...snapshots: ProviderSnapshot[]): void {
    let index = 0;
    h.provider.onRetrieve = () =>
      Promise.resolve(snapshots[Math.min(index++, snapshots.length - 1)] as ProviderSnapshot);
  }

  it('counts an item once across polls and keeps its latest status and action', async () => {
    polls(
      inProgress([item('ws_1', 'in_progress', null)]),
      inProgress([
        item('ws_1', 'searching', 'search'),
        item('ws_2', 'in_progress', 'open_page', 1),
      ]),
      done([
        item('ws_1', 'completed', 'search'),
        item('ws_2', 'completed', 'open_page', 1),
        item('ws_3', 'failed', 'find_in_page', 2),
        item('ws_4', 'incomplete', 'search', 3),
      ]),
    );
    await h.post(privateMessage('/research telemetry')).expect(200);
    await h.research.tick();

    expect(await items()).toEqual([
      {
        itemKey: 'ws_1',
        status: 'completed',
        actionType: 'search',
        observations: 3,
        itemIdReported: true,
      },
      {
        itemKey: 'ws_2',
        status: 'completed',
        actionType: 'open_page',
        observations: 2,
        itemIdReported: true,
      },
      {
        itemKey: 'ws_3',
        status: 'failed',
        actionType: 'find_in_page',
        observations: 1,
        itemIdReported: true,
      },
      {
        itemKey: 'ws_4',
        status: 'incomplete',
        actionType: 'search',
        observations: 1,
        itemIdReported: true,
      },
    ]);
    const run = await onlyRun();
    expect(run).toMatchObject({ state: 'SUCCEEDED', toolCallCount: 4, toolTelemetryVersion: 1 });
    expect(await summarizeToolTelemetry(h.prisma, run.id)).toMatchObject({
      telemetry: 'recorded',
      webSearchCallOutputItemsFinalSnapshot: 4,
      observedToolItems: 4,
      observedItemsByStatus: { completed: 2, failed: 1, incomplete: 1 },
      observedItemsByAction: { search: 2, open_page: 1, find_in_page: 1 },
      observedItemsByStatusAndAction: [
        { status: 'completed', actionType: 'open_page', items: 1 },
        { status: 'completed', actionType: 'search', items: 1 },
        { status: 'failed', actionType: 'find_in_page', items: 1 },
        { status: 'incomplete', actionType: 'search', items: 1 },
      ],
      itemsWithoutProviderId: 0,
      billableSearchCount: null,
    });
  });

  it('keeps items a later snapshot omits and never replaces reported values with missing ones', async () => {
    polls(
      inProgress([item('ws_1', 'completed', 'search'), item(null, null, null, 1)]),
      done([item('ws_1', null, null), item('ws_2', 'brand_new_status', 'brand_new_action', 1)]),
    );
    await h.post(privateMessage('/research telemetry')).expect(200);
    await h.research.tick();

    expect(await items()).toEqual([
      {
        itemKey: 'missing-id:1',
        status: null,
        actionType: null,
        observations: 1,
        itemIdReported: false,
      },
      {
        itemKey: 'ws_1',
        status: 'completed',
        actionType: 'search',
        observations: 2,
        itemIdReported: true,
      },
      {
        itemKey: 'ws_2',
        status: 'brand_new_status',
        actionType: 'brand_new_action',
        observations: 1,
        itemIdReported: true,
      },
    ]);
    expect(await summarizeToolTelemetry(h.prisma, (await onlyRun()).id)).toMatchObject({
      observedToolItems: 3,
      observedItemsByStatus: { completed: 1, brand_new_status: 1, unreported: 1 },
      observedItemsByAction: { search: 1, brand_new_action: 1, unreported: 1 },
      itemsWithoutProviderId: 1,
    });
  });

  it('survives a worker restart and rejects a stale worker’s late observation', async () => {
    let releaseStale: (value: ProviderSnapshot) => void = () => undefined;
    let call = 0;
    h.provider.onRetrieve = () => {
      call += 1;
      return call === 1
        ? Promise.resolve(inProgress([item('ws_1', 'searching', 'search')]))
        : new Promise((resolve) => (releaseStale = resolve));
    };
    await h.post(privateMessage('/research telemetry')).expect(200);
    const staleTick = h.research.tick();
    await vi.waitFor(() => expect(call).toBe(2));

    // The first worker stalls; its lease expires and a new process takes over.
    await h.prisma.$executeRaw`UPDATE research_run SET lease_until = now() - interval '1 second'`;
    const newer = await start();
    newer.provider.onRetrieve = () =>
      Promise.resolve(done([item('ws_2', 'completed', 'open_page', 1)]));
    await newer.research.tick();

    releaseStale(done([item('ws_9', 'completed', 'search')]));
    await staleTick;

    expect(await items()).toEqual([
      {
        itemKey: 'ws_1',
        status: 'searching',
        actionType: 'search',
        observations: 1,
        itemIdReported: true,
      },
      {
        itemKey: 'ws_2',
        status: 'completed',
        actionType: 'open_page',
        observations: 1,
        itemIdReported: true,
      },
    ]);
    expect((await onlyRun()).state).toBe('SUCCEEDED');
  });

  it('persists telemetry during incomplete execution, including the cancellation snapshot', async () => {
    h.provider.onRetrieve = (id) => {
      h.clock.advance(61_000);
      return Promise.resolve({ ...inProgress([item('ws_1', 'searching', 'search')]), id });
    };
    h.provider.onCancel = (id) =>
      Promise.resolve(
        snapshot(null, {
          id,
          status: 'in_progress',
          toolItems: [item('ws_2', 'in_progress', 'open_page', 1)],
        }),
      );
    await h.post(privateMessage('/research telemetry')).expect(200);
    await h.research.tick();

    expect(await onlyRun()).toMatchObject({
      state: 'UNCERTAIN',
      failureCode: 'DEADLINE_CANCEL_UNCONFIRMED',
    });
    expect((await items()).map((row) => [row.itemKey, row.status])).toEqual([
      ['ws_1', 'searching'],
      ['ws_2', 'in_progress'],
    ]);
  });

  it('distinguishes runs without telemetry from runs with zero observed items', async () => {
    // A run recorded before telemetry existed: per-item facts are unknown, not zero.
    await h.prisma.$executeRawUnsafe(
      `INSERT INTO research_run (id, requested_by_telegram_user_id, chat_id, source_update_id, state, prompt,
              provider_kind, request_snapshot, submission_state, provider_response_id, outcome, report_text,
              tool_call_count, updated_at)
       VALUES ('0241a554-0000-4000-8000-000000000001', 1, 1, 999001, 'SUCCEEDED', 'p', 'openai', '{}',
               'SUBMITTED', 'resp_legacy', 'FOUND', 'r', 4, now())`,
    );
    const legacy = await summarizeToolTelemetry(h.prisma, '0241a554-0000-4000-8000-000000000001');
    expect(legacy?.billableSearchCountNote).toContain('billing evidence');
    expect({ ...legacy, billableSearchCountNote: undefined }).toEqual({
      runId: '0241a554-0000-4000-8000-000000000001',
      telemetry: 'not_recorded',
      webSearchCallOutputItemsFinalSnapshot: 4,
      observedToolItems: null,
      observedItemsByStatus: null,
      observedItemsByAction: null,
      observedItemsByStatusAndAction: null,
      itemsWithoutProviderId: null,
      billableSearchCount: null,
      billableSearchCountNote: undefined,
    });

    // A run whose submission was rejected: telemetry recorded, nothing observed.
    h.provider.onSubmit = () => Promise.reject(notAccepted());
    await h.post(privateMessage('/research rejected')).expect(200);
    await h.research.tick();
    const rejected = await h.prisma.researchRun.findFirstOrThrow({ where: { state: 'FAILED' } });
    expect(await summarizeToolTelemetry(h.prisma, rejected.id)).toMatchObject({
      telemetry: 'recorded',
      observedToolItems: 0,
      observedItemsByStatus: {},
    });
  });
});
