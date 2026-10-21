import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountingResolutionError, resolveRun } from '../../src/accounting/ledger';
import { createDelivery } from '../../src/delivery/delivery-records';
import { clearHold, setHold } from '../../src/operations/hold';
import {
  QuarantineError,
  applyQuarantine,
  listCandidates,
  previewQuarantine,
} from '../../src/operations/restore-quarantine';
import type { ProviderSnapshot } from '../../src/research/provider/provider.types';
import { ReconciliationError, reconcileUncertainRun } from '../../src/research/reconciliation';
import { snapshot } from '../support/fakes';
import { LIVE_TEST_ENV, TEST_RESERVATION_MICROS } from '../support/live-env';
import {
  ADMIN_ID,
  privateMessage,
  resetDatabase,
  startHarness,
  type Harness,
} from '../support/research-harness';

// TRB-100 review fix: reconciling a restored database while the operational
// hold keeps every process idle (docs/OPERATIONS.md, section 11.3). The
// database state stands for a restored backup; the scripted provider and the
// recording sender stand for work that happened after the backup.

const BACKGROUND = { ...LIVE_TEST_ENV, BACKGROUND_WORKERS: 'on', WORKER_POLL_INTERVAL_MS: '50' };
const decision = { operator: 'owner', reason: 'restored backup of 2026-10-21' };

describe('TRB-100 restore quarantine', () => {
  const open: Harness[] = [];
  let h: Harness;

  const start = async (env: Record<string, string>) => {
    const harness = await startHarness(env);
    open.push(harness);
    return harness;
  };
  const run = (id: string) =>
    h.prisma.researchRun.findUniqueOrThrow({ where: { id }, include: { attempts: true } });
  const reservation = (runId: string) =>
    h.prisma.budgetReservation.findFirstOrThrow({ where: { runId } });
  const ledger = (runId: string) =>
    h.prisma.usageLedger.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } });
  const audits = () =>
    h.prisma.auditEvent.findMany({
      where: { kind: { in: ['RESTORE_RUN_QUARANTINED', 'RESTORE_DELIVERY_SUPPRESSED'] } },
    });
  const hold = () => setHold(h.prisma, { reason: 'restored', setBy: 'owner' });
  /** Clears the hold and starts a normal instance with every worker (the reopening). */
  const reopen = async () => {
    await clearHold(h.prisma);
    const live = await start(BACKGROUND);
    expect(live.gate.state).toBe('open');
    return live;
  };

  beforeEach(async () => {
    h = await start(LIVE_TEST_ENV);
    await resetDatabase(h.prisma);
  });
  afterEach(async () => {
    await clearHold(h.prisma); // never leave a hold behind for later suites
    for (const harness of open.splice(0).reverse()) await harness.close();
  });

  it('neutralizes a queued administrator /research that may have run after the backup', async () => {
    await h.post(privateMessage('/research queued in the backup')).expect(200);
    const queued = await h.prisma.researchRun.findFirstOrThrow();
    expect(queued).toMatchObject({
      state: 'QUEUED',
      submissionState: 'NOT_SUBMITTED',
      taskId: null,
    });
    await hold();

    // The existing tools cannot do it: the run is unfinished, its reservation RESERVED.
    await expect(
      h.prisma.$transaction((tx) =>
        resolveRun(tx, { runId: queued.id, confirmedMicros: 0n, operator: 'o', note: 'n' }),
      ),
    ).rejects.toBeInstanceOf(AccountingResolutionError);
    await expect(
      reconcileUncertainRun(h.prisma, {
        runId: queued.id,
        resolution: 'OPERATOR_ACCEPTED_RISK',
        operator: 'o',
        note: 'n',
      }),
    ).rejects.toBeInstanceOf(ReconciliationError);

    expect((await listCandidates(h.prisma)).runs.map((r) => r['id'])).toEqual([queued.id]);
    const preview = await previewQuarantine(h.prisma, [{ kind: 'run', id: queued.id }]);
    expect(preview[0]).toMatchObject({ action: 'QUARANTINE' });
    expect((await run(queued.id)).state).toBe('QUEUED'); // preview changes nothing

    const [applied] = await applyQuarantine(h.prisma, {
      targets: [{ kind: 'run', id: queued.id }],
      ...decision,
    });
    expect(applied).toMatchObject({ action: 'QUARANTINE', accounting: 'UNRESOLVED' });
    expect(await run(queued.id)).toMatchObject({
      state: 'UNCERTAIN',
      failureCode: 'RESTORE_QUARANTINED',
      reconciledAt: null,
      attempts: [], // no attempt invented for a submission never recorded
    });
    // Not released: the request may exist. Full reservation stays exposed.
    expect(await reservation(queued.id)).toMatchObject({
      status: 'UNRESOLVED',
      exposureMicros: TEST_RESERVATION_MICROS,
    });
    expect((await ledger(queued.id)).map((e) => e.kind)).toEqual(['RESERVE', 'UNRESOLVED']);
    expect(
      await h.prisma.outboxEvent.count({
        where: { runId: queued.id, dispatchedAt: null, cancelledAt: null },
      }),
    ).toBe(0);
    expect(await audits()).toHaveLength(1);

    // Repeating the confirmed command is harmless.
    const [again] = await applyQuarantine(h.prisma, {
      targets: [{ kind: 'run', id: queued.id }],
      ...decision,
    });
    expect(again?.action).toBe('ALREADY_QUARANTINED');
    expect(await audits()).toHaveLength(1);
    expect(await ledger(queued.id)).toHaveLength(2);

    // Reopened: the run is never submitted, even by a stale job for it.
    const live = await reopen();
    await live.research.handle(queued.id);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(live.provider.calls.submit).toBe(0);

    // From here the existing reconciliation applies: provider finding, then cost.
    await reconcileUncertainRun(h.prisma, {
      runId: queued.id,
      resolution: 'PROVIDER_REQUEST_ABSENT',
      operator: 'owner',
      note: 'no request in the OpenAI logs after the backup',
    });
    await h.prisma.$transaction((tx) =>
      resolveRun(tx, {
        runId: queued.id,
        confirmedMicros: 0n,
        operator: 'owner',
        note: 'confirmed: no usage for the period',
      }),
    );
    expect(await reservation(queued.id)).toMatchObject({ status: 'RESOLVED', exposureMicros: 0n });
  }, 30_000);

  it('a restored RUNNING request with a known response ID is never polled or resubmitted', async () => {
    h.provider.onSubmit = (request) => Promise.resolve(snapshot(request, { id: 'resp_after' }));
    h.provider.onRetrieve = (id) =>
      Promise.resolve(snapshot(h.provider.echo, { id, status: 'in_progress' }));
    await h.post(privateMessage('/research running in the backup')).expect(200);
    const stop = new AbortController();
    const ticking = h.research.tick(stop.signal);
    await vi.waitFor(() => expect(h.provider.calls.retrieve).toBeGreaterThan(0));
    stop.abort();
    await ticking;
    const restored = await h.prisma.researchRun.findFirstOrThrow();
    expect(restored).toMatchObject({ state: 'RUNNING', submissionState: 'SUBMITTED' });
    await hold();

    const [result] = await applyQuarantine(h.prisma, {
      targets: [{ kind: 'run', id: restored.id }],
      ...decision,
    });
    expect(result?.accounting).toBe('UNRESOLVED');
    const after = await run(restored.id);
    expect(after).toMatchObject({
      state: 'UNCERTAIN',
      failureCode: 'RESTORE_QUARANTINED',
      submissionState: 'SUBMITTED',
      providerResponseId: 'resp_after',
    });
    expect(after.attempts).toMatchObject([
      {
        providerResponseId: 'resp_after',
        outcome: 'UNCERTAIN',
        failureCode: 'RESTORE_QUARANTINED',
      },
    ]);
    expect(await reservation(restored.id)).toMatchObject({
      status: 'UNRESOLVED',
      exposureMicros: TEST_RESERVATION_MICROS,
    });

    const live = await reopen();
    await live.research.handle(restored.id); // a stale job
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(live.provider.calls).toEqual({ submit: 0, retrieve: 0, cancel: 0 });
  }, 30_000);

  it('a restored RUNNING submission without a response ID stays exposed until resolved', async () => {
    h.provider.onSubmit = () => new Promise<ProviderSnapshot>(() => undefined); // outcome unknown
    await h.post(privateMessage('/research submitting in the backup')).expect(200);
    void h.research.tick();
    await vi.waitFor(async () =>
      expect(await h.prisma.researchRun.count({ where: { submissionState: 'SUBMITTING' } })).toBe(
        1,
      ),
    );
    const restored = await h.prisma.researchRun.findFirstOrThrow();
    await hold();
    const targets = [{ kind: 'run' as const, id: restored.id }];

    // A live lease means a process may still be executing: refused, nothing changed.
    await expect(applyQuarantine(h.prisma, { targets, ...decision })).rejects.toMatchObject({
      code: 'NOT_QUIESCED',
    });
    expect((await run(restored.id)).state).toBe('RUNNING');
    // The process is gone and its lease expired.
    await h.prisma.$executeRaw`UPDATE research_run SET lease_until = now() - interval '1 second'
                                WHERE id = ${restored.id}::uuid`;

    await applyQuarantine(h.prisma, { targets, ...decision });
    const after = await run(restored.id);
    expect(after).toMatchObject({
      state: 'UNCERTAIN',
      submissionState: 'SUBMITTING',
      providerResponseId: null,
    });
    expect(after.attempts).toMatchObject([{ outcome: 'UNCERTAIN', providerResponseId: null }]);

    const live = await reopen();
    await live.research.handle(restored.id);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(live.provider.calls.submit).toBe(0);
    // Still exposed after reopening, until the operator resolves it explicitly.
    expect(await reservation(restored.id)).toMatchObject({
      status: 'UNRESOLVED',
      exposureMicros: TEST_RESERVATION_MICROS,
    });
    await h.prisma.$transaction((tx) =>
      resolveRun(tx, {
        runId: restored.id,
        confirmedMicros: 150_000n,
        operator: 'owner',
        note: 'dashboard: one request after the backup',
      }),
    );
    expect(await reservation(restored.id)).toMatchObject({
      status: 'RESOLVED',
      exposureMicros: 150_000n,
    });
  }, 30_000);

  it('suppresses restored deliveries without resending or relabelling, and unblocks the chat', async () => {
    const chat = BigInt(ADMIN_ID);
    // A two-part delivery: part 0 confirmed before the backup, part 1 waiting.
    const partial = await h.prisma.$transaction((tx) =>
      createDelivery(tx, { kind: 'STATUS', chatId: chat, parts: ['part one', 'part two'] }),
    );
    await h.prisma.$executeRaw`
      UPDATE delivery_part SET state = 'SENT', telegram_message_id = 777
       WHERE delivery_id = ${partial}::uuid AND ordinal = 0`;
    const pending = await h.prisma.$transaction((tx) =>
      createDelivery(tx, { kind: 'STATUS', chatId: chat, parts: ['delivered after the backup'] }),
    );
    const before = await h.prisma.deliveryPart.findMany({
      where: { deliveryId: partial },
      orderBy: { ordinal: 'asc' },
    });
    await hold();

    const plan = await previewQuarantine(h.prisma, [
      { kind: 'delivery', id: partial },
      { kind: 'delivery', id: pending },
    ]);
    expect(plan.map((item) => item.action)).toEqual(['QUARANTINE', 'QUARANTINE']);
    await applyQuarantine(h.prisma, {
      targets: [
        { kind: 'delivery', id: partial },
        { kind: 'delivery', id: pending },
      ],
      ...decision,
    });
    const after = await h.prisma.deliveryPart.findMany({
      where: { deliveryId: partial },
      orderBy: { ordinal: 'asc' },
    });
    expect(after.map((p) => [p.state, p.telegramMessageId, p.html])).toEqual([
      ['SENT', 777n, before[0]!.html], // confirmed part untouched
      ['UNKNOWN', null, before[1]!.html], // may have been sent: ambiguity kept
    ]);
    for (const id of [partial, pending]) {
      expect(await h.prisma.delivery.findUniqueOrThrow({ where: { id } })).toMatchObject({
        state: 'SUPPRESSED',
        lastErrorCode: 'RESTORE_QUARANTINED',
      });
      expect(
        await h.prisma.deliveryEvent.count({
          where: { deliveryId: id, dispatchedAt: null, cancelledAt: null },
        }),
      ).toBe(0);
    }
    expect(await audits()).toHaveLength(2);
    await applyQuarantine(h.prisma, { targets: [{ kind: 'delivery', id: pending }], ...decision });
    expect(await audits()).toHaveLength(2);

    const live = await reopen();
    // Stale jobs and the recovery sweep send nothing.
    await live.delivery.handle(partial);
    await live.delivery.handle(pending);
    await live.deliveryDispatcher.sweep();
    // A later, legitimate message in the same chat goes out.
    await live.post(privateMessage('/help')).expect(200);
    await vi.waitFor(() => expect(live.sender.sent).toHaveLength(1), { timeout: 10_000 });
    expect(live.sender.attempts.map((a) => a.html)).not.toContain('part two');
    expect(live.sender.attempts.map((a) => a.html)).not.toContain('delivered after the backup');
  }, 30_000);

  it('refuses mutations without the hold or the decision, and leaves no partial change', async () => {
    await h.post(privateMessage('/research one')).expect(200);
    const queued = await h.prisma.researchRun.findFirstOrThrow();
    const targets = [{ kind: 'run' as const, id: queued.id }];

    await expect(applyQuarantine(h.prisma, { targets, ...decision })).rejects.toMatchObject({
      code: 'HOLD_REQUIRED',
    });
    await hold();
    await expect(
      applyQuarantine(h.prisma, { targets, operator: ' ', reason: 'r' }),
    ).rejects.toBeInstanceOf(QuarantineError);
    await expect(
      applyQuarantine(h.prisma, { targets, operator: 'o', reason: '' }),
    ).rejects.toMatchObject({ code: 'INVALID_REASON' });
    await expect(
      applyQuarantine(h.prisma, { targets: [{ kind: 'run', id: 'not-a-uuid' }], ...decision }),
    ).rejects.toMatchObject({ code: 'INVALID_ID:not-a-uuid' });

    // A failing target rolls back the whole decision, including the valid run.
    const missing = '00000000-0000-4000-8000-000000000000';
    await expect(
      applyQuarantine(h.prisma, {
        targets: [...targets, { kind: 'delivery', id: missing }],
        ...decision,
      }),
    ).rejects.toMatchObject({ code: `DELIVERY_NOT_FOUND:${missing}` });
    expect((await run(queued.id)).state).toBe('QUEUED');
    expect((await reservation(queued.id)).status).toBe('RESERVED');
    expect(await ledger(queued.id)).toHaveLength(1);
    expect(await audits()).toHaveLength(0);

    // Finished runs are left alone.
    await applyQuarantine(h.prisma, { targets, ...decision });
    await h.prisma
      .$executeRaw`UPDATE research_run SET failure_code = 'OTHER' WHERE id = ${queued.id}::uuid`;
    const [other] = await applyQuarantine(h.prisma, { targets, ...decision });
    expect(other?.action).toBe('NOT_APPLICABLE');
  }, 30_000);
});
