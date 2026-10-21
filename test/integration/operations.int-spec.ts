import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHold, readHold, setHold } from '../../src/operations/hold';
import { readSchemaState, shippedMigrations } from '../../src/operations/schema-state';
import type { ProviderSnapshot } from '../../src/research/provider/provider.types';
import { snapshot } from '../support/fakes';
import { httpServer } from '../support/http';
import {
  ADMIN_ID,
  OTHER_ADMIN_ID,
  privateMessage,
  resetDatabase,
  startHarness,
  type Harness,
} from '../support/research-harness';

// TRB-100: execution gate (schema check, operational hold), shutdown order and
// same-version overlap. Real PostgreSQL and pg-boss; scripted provider and
// recording Telegram sender (no network).

const BACKGROUND = {
  BACKGROUND_WORKERS: 'on',
  WORKER_POLL_INTERVAL_MS: '50',
  OPENAI_POLL_INTERVAL_MS: '20',
  RESEARCH_QUEUE_LIMIT: '10',
};

const FUTURE_MIGRATION = '29991231000000_not_yet_applied';

describe('TRB-100 operations', () => {
  const open: Harness[] = [];
  let base: Harness;

  const start = async (...args: Parameters<typeof startHarness>) => {
    const harness = await startHarness(...args);
    open.push(harness);
    return harness;
  };
  const close = async (harness: Harness) => {
    open.splice(open.indexOf(harness), 1);
    await harness.close();
  };
  const ready = (harness: Harness) => request(httpServer(harness.app)).get('/health/ready');
  const runs = () =>
    base.prisma.researchRun.findMany({
      orderBy: { createdAt: 'asc' },
      include: { attempts: true },
    });

  beforeEach(async () => {
    base = await start();
    await resetDatabase(base.prisma);
  });

  afterEach(async () => {
    for (const harness of open.splice(0).reverse()) await harness.close();
  });

  describe('schema check', () => {
    it('keeps execution stopped while a shipped migration is missing, then opens', async () => {
      let shipsFuture = true;
      const h = await start(BACKGROUND, {
        shippedMigrations: () =>
          shipsFuture ? [...shippedMigrations(), FUTURE_MIGRATION] : shippedMigrations(),
      });
      expect(h.gate.state).toBe('schema_pending');
      const response = await ready(h).expect(503);
      expect(response.body).toMatchObject({
        status: 'error',
        checks: { schema: 'down', execution: 'pending', workers: 'down' },
      });
      expect(JSON.stringify(response.body)).not.toContain(FUTURE_MIGRATION);

      // An authenticated update is refused with 503 and not read: Telegram keeps it.
      const update = privateMessage('/research before migration');
      await h.post(update).expect(503);
      expect(await h.prisma.telegramUpdate.count()).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(h.sender.attempts).toHaveLength(0);

      shipsFuture = false; // the migration step ran
      expect(await h.gate.evaluateNow()).toBe('open');
      await vi.waitFor(async () => expect((await ready(h)).status).toBe(200), { timeout: 5_000 });
      await h.post(update).expect(200); // Telegram's retry is processed once the gate is open
      await vi.waitFor(async () => expect((await runs())[0]?.state).toBe('SUCCEEDED'), {
        timeout: 10_000,
      });
    }, 30_000);

    it('reports a failed migration and a database newer than the build', async () => {
      await base.prisma.$executeRawUnsafe(
        `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count)
         VALUES ('trb100-failed', 'x', '29991231000001_failed', now(), 0),
                ('trb100-newer', 'y', '29991231000002_newer', now(), 1)`,
      );
      await base.prisma.$executeRawUnsafe(
        `UPDATE _prisma_migrations SET finished_at = now() WHERE id = 'trb100-newer'`,
      );
      try {
        const state = await readSchemaState(base.prisma);
        expect(state.failed).toEqual(['29991231000001_failed']);
        expect(state.unknown).toEqual(['29991231000002_newer']);
        expect(state.pending).toEqual([]);
        const h = await start();
        expect(h.gate.state).toBe('schema_pending');
      } finally {
        await base.prisma.$executeRawUnsafe(
          `DELETE FROM _prisma_migrations WHERE id IN ('trb100-failed', 'trb100-newer')`,
        );
      }
      // Only a newer database (older image after an additive migration) is allowed.
      await base.prisma.$executeRawUnsafe(
        `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
         VALUES ('trb100-newer', 'y', '29991231000002_newer', now(), now(), 1)`,
      );
      try {
        const h = await start();
        expect(h.gate.state).toBe('open');
      } finally {
        await base.prisma.$executeRawUnsafe(
          `DELETE FROM _prisma_migrations WHERE id = 'trb100-newer'`,
        );
      }
    });
  });

  describe('operational hold', () => {
    it('starts nothing on a held database, then resumes only after the hold is cleared', async () => {
      await base.post(privateMessage('/research queued before the restore')).expect(200);
      const [queued] = await runs();
      expect(queued?.state).toBe('QUEUED');
      const pendingDeliveries = await base.prisma.delivery.count({ where: { state: 'PENDING' } });
      expect(pendingDeliveries).toBeGreaterThan(0);

      const set = await setHold(base.prisma, { reason: 'restored backup', setBy: 'operator' });
      expect(set.created).toBe(true);
      expect((await setHold(base.prisma, { reason: 'again', setBy: 'x' })).created).toBe(false);

      const h = await start(BACKGROUND);
      expect(h.gate.state).toBe('held');
      const response = await ready(h).expect(200);
      expect(response.body).toMatchObject({
        status: 'held',
        checks: { database: 'up', queue: 'up', schema: 'up', execution: 'held' },
      });
      await h.post(privateMessage('/research during hold')).expect(503);

      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(h.provider.calls).toEqual({ submit: 0, retrieve: 0, cancel: 0 });
      expect(h.sender.attempts).toHaveLength(0);
      expect((await runs()).map((run) => run.state)).toEqual(['QUEUED']);
      expect(await h.prisma.outboxEvent.count({ where: { dispatchedAt: { not: null } } })).toBe(0);

      expect(await clearHold(base.prisma)).toBe(true);
      expect(await readHold(base.prisma)).toBeNull();
      expect(await h.gate.evaluateNow()).toBe('open');
      await vi.waitFor(async () => expect((await runs())[0]?.state).toBe('SUCCEEDED'), {
        timeout: 10_000,
      });
      await vi.waitFor(() => expect(h.sender.sent.length).toBeGreaterThanOrEqual(2), {
        timeout: 10_000,
      });
      expect(h.provider.calls.submit).toBe(1);
    }, 30_000);
  });

  describe('shutdown', () => {
    it('stops taking new work at once, keeps the response ID and hands the run over', async () => {
      const a = await start(BACKGROUND);
      let accept: (value: ProviderSnapshot) => void = () => undefined;
      a.provider.onSubmit = (submitted) =>
        new Promise((resolve) => {
          accept = () => resolve(snapshot(submitted, { id: 'resp_shutdown' }));
        });
      await a.post(privateMessage('/research slow submission')).expect(200);
      await vi.waitFor(() => expect(a.provider.calls.submit).toBe(1), { timeout: 10_000 });
      await vi.waitFor(() => expect(a.sender.sent.length).toBeGreaterThanOrEqual(1), {
        timeout: 10_000,
      });

      a.lifecycle.beginShutdown(); // what SIGTERM does first
      const attemptsAtShutdown = a.sender.attempts.length;
      await ready(a).expect(503);
      // HTTP and the database stay available while draining: a new update is stored...
      await a.post(privateMessage('/help')).expect(200);
      // Even a job already in the queue is not fetched by this instance any more.
      expect(await a.deliveryDispatcher.dispatchDue()).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      // ...but this instance sends nothing new and starts nothing new.
      expect(a.sender.attempts).toHaveLength(attemptsAtShutdown);

      // The provider call in flight is waited for, so its response ID is saved.
      accept(snapshot(a.provider.requests[0]!, { id: 'resp_shutdown' }));
      const stopping = Date.now();
      await close(a);
      expect(Date.now() - stopping).toBeLessThan(15_000);
      const [run] = await runs();
      expect(run).toMatchObject({
        state: 'RUNNING',
        submissionState: 'SUBMITTED',
        providerResponseId: 'resp_shutdown',
      });
      expect(run?.leaseUntil?.getTime()).toBeLessThanOrEqual(Date.now());

      const b = await start(BACKGROUND);
      await vi.waitFor(async () => expect((await runs())[0]?.state).toBe('SUCCEEDED'), {
        timeout: 15_000,
      });
      expect(b.provider.calls.submit).toBe(0);
      expect(b.provider.calls.retrieve).toBeGreaterThan(0);
      const [finished] = await runs();
      expect(finished?.attempts).toHaveLength(1);
      await vi.waitFor(
        async () =>
          expect(await b.prisma.delivery.count({ where: { state: { notIn: ['SENT'] } } })).toBe(0),
        { timeout: 10_000 },
      );
      // The /help reply and the report were sent once, by the new instance.
      expect(b.sender.sent.length).toBeGreaterThanOrEqual(2);
    }, 60_000);
  });

  describe('same-version overlap', () => {
    it('two instances never submit a run twice or resend a confirmed part', async () => {
      const a = await start(BACKGROUND);
      const b = await start(BACKGROUND);
      for (const harness of [a, b]) {
        harness.provider.onSubmit = (submitted) =>
          Promise.resolve(snapshot(submitted, { id: `resp_${submitted.runId}` }));
      }
      const users = [ADMIN_ID, OTHER_ADMIN_ID, ADMIN_ID, OTHER_ADMIN_ID];
      for (const [index, user] of users.entries()) {
        await (index % 2 === 0 ? a : b)
          .post(privateMessage(`/research overlap ${index}`, user))
          .expect(200);
      }
      // The old instance is stopped while work is in progress (deployment overlap ends).
      await vi.waitFor(
        async () =>
          expect((await runs()).filter((run) => run.state === 'SUCCEEDED').length).toBeGreaterThan(
            0,
          ),
        { timeout: 20_000 },
      );
      a.lifecycle.beginShutdown();
      await close(a);

      await vi.waitFor(
        async () => expect((await runs()).every((run) => run.state === 'SUCCEEDED')).toBe(true),
        { timeout: 30_000 },
      );
      await vi.waitFor(
        async () =>
          expect(await b.prisma.delivery.count({ where: { state: { not: 'SENT' } } })).toBe(0),
        { timeout: 15_000 },
      );
      const all = await runs();
      expect(all).toHaveLength(4);
      expect(a.provider.calls.submit + b.provider.calls.submit).toBe(4);
      expect(all.every((run) => run.attempts.length === 1)).toBe(true);
      expect(new Set(all.map((run) => run.providerResponseId)).size).toBe(4);

      // Every stored part was sent exactly once across both instances.
      const parts = await b.prisma.deliveryPart.findMany({ select: { telegramMessageId: true } });
      expect(parts.every((part) => part.telegramMessageId !== null)).toBe(true);
      const sends = a.sender.attempts.length + b.sender.attempts.length;
      expect(sends).toBe(parts.length);
      expect(await b.prisma.delivery.count({ where: { state: 'UNKNOWN' } })).toBe(0);
    }, 90_000);
  });
});
