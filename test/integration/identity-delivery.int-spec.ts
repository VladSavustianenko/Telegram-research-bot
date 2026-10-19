import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { buildTextPart } from '../../src/research/provider/fake-fixtures';
import type { ProviderSnapshot } from '../../src/research/provider/provider.types';
import { completed, echoed, snapshot } from '../support/fakes';
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

const MEMBER = 3003;
const REPORT_TITLE = 'Результат дослідження';

/** A completed provider answer long enough for several Telegram messages. */
const longReport = (): ProviderSnapshot =>
  completed([
    buildTextPart([
      'OUTCOME: FOUND\n',
      ...Array.from({ length: 30 }, (_, i) => [
        `Пункт ${i} ${'довгий текст '.repeat(25)}`,
        { cite: { url: `https://s${i}.example/`, title: `S${i}` } },
        '\n\n',
      ]).flat(),
    ]),
  ]);

describe('TRB-030 review fixes: durable suppression and current access at delivery', () => {
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
    // Distinct provider response IDs for every submission.
    let submissions = 0;
    h.provider.onSubmit = (request) =>
      Promise.resolve(snapshot(request, { id: `resp_${++submissions}` }));
  });

  afterEach(async () => {
    for (const harness of open.splice(0)) await harness.close();
  });

  const sentTo = (harness: Harness, id: number) =>
    harness.sender.sent.filter((message) => message.chatId === BigInt(id));
  const reportsTo = (harness: Harness, id: number) =>
    sentTo(harness, id).filter((message) => message.html.includes(REPORT_TITLE));
  const lastButton = (harness: Harness, id: number) =>
    sentTo(harness, id).at(-1)?.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data ?? '';
  const suspend = (id: number) => h.post(privateMessage(`/admin suspend ${id}`, ADMIN_ID));
  const reactivate = (id: number) => h.post(privateMessage(`/admin reactivate ${id}`, ADMIN_ID));
  const report = (runId: string) =>
    h.prisma.delivery.findFirstOrThrow({
      where: { runId, kind: 'REPORT' },
      include: { parts: { orderBy: { ordinal: 'asc' } } },
    });

  async function onboardMember(): Promise<void> {
    await h.post(privateMessage('/admin invite', ADMIN_ID)).expect(200);
    await drainDeliveries(h);
    const token = /\?start=([A-Za-z0-9_-]{43})/.exec(sentTo(h, ADMIN_ID).at(-1)?.html ?? '')?.[1];
    await h.post(privateMessage(`/start ${token}`, MEMBER)).expect(200);
    await drainDeliveries(h);
    await h.post(callbackQuery(lastButton(h, MEMBER), MEMBER)).expect(200);
    await drainDeliveries(h);
  }

  describe('Finding 1: reactivation never releases accumulated deliveries', () => {
    it('suppresses a report completed by the suspension cancellation, even after reactivation', async () => {
      await onboardMember();
      let polls = 0;
      h.provider.onRetrieve = async (id) => {
        polls += 1;
        if (polls === 1) await suspend(MEMBER);
        return snapshot(h.provider.echo, { id, status: 'in_progress' });
      };
      // Cancellation arrives too late: the provider already completed the response.
      h.provider.onCancel = (id) =>
        Promise.resolve({ ...longReport(), id, bounds: echoed(h.provider.echo) });
      await h.post(privateMessage('/research during suspension', MEMBER)).expect(200);
      await h.research.tick();
      const run = await h.prisma.researchRun.findFirstOrThrow();
      expect(run).toMatchObject({ state: 'SUCCEEDED', providerResponseId: 'resp_1' });
      expect(run.reportText).toBeTruthy();
      expect(run.usage).toMatchObject({ inputTokens: 1200 });

      await reactivate(MEMBER);
      await drainDeliveries(h);
      expect(reportsTo(h, MEMBER)).toHaveLength(0);
      expect(await report(run.id)).toMatchObject({ state: 'SUPPRESSED' });

      // Explicit /result after reactivation: a new, authorized resend; no provider call.
      const parts = (await report(run.id)).parts.map((part) => part.html);
      h.sender.sent.length = 0;
      await h.post(privateMessage(`/result ${run.id}`, MEMBER)).expect(200);
      await drainDeliveries(h);
      expect(sentTo(h, MEMBER).map((message) => message.html)).toEqual(parts);
      expect(await report(run.id)).toMatchObject({ state: 'SUPPRESSED' });
      expect(h.provider.calls.submit).toBe(1);

      // New research after reactivation works normally.
      h.provider.onRetrieve = (id) =>
        Promise.resolve({ ...longReport(), id, bounds: echoed(h.provider.echo) });
      await h.post(privateMessage('/research after reactivation', MEMBER)).expect(200);
      await h.research.tick();
      await drainDeliveries(h);
      const latest = await h.prisma.researchRun.findFirstOrThrow({
        orderBy: { createdAt: 'desc' },
      });
      expect(latest.state).toBe('SUCCEEDED');
      expect(await report(latest.id)).toMatchObject({ state: 'SENT' });
      expect(h.provider.calls.submit).toBe(2);
    });

    it('suppresses a report completed while the owner was suspended (completion seen by the poll)', async () => {
      await onboardMember();
      h.provider.onRetrieve = async (id) => {
        await suspend(MEMBER);
        return { ...longReport(), id, bounds: echoed(h.provider.echo) };
      };
      await h.post(privateMessage('/research completes', MEMBER)).expect(200);
      await h.research.tick();
      await reactivate(MEMBER);
      await drainDeliveries(h);
      const run = await h.prisma.researchRun.findFirstOrThrow();
      expect(run.state).toBe('SUCCEEDED');
      expect(reportsTo(h, MEMBER)).toHaveLength(0);
      expect(await report(run.id)).toMatchObject({ state: 'SUPPRESSED' });
    });

    it('stops the remaining parts of a delivery whose first send is in flight', async () => {
      await onboardMember();
      h.provider.onRetrieve = (id) =>
        Promise.resolve({ ...longReport(), id, bounds: echoed(h.provider.echo) });
      await h.post(privateMessage('/research long', MEMBER)).expect(200);
      await h.research.tick();
      await h.delivery.tick(); // acknowledgment
      const run = await h.prisma.researchRun.findFirstOrThrow();
      expect((await report(run.id)).parts.length).toBeGreaterThan(2);

      let inFlight = 0;
      h.sender.beforeSend = async (html) => {
        if (!html.includes(REPORT_TITLE) || inFlight++ > 0) return;
        // While Telegram is handling part 1: suspension and reactivation.
        await suspend(MEMBER);
        await reactivate(MEMBER);
      };
      await drainDeliveries(h);

      const delivery = await report(run.id);
      expect(delivery.state).toBe('SUPPRESSED');
      expect(delivery.parts[0]).toMatchObject({ state: 'SENT' });
      expect(delivery.parts[0]?.telegramMessageId).not.toBeNull();
      expect(delivery.parts.slice(1).every((part) => part.state === 'PENDING')).toBe(true);
      expect(reportsTo(h, MEMBER)).toHaveLength(1);
    });

    it('keeps suppression across a worker restart, preserving UNKNOWN parts', async () => {
      await onboardMember();
      h.provider.onRetrieve = (id) =>
        Promise.resolve({ ...longReport(), id, bounds: echoed(h.provider.echo) });
      await h.post(privateMessage('/research one', MEMBER)).expect(200);
      await h.research.tick();
      await h.post(privateMessage('/research two', MEMBER)).expect(200);
      await h.research.tick();
      await drainDeliveries(h, 2); // two acknowledgments only
      const [first, second] = await h.prisma.researchRun.findMany({
        orderBy: { createdAt: 'asc' },
      });
      const [runOne, runTwo] = [first?.id ?? '', second?.id ?? ''];
      const [one, two] = [await report(runOne), await report(runTwo)];
      // A worker died while sending: between parts of one, and during part 0 of two.
      await h.prisma.$executeRaw`
        UPDATE delivery SET state = 'SENDING', lease_until = now() + interval '1 hour'
         WHERE id IN (${one.id}::uuid, ${two.id}::uuid)`;
      await h.prisma.$executeRaw`
        UPDATE delivery_part SET state = 'SENT', telegram_message_id = 77
         WHERE delivery_id = ${one.id}::uuid AND ordinal = 0`;
      await h.prisma.$executeRaw`
        UPDATE delivery_part SET state = 'SENDING' WHERE delivery_id = ${two.id}::uuid AND ordinal = 0`;
      await suspend(MEMBER);
      await reactivate(MEMBER);
      await h.prisma.$executeRaw`
        UPDATE delivery SET lease_until = now() - interval '1 second' WHERE id IN (${one.id}::uuid, ${two.id}::uuid)`;

      const restarted = await start();
      await drainDeliveries(restarted);
      expect(reportsTo(restarted, MEMBER)).toHaveLength(0);
      expect(await report(runOne)).toMatchObject({ state: 'SUPPRESSED' });
      expect((await report(runOne)).parts[0]).toMatchObject({
        state: 'SENT',
        telegramMessageId: 77n,
      });
      // The ambiguous part stays UNKNOWN; nothing is retried automatically.
      expect(await report(runTwo)).toMatchObject({ state: 'UNKNOWN' });
      expect((await report(runTwo)).parts[0]?.state).toBe('UNKNOWN');
    });

    it('cannot leave a deliverable report when suspension races with report creation', async () => {
      await onboardMember();
      const blocker = new Client({ connectionString: inject('databaseUrl') });
      await blocker.connect();
      try {
        await h.post(privateMessage('/research race', MEMBER)).expect(200);
        const run = await h.prisma.researchRun.findFirstOrThrow();
        // Once the worker holds the run (RUNNING), take the report's unique slot, so
        // its completion transaction pauses after locking the run row and before
        // inserting its REPORT delivery.
        h.provider.onRetrieve = async (id) => {
          await blocker.query('BEGIN');
          await blocker.query(
            `INSERT INTO delivery (id, run_id, kind, chat_id, updated_at)
             VALUES (gen_random_uuid(), $1, 'REPORT', $2, now())`,
            [run.id, MEMBER],
          );
          return { ...longReport(), id, bounds: echoed(h.provider.echo) };
        };
        const waiters = async () =>
          (
            await blocker.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'`,
            )
          ).rows[0]?.n ?? 0;
        // A second process (own connection pool) performs the suspension.
        const admin = await start();
        const ticking = h.research.tick();
        await vi.waitFor(async () => expect(await waiters()).toBe(1));
        // Suspension now waits for the run row held by the completing worker.
        // supertest sends on then(); start the request now.
        const suspending = admin
          .post(privateMessage(`/admin suspend ${MEMBER}`, ADMIN_ID))
          .then((response) => response.status);
        await vi.waitFor(async () => expect(await waiters()).toBe(2));
        await blocker.query('ROLLBACK');
        await ticking;
        expect(await suspending).toBe(200);
      } finally {
        await blocker.end();
      }
      await reactivate(MEMBER);
      await drainDeliveries(h);
      const run = await h.prisma.researchRun.findFirstOrThrow();
      expect(run.state).toBe('SUCCEEDED');
      expect(await report(run.id)).toMatchObject({ state: 'SUPPRESSED' });
      expect(reportsTo(h, MEMBER)).toHaveLength(0);
    });
  });

  describe('Finding 2: delivery applies current account access', () => {
    /** Administrator with a pending report, a queued resend and a run-related status message. */
    async function pendingAdminDeliveries(): Promise<string> {
      await h.post(privateMessage('/research earlier', ADMIN_ID)).expect(200);
      await h.research.tick();
      await drainDeliveries(h);
      const earlier = await h.prisma.researchRun.findFirstOrThrow();
      h.provider.onRetrieve = (id) =>
        Promise.resolve(snapshot(h.provider.echo, { id, status: 'failed' }));
      await h.post(privateMessage('/research pending', ADMIN_ID)).expect(200);
      await h.research.tick(); // FAILED: a run-related status message, not yet sent
      h.provider.onRetrieve = (id) =>
        Promise.resolve({ ...longReport(), id, bounds: echoed(h.provider.echo) });
      await h.post(privateMessage('/research report', ADMIN_ID)).expect(200);
      await h.research.tick(); // REPORT, not yet sent
      await h.post(privateMessage(`/result ${earlier.id}`, ADMIN_ID)).expect(200); // RESEND queued
      h.sender.sent.length = 0;
      return earlier.id;
    }

    const runDeliveriesFor = (harness: Harness) =>
      harness.prisma.delivery.findMany({
        where: { chatId: BigInt(ADMIN_ID), runId: { not: null }, state: { notIn: ['SENT'] } },
        orderBy: { createdAt: 'asc' },
      });

    it('suppresses the pending work of a removed administrator without an invitation', async () => {
      await pendingAdminDeliveries();
      const removed = await start({ ADMIN_TELEGRAM_IDS: `${OTHER_ADMIN_ID}` });
      await drainDeliveries(removed);
      expect(sentTo(removed, ADMIN_ID)).toHaveLength(0);
      const pending = await runDeliveriesFor(removed);
      expect(pending.map((d) => [d.kind, d.state, d.lastErrorCode])).toEqual([
        ['STATUS', 'SUPPRESSED', 'ACCESS_REVOKED'],
        ['STATUS', 'SUPPRESSED', 'ACCESS_REVOKED'],
        ['STATUS', 'SUPPRESSED', 'ACCESS_REVOKED'],
        ['REPORT', 'SUPPRESSED', 'ACCESS_REVOKED'],
        ['RESEND', 'SUPPRESSED', 'ACCESS_REVOKED'],
      ]);
      // A reply that is not about a run is still possible.
      await removed.post(privateMessage('/start', ADMIN_ID)).expect(200);
      await drainDeliveries(removed);
      expect(sentTo(removed, ADMIN_ID).map((m) => m.html)).toEqual([
        'Цей бот приватний. Доступ лише за запрошенням.',
      ]);
    });

    it('fails closed when the configuration excludes an administrator whose stored role is stale', async () => {
      await pendingAdminDeliveries();
      const removed = await start({ ADMIN_TELEGRAM_IDS: `${OTHER_ADMIN_ID}` });
      // Bootstrap did not (yet) apply: the stored role still says ADMIN.
      await removed.prisma.appUser.update({
        where: { telegramUserId: BigInt(ADMIN_ID) },
        data: { role: 'ADMIN' },
      });
      await drainDeliveries(removed);
      expect(sentTo(removed, ADMIN_ID)).toHaveLength(0);
    });

    it('keeps delivering to a former administrator who is an invited member', async () => {
      await h.prisma.appUser.update({
        where: { telegramUserId: BigInt(ADMIN_ID) },
        data: { invitedAt: new Date() },
      });
      await pendingAdminDeliveries();
      const removed = await start({ ADMIN_TELEGRAM_IDS: `${OTHER_ADMIN_ID}` });
      await drainDeliveries(removed);
      expect(
        (
          await removed.prisma.appUser.findUniqueOrThrow({
            where: { telegramUserId: BigInt(ADMIN_ID) },
          })
        ).role,
      ).toBe('MEMBER');
      expect(reportsTo(removed, ADMIN_ID).length).toBeGreaterThan(1); // report and resend
      expect(await runDeliveriesFor(removed)).toEqual([]);
    });
  });
});
