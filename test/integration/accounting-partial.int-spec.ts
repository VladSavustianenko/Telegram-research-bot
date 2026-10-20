import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settleRun } from '../../src/accounting/ledger';
import { buildTextPart } from '../../src/research/provider/fake-fixtures';
import type { ProviderUsage } from '../../src/research/provider/provider.types';
import { ScriptedProvider, completed, echoed, snapshot } from '../support/fakes';
import { LIVE_TEST_ENV, TEST_RESERVATION_MICROS } from '../support/live-env';
import {
  ADMIN_ID,
  OTHER_ADMIN_ID,
  drainDeliveries,
  privateMessage,
  resetDatabase,
  startHarness,
  type Harness,
} from '../support/research-harness';

/**
 * TRB-050 review fix: partial usage. Synthetic prices (test/support/live-env.ts):
 * input $2/MTok, output $8/MTok, search $0.01; allowances: input $0.20,
 * output $0.024, 6 searches $0.06; reservation $0.284.
 */
const usage = (tokens: Partial<ProviderUsage>): ProviderUsage => ({
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
  totalTokens: null,
  ...tokens,
});
const INPUT_KNOWN = usage({ inputTokens: 1_000_000, cachedInputTokens: 0 }); // $2.00 known
const OUTPUT_KNOWN = usage({ outputTokens: 50_000 }); // $0.40 known

describe('TRB-050 partial usage accounting (scripted provider, real PostgreSQL)', () => {
  const open: Harness[] = [];
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
    open.push(h);
    await resetDatabase(h.prisma);
  });

  afterEach(async () => {
    for (const harness of open.splice(0)) await harness.close();
  });

  const live = async (env: Record<string, string> = {}) => {
    const harness = await startHarness(
      { ...LIVE_TEST_ENV, ...env },
      { provider: new ScriptedProvider('openai') },
    );
    open.push(harness);
    return harness;
  };
  /** Completes every poll with `reported` usage and no observed search items. */
  const completesWith = (harness: Harness, reported: ProviderUsage) => {
    harness.provider.onRetrieve = (id) =>
      Promise.resolve({
        ...completed(
          [
            buildTextPart([
              'OUTCOME: FOUND\nX',
              { cite: { url: 'https://a.example/', title: 'A' } },
            ]),
          ],
          { usage: reported, webSearchCalls: 0 },
        ),
        id,
        bounds: echoed(harness.provider.echo),
      });
  };
  const research = (harness: Harness, text: string, from = ADMIN_ID) =>
    harness.post(privateMessage(`/research ${text}`, from)).expect(200);
  const onlyRun = () => h.prisma.researchRun.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const reservationOf = (runId: string) =>
    h.prisma.budgetReservation.findFirstOrThrow({
      where: { runId },
      orderBy: { attemptNo: 'desc' },
    });
  const ledgerOf = (runId: string) =>
    h.prisma.usageLedger.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } });
  const lastReason = async () =>
    (await h.prisma.telegramUpdate.findFirst({ orderBy: { updateId: 'desc' } }))?.reason;

  async function settledWith(reported: ProviderUsage, env: Record<string, string> = {}) {
    const l = await live(env);
    completesWith(l, reported);
    await research(l, 'partial');
    await l.research.tick();
    return { l, run: await onlyRun() };
  }

  it('keeps a known input cost above the reservation when output usage is missing', async () => {
    const { run } = await settledWith(INPUT_KNOWN);
    expect(run.state).toBe('SUCCEEDED');
    // known $2.00 + output allowance $0.024 + search allowance $0.06
    expect(await reservationOf(run.id)).toMatchObject({
      status: 'UNRESOLVED',
      estimatedMicros: 2_000_000n,
      uncertainMicros: 84_000n,
      exposureMicros: 2_084_000n,
    });
    expect((await ledgerOf(run.id)).map((e) => [e.kind, e.amountMicros])).toEqual([
      ['RESERVE', TEST_RESERVATION_MICROS],
      ['UNRESOLVED', 0n],
      ['OVERRUN', 2_084_000n - TEST_RESERVATION_MICROS],
    ]);
    expect((await ledgerOf(run.id))[1]?.basis).toMatchObject({
      unknownBecause: 'USAGE_PARTIAL',
      unknownComponents: ['output'],
      knownMicros: '2000000',
      heldMicros: '84000',
    });
  });

  it('keeps a known output cost above the reservation when input usage is missing', async () => {
    const { run } = await settledWith(OUTPUT_KNOWN);
    // known $0.40 + input allowance $0.20 + search allowance $0.06
    expect(await reservationOf(run.id)).toMatchObject({
      status: 'UNRESOLVED',
      estimatedMicros: 400_000n,
      uncertainMicros: 260_000n,
      exposureMicros: 660_000n,
    });
    expect((await ledgerOf(run.id)).at(-1)).toMatchObject({
      kind: 'OVERRUN',
      amountMicros: 376_000n,
    });
  });

  it('retains at least the reservation when the known part is small', async () => {
    const { run } = await settledWith(usage({ inputTokens: 1_200 }));
    // known $0.0024; component total $0.0864 is below the reservation, which stays held.
    expect(await reservationOf(run.id)).toMatchObject({
      status: 'UNRESOLVED',
      estimatedMicros: 2_400n,
      uncertainMicros: TEST_RESERVATION_MICROS - 2_400n,
      exposureMicros: TEST_RESERVATION_MICROS,
    });
    expect((await ledgerOf(run.id)).map((e) => e.kind)).toEqual(['RESERVE', 'UNRESOLVED']);
  });

  it('keeps the increased exposure for an ambiguous outcome with partial usage', async () => {
    const l = await live();
    l.provider.onRetrieve = (id) => {
      l.clock.advance(400_000);
      return Promise.resolve(
        snapshot(l.provider.echo, { id, status: 'in_progress', usage: INPUT_KNOWN }),
      );
    };
    l.provider.onCancel = () => Promise.reject(new Error('network'));
    await research(l, 'ambiguous');
    await l.research.tick();
    const run = await onlyRun();
    expect(run).toMatchObject({ state: 'UNCERTAIN', failureCode: 'DEADLINE_CANCEL_UNCONFIRMED' });
    expect(await reservationOf(run.id)).toMatchObject({
      status: 'UNRESOLVED',
      estimatedMicros: 2_000_000n,
      exposureMicros: 2_084_000n,
    });
  });

  it('refuses the next admission when the partial overrun exhausts the user budget', async () => {
    const { l, run } = await settledWith(INPUT_KNOWN, { USER_MONTHLY_BUDGET_USD: '2.2' });
    const before = {
      runs: await h.prisma.researchRun.count(),
      reservations: await h.prisma.budgetReservation.count(),
      events: await h.prisma.outboxEvent.count(),
      submissions: l.provider.calls.submit,
    };
    // 2.084 + 0.284 > 2.2 (with the old reservation-only exposure it would have fit).
    await research(l, 'next');
    expect(await lastReason()).toBe('USER_BUDGET_EXHAUSTED');
    await l.research.tick();
    expect({
      runs: await h.prisma.researchRun.count(),
      reservations: await h.prisma.budgetReservation.count(),
      events: await h.prisma.outboxEvent.count(),
      submissions: l.provider.calls.submit,
    }).toEqual(before);
    expect((await reservationOf(run.id)).exposureMicros).toBe(2_084_000n);
  });

  it("refuses another user's admission when the partial overrun exhausts the global budget", async () => {
    const { l } = await settledWith(INPUT_KNOWN, { GLOBAL_MONTHLY_BUDGET_USD: '2.2' });
    await research(l, 'other user', OTHER_ADMIN_ID);
    expect(await lastReason()).toBe('GLOBAL_BUDGET_EXHAUSTED');
    expect(await h.prisma.researchRun.count()).toBe(1);
    expect(await h.prisma.budgetReservation.count()).toBe(1);
    expect(await h.prisma.outboxEvent.count()).toBe(1);
    expect(l.provider.calls.submit).toBe(1);
  });

  it('changes nothing when the settlement is replayed', async () => {
    const { run } = await settledWith(INPUT_KNOWN);
    const [reservation, ledger] = [await reservationOf(run.id), await ledgerOf(run.id)];
    const results = await h.prisma.$transaction(async (tx) => [
      await settleRun(tx, run.id, {
        outcome: 'unresolved',
        reason: 'REPLAY',
        usage: INPUT_KNOWN,
        returnedModel: 'test-model',
        observedSearchItems: 0,
      }),
      await settleRun(tx, run.id, {
        outcome: 'settle',
        reason: 'REPLAY',
        usage: usage({ inputTokens: 1, outputTokens: 1 }),
        returnedModel: 'test-model',
        observedSearchItems: 0,
      }),
    ]);
    expect(results).toEqual(['ALREADY_FINAL', 'ALREADY_FINAL']);
    expect(await reservationOf(run.id)).toEqual(reservation);
    expect(await ledgerOf(run.id)).toEqual(ledger);
  });

  it('shows the known part as an estimate and the rest as unresolved, without double counting', async () => {
    const { l } = await settledWith(INPUT_KNOWN);
    await l.post(privateMessage('/usage')).expect(200);
    await drainDeliveries(l);
    const text = l.sender.sent.at(-1)?.html ?? '';
    expect(text).toContain('оцінено за звітами провайдера: $2.00');
    expect(text).toContain('невизначено (непідтверджені пошуки, невідомі витрати): $0.084');
    expect(text).toContain('зарезервовано для поточних запусків: $0.00');
    expect(text).toContain('Разом враховано: $2.084 з бюджету $10.00');
  });
});
