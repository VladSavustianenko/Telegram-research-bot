import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { exposureMicros } from '../../src/accounting/ledger';
import { applyRecordedBlock } from '../../src/delivery/destination';
import { RESEARCH_QUEUE } from '../../src/queue/queue.service';
import { buildTextPart, type Segment } from '../../src/research/provider/fake-fixtures';
import { reconcileUncertainRun } from '../../src/research/reconciliation';
import { REDACTED } from '../../src/retention/retention.service';
import { resendCallbackData, runCallbackData } from '../../src/telegram/callback-data';
import {
  FakeClock,
  ScriptedProvider,
  completed,
  echoed,
  snapshot,
  unknownOutcome,
} from '../support/fakes';
import { LIVE_TEST_ENV } from '../support/live-env';
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
import { disposableDatabaseName, withDatabase } from '../support/test-database';

const DAY = 86_400_000;
const MARKER = 'PRIVATE-MARKER-91c2';
const REPORT_TITLE = 'Результат дослідження';

const visible = (html: string) =>
  html
    .replace(/<\/?(?:b|i|code|a)(?:\s[^>]*)?>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

/** A long cited report carrying the marker (document fallback). */
function longReport(): Segment[] {
  const segments: Segment[] = ['OUTCOME: FOUND\n'];
  for (let i = 0; i < 300; i += 1) {
    segments.push(`Пункт ${i} ${MARKER} ${'текст '.repeat(20)}`);
    segments.push({ cite: { url: `https://s${i % 5}.example/`, title: `Source ${MARKER}` } });
    segments.push('\n\n');
  }
  return segments;
}

function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe('TRB-090 retention cleanup (fake clock, real PostgreSQL)', () => {
  const open: Harness[] = [];
  let h: Harness;
  let clock: FakeClock;

  const start = async (env: Record<string, string> = {}, live = false) => {
    const harness = await startHarness(live ? { ...LIVE_TEST_ENV, ...env } : env, {
      clock,
      ...(live ? { provider: new ScriptedProvider('openai') } : {}),
    });
    harness.provider.onSubmit = (request) =>
      Promise.resolve(snapshot(request, { id: `resp_${request.runId}` }));
    open.push(harness);
    return harness;
  };
  const close = async (harness: Harness) => {
    open.splice(open.indexOf(harness), 1);
    await harness.close();
  };

  beforeEach(async () => {
    // Database times (delivery updated_at, inbox received_at) are real; the clock starts there.
    clock = new FakeClock(new Date());
    h = await start();
    await resetDatabase(h.prisma);
  });

  afterEach(async () => {
    for (const harness of open.splice(0)) await harness.close();
  });

  const say = async (text: string, from = ADMIN_ID, harness = h) => {
    await harness.post(privateMessage(text, from)).expect(200);
    await drainDeliveries(harness);
  };
  const lastText = (harness = h) => visible(harness.sender.sent.at(-1)?.html ?? '');
  const completeWith = (harness: Harness, segments: Segment[]) => {
    harness.provider.onRetrieve = (id) =>
      Promise.resolve({
        ...completed([buildTextPart(segments)]),
        id,
        bounds: echoed(harness.provider.echo),
      });
  };
  const researched = async (prompt = `topic ${MARKER}`, harness = h) => {
    await harness.post(privateMessage(`/research ${prompt}`)).expect(200);
    expect(await harness.research.tick()).toBe(true);
    return harness.prisma.researchRun.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
  };
  const advance = (ms: number) => clock.set(new Date(clock.now().getTime() + ms));
  const run = (id: string) => h.prisma.researchRun.findUniqueOrThrow({ where: { id } });
  /** Every stored copy of user or model text that contains the marker. */
  const markerCopies = async () =>
    (
      await h.prisma.$queryRawUnsafe<{ place: string }[]>(`
        SELECT 'run' AS place FROM research_run
         WHERE prompt LIKE '%${MARKER}%' OR report_text LIKE '%${MARKER}%'
            OR request_snapshot::text LIKE '%${MARKER}%' OR citations::text LIKE '%${MARKER}%'
            OR sources::text LIKE '%${MARKER}%'
        UNION ALL SELECT 'part:' || d.kind::text FROM delivery_part p JOIN delivery d ON d.id = p.delivery_id
         WHERE p.html LIKE '%${MARKER}%' OR p.file_content LIKE '%${MARKER}%' OR p.reply_markup::text LIKE '%${MARKER}%'
        UNION ALL SELECT 'task:' || state::text FROM task WHERE name LIKE '%${MARKER}%' OR prompt LIKE '%${MARKER}%'
        UNION ALL SELECT 'draft' FROM task_draft WHERE data::text LIKE '%${MARKER}%'`)
    ).map((row) => row.place);
  const accounting = async () => ({
    reservations: await h.prisma.budgetReservation.findMany({ orderBy: { id: 'asc' } }),
    ledger: await h.prisma.usageLedger.findMany({ orderBy: { id: 'asc' } }),
    attempts: await h.prisma.researchAttempt.findMany({ orderBy: { id: 'asc' } }),
    reconciliations: await h.prisma.researchReconciliation.findMany(),
  });

  it('purges at the configured boundary only', async () => {
    const r = await researched();
    advance(30 * DAY - 60_000);
    await h.retention.runPass();
    expect((await run(r.id)).contentPurgedAt).toBeNull();
    advance(2 * 60_000);
    expect((await h.retention.runPass()).runs).toBe(1);
    expect((await run(r.id)).contentPurgedAt).toBeInstanceOf(Date);

    const short = await start({ REPORT_RETENTION_DAYS: '7' });
    const second = await researched('second', short);
    advance(7 * DAY + 60_000);
    expect((await short.retention.runPass()).runs).toBe(1);
    expect((await run(second.id)).contentPurgedAt).toBeInstanceOf(Date);
  });

  it('removes every content copy, keeps active tasks and evidence, and answers purged lookups gracefully', async () => {
    completeWith(h, longReport());
    const r = await researched();
    await drainDeliveries(h);
    await say(`/result ${r.id}`); // a resend copy, later than the report
    await h.post(callbackQuery(runCallbackData(r.id, 'all'))).expect(200); // a card with the prompt preview
    await drainDeliveries(h);
    const active = await h.prisma.task.create({
      data: {
        userId: r.userId ?? '',
        name: `Active ${MARKER}`,
        prompt: `Active prompt ${MARKER}`,
        scheduleKind: 'MANUAL',
        timeZone: 'Europe/Kyiv',
        createdAt: new Date(clock.now().getTime() - 400 * DAY),
      },
    });
    const deleted = await h.prisma.task.create({
      data: {
        userId: r.userId ?? '',
        name: `Gone ${MARKER}`,
        prompt: `Gone prompt ${MARKER}`,
        scheduleKind: 'MANUAL',
        timeZone: 'Europe/Kyiv',
        state: 'DELETED',
        deletedAt: clock.now(),
      },
    });
    await say('/new');
    await say(`Draft ${MARKER}`);
    const report = await h.prisma.delivery.findFirstOrThrow({
      where: { runId: r.id, kind: 'REPORT' },
      include: { parts: { orderBy: { ordinal: 'asc' } } },
    });
    expect(report.parts.map((p) => p.kind)).toEqual(['MESSAGE', 'DOCUMENT']);
    expect((await markerCopies()).length).toBeGreaterThan(5);

    advance(31 * DAY);
    await h.retention.runPass();
    expect(await markerCopies()).toEqual(['task:ACTIVE']);
    expect(await h.prisma.task.findUniqueOrThrow({ where: { id: active.id } })).toMatchObject({
      prompt: `Active prompt ${MARKER}`,
      contentPurgedAt: null,
    });
    expect(await h.prisma.task.findUniqueOrThrow({ where: { id: deleted.id } })).toMatchObject({
      name: REDACTED,
      prompt: REDACTED,
    });
    expect(await h.prisma.taskDraft.count()).toBe(0);
    const purged = await run(r.id);
    expect(purged).toMatchObject({
      state: 'SUCCEEDED',
      outcome: 'FOUND',
      prompt: REDACTED,
      reportText: null,
    });
    expect(Object.keys(purged.requestSnapshot as object)).toContain('config');
    expect(purged.requestSnapshot).not.toHaveProperty('request');
    const after = await h.prisma.delivery.findFirstOrThrow({
      where: { id: report.id },
      include: { parts: { orderBy: { ordinal: 'asc' } } },
    });
    for (const [index, part] of after.parts.entries()) {
      expect(part).toMatchObject({ html: '', fileContent: null, replyMarkup: null, state: 'SENT' });
      expect(part.contentPurgedAt).toBeInstanceOf(Date);
      expect(part.contentHash).toBe(report.parts[index]?.contentHash);
      expect(part.telegramMessageId).toBe(report.parts[index]?.telegramMessageId);
      expect(part.fileName).toBe(report.parts[index]?.fileName);
    }
    // A purge pass again changes nothing.
    const again = await h.retention.runPass();
    expect(again.runs + again.deliveries + again.tasks).toBe(0);

    // Purged results: no resend, no research, no empty message, no dangling button.
    h.sender.sent.length = 0;
    const resendsBefore = await h.prisma.delivery.count({ where: { kind: 'RESEND' } });
    await say(`/result ${r.id}`);
    expect(lastText()).toContain('більше недоступний');
    await h.post(callbackQuery(resendCallbackData(r.id))).expect(200);
    await drainDeliveries(h);
    expect(lastText()).toContain('більше недоступний');
    await h.post(callbackQuery(runCallbackData(r.id, 'all'))).expect(200);
    await drainDeliveries(h);
    expect(lastText()).toContain('вміст видалено за політикою зберігання');
    expect(lastText()).toContain('текст запиту видалено');
    expect(
      h.sender.sent
        .at(-1)
        ?.replyMarkup?.inline_keyboard.flat()
        .some((b) => b.callback_data.startsWith('rs:')),
    ).toBe(false);
    expect(await h.prisma.delivery.count({ where: { kind: 'RESEND' } })).toBe(resendsBefore);
    expect(h.sender.sent.every((m) => m.html.length > 0 && !m.document)).toBe(true);
    expect(h.provider.calls.submit).toBe(1);
  });

  it('keeps unresolved accounting and unreconciled runs; purges once settled, without touching accounting', async () => {
    const live = await start({}, true);
    h = live;
    live.provider.onSubmit = () => Promise.reject(unknownOutcome());
    const uncertain = await researched(`uncertain ${MARKER}`, live);
    expect(uncertain.state).toBe('UNCERTAIN');
    expect(await live.prisma.budgetReservation.findFirstOrThrow()).toMatchObject({
      status: 'UNRESOLVED',
    });
    // Not finished work (queued) is never a candidate either.
    await live.prisma.researchRun.create({
      data: {
        userId: uncertain.userId,
        requestedByTelegramUserId: BigInt(ADMIN_ID),
        chatId: BigInt(ADMIN_ID),
        sourceUpdateId: 999_001n,
        prompt: `queued ${MARKER}`,
        providerKind: 'fake',
        requestSnapshot: {},
        state: 'QUEUED',
        createdAt: new Date(clock.now().getTime() - 60 * DAY),
      },
    });
    advance(40 * DAY);
    const before = await accounting();
    await live.retention.runPass();
    expect((await run(uncertain.id)).contentPurgedAt).toBeNull();
    await reconcileUncertainRun(live.prisma, {
      runId: uncertain.id,
      resolution: 'PROVIDER_REQUEST_ABSENT',
      operator: 'op',
      note: 'checked',
    });
    await live.retention.runPass();
    expect((await run(uncertain.id)).contentPurgedAt).toBeNull(); // still UNRESOLVED

    // The locked recheck refuses it even when called directly (candidates already skip it).
    const owner = BigInt(ADMIN_ID);
    const cutoff = new Date(clock.now().getTime() - 30 * DAY);
    expect(await live.retention.purgeRun(uncertain.id, owner, cutoff)).toBe('NOT_ELIGIBLE');

    // Resolution racing with cleanup: while the resolution is uncommitted the run is
    // still protected; once it commits, the next pass purges it.
    const blocker = new Client({ connectionString: inject('databaseUrl') });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `UPDATE budget_reservation SET status = 'RESOLVED', confirmed_micros = 0, exposure_micros = 0
          WHERE run_id = $1`,
        [uncertain.id],
      );
      expect((await live.retention.runPass()).runs).toBe(0);
      expect((await run(uncertain.id)).contentPurgedAt).toBeNull();
      await blocker.query('COMMIT');
    } finally {
      await blocker.end();
    }
    expect((await live.retention.runPass()).runs).toBe(1);
    expect((await run(uncertain.id)).contentPurgedAt).toBeInstanceOf(Date);
    const after = await accounting();
    expect(after.ledger).toEqual(before.ledger);
    expect(after.attempts).toEqual(before.attempts);
    expect(after.reconciliations).toHaveLength(1);
    expect(
      await live.prisma.researchRun.count({ where: { state: 'QUEUED', contentPurgedAt: null } }),
    ).toBe(1);
  });

  it('keeps current-period exposure after a short-retention purge, so an exhausted budget stays exhausted', async () => {
    const live = await start({ REPORT_RETENTION_DAYS: '1' }, true);
    h = live;
    const r = await researched(`spend ${MARKER}`, live);
    expect(r.state).toBe('SUCCEEDED');
    const month = clock.now().toISOString().slice(0, 7);
    const exposure = () => live.prisma.$transaction((tx) => exposureMicros(tx, month));
    const before = await exposure();
    expect(before).toBeGreaterThan(0n);
    await say(`/admin limit ${ADMIN_ID} budget_usd 0.3`, ADMIN_ID, live);
    advance(DAY + 60_000);
    if (clock.now().toISOString().slice(0, 7) !== month) return; // the month just ended: nothing to assert
    expect((await live.retention.runPass()).runs).toBe(1);
    expect(await exposure()).toBe(before);
    await live.post(privateMessage('/research again')).expect(200);
    expect(
      (await live.prisma.telegramUpdate.findFirst({ orderBy: { updateId: 'desc' } }))?.reason,
    ).toBe('USER_BUDGET_EXHAUSTED');
  });

  it('deletes expired drafts and clears hashes of finished invitations only', async () => {
    await say('/new');
    await say(`Name ${MARKER}`);
    await say('/admin invite');
    const expired = randomUUID();
    const admin = await h.prisma.appUser.findUniqueOrThrow({
      where: { telegramUserId: BigInt(ADMIN_ID) },
    });
    await h.prisma.$executeRaw`
      INSERT INTO invitation (id, token_hash, created_by_user_id, created_at, expires_at)
      VALUES (${expired}::uuid, ${'a'.repeat(64)}, ${admin.id}::uuid, now() - interval '9 days', now() - interval '1 day')`;
    const pending = await h.prisma.invitation.findFirstOrThrow({ where: { id: { not: expired } } });
    advance(25 * 3_600_000);
    await h.retention.runPass();
    expect(await h.prisma.taskDraft.count()).toBe(0);
    expect(await h.prisma.invitation.findUniqueOrThrow({ where: { id: expired } })).toMatchObject({
      tokenHash: `cleared:${expired}`,
    });
    expect(
      (await h.prisma.invitation.findUniqueOrThrow({ where: { id: pending.id } })).tokenHash,
    ).toBe(pending.tokenHash);
    await say('/new');
    expect(lastText()).toContain('Надішліть назву');
  });

  it('keeps inbox and job replays harmless after metadata cleanup', async () => {
    const update = privateMessage('/research replayed');
    await h.post(update).expect(200);
    expect(await h.research.tick()).toBe(true);
    const r = await h.prisma.researchRun.findFirstOrThrow();
    advance(91 * DAY);
    const pass = await h.retention.runPass();
    expect(pass.updates).toBeGreaterThanOrEqual(1);
    // Reduced to a tombstone (review fix): the deduplication key stays, nothing else.
    expect(
      await h.prisma.telegramUpdate.findUniqueOrThrow({
        where: { updateId: BigInt(update.update_id) },
      }),
    ).toMatchObject({
      senderTelegramId: null,
      chatType: null,
      reason: null,
      runId: null,
      privateChatVerified: false,
    });
    expect(
      (
        await h.prisma.telegramUpdate.findUniqueOrThrow({
          where: { updateId: BigInt(update.update_id) },
        })
      ).metadataRedactedAt,
    ).toBeInstanceOf(Date);
    await h.post(update).expect(200); // Telegram redelivers the same update
    await h.prisma.$transaction((tx) =>
      h.queue.publish(tx, { runId: r.id, eventId: randomUUID() }),
    );
    expect(await h.research.tick()).toBe(false);
    expect(await h.prisma.researchRun.count()).toBe(1);
    expect(h.provider.calls.submit).toBe(1);
    const jobs = await h.prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = '${RESEARCH_QUEUE}'`,
    );
    expect(jobs[0]?.n).toBeGreaterThanOrEqual(2);
  });

  it('keeps the restoration evidence a pending recorded block still needs', async () => {
    const delivery = await h.prisma.delivery.create({
      data: {
        kind: 'STATUS',
        chatId: BigInt(ADMIN_ID),
        state: 'PERMANENT_FAILURE',
        lastErrorCode: 'TELEGRAM_403',
        destinationBlockReason: 'BOT_BLOCKED',
        destinationRefusedAt: new Date(Date.now() - 1_000),
        parts: { create: [{ ordinal: 0, html: 'x', contentHash: 'x', state: 'FAILED' }] },
      },
    });
    await h.post(privateMessage('/help')).expect(200); // verified, after the refusal
    await h.post(privateMessage('/help', OTHER_ADMIN_ID)).expect(200);
    advance(91 * DAY);
    await h.retention.runPass();
    expect(
      await h.prisma.telegramUpdate.count({ where: { senderTelegramId: BigInt(ADMIN_ID) } }),
    ).toBe(1);
    expect(
      await h.prisma.telegramUpdate.count({ where: { senderTelegramId: BigInt(OTHER_ADMIN_ID) } }),
    ).toBe(0);
    expect(
      await h.prisma.telegramUpdate.count({ where: { metadataRedactedAt: { not: null } } }),
    ).toBe(1);
    expect(await h.prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject(
      {
        destinationBlockAppliedAt: null,
      },
    );
    expect(await applyRecordedBlock(h.prisma, delivery.id)).toMatchObject({ superseded: true });
  });

  it('is idempotent across concurrent cleaners and a restart', async () => {
    const ids = [];
    for (let i = 0; i < 6; i += 1) ids.push((await researched(`n${i} ${MARKER}`)).id);
    await drainDeliveries(h);
    const second = await start();
    advance(31 * DAY);
    const [a, b] = await Promise.all([h.retention.runPass(), second.retention.runPass()]);
    expect(a.runs + b.runs).toBe(6);
    const stamps = await h.prisma.researchRun.findMany({ select: { contentPurgedAt: true } });
    expect(stamps.every((row) => row.contentPurgedAt)).toBe(true);
    await close(second);
    const restarted = await start();
    const again = await restarted.retention.runPass();
    expect(again.runs + again.deliveries).toBe(0);
    expect(await h.prisma.researchRun.findMany({ select: { contentPurgedAt: true } })).toEqual(
      stamps,
    );
    expect(await markerCopies()).toEqual([]);
  });

  describe('review fixes (commit 979352d)', () => {
    let sourceUpdate = 880_000;
    /** An old finished run inserted directly (fake unless stated), completed `ageDays` ago. */
    const oldRun = async (
      ageDays: number,
      kind: 'eligible' | 'uncertain' | 'busy',
    ): Promise<string> => {
      const owner = await h.prisma.appUser.findUniqueOrThrow({
        where: { telegramUserId: BigInt(ADMIN_ID) },
      });
      const completedAt = new Date(clock.now().getTime() - ageDays * DAY);
      const created = await h.prisma.researchRun.create({
        data: {
          userId: owner.id,
          requestedByTelegramUserId: BigInt(ADMIN_ID),
          chatId: BigInt(ADMIN_ID),
          sourceUpdateId: BigInt((sourceUpdate += 1)),
          prompt: `${kind} ${MARKER}`,
          providerKind: kind === 'uncertain' ? 'openai' : 'fake',
          requestSnapshot: { config: { timeZone: 'Europe/Kyiv' } },
          state: kind === 'uncertain' ? 'UNCERTAIN' : 'SUCCEEDED',
          failureCode: kind === 'uncertain' ? 'SUBMISSION_INTERRUPTED' : null,
          outcome: kind === 'uncertain' ? null : 'FOUND',
          reportText: `report ${MARKER}`,
          createdAt: completedAt,
          completedAt,
        },
      });
      if (kind === 'busy') {
        await h.prisma.delivery.create({
          data: {
            kind: 'REPORT',
            runId: created.id,
            chatId: BigInt(ADMIN_ID),
            state: 'SENDING',
            leaseOwner: 'live-worker',
            leaseUntil: new Date(Date.now() + 3_600_000),
            parts: {
              create: [{ ordinal: 0, html: `part ${MARKER}`, contentHash: 'x', state: 'SENDING' }],
            },
          },
        });
      }
      return created.id;
    };
    const purgedIds = async (ids: string[]) =>
      (
        await h.prisma.researchRun.findMany({
          where: { id: { in: ids }, contentPurgedAt: { not: null } },
          select: { id: true },
        })
      ).map((row) => row.id);

    describe('Finding 1: protected or busy runs do not starve cleanup', () => {
      it('purges newer eligible runs past a full batch of protected and busy ones, in bounded passes', async () => {
        const small = await start({ RETENTION_BATCH_SIZE: '2' });
        const protectedIds = [await oldRun(60, 'uncertain'), await oldRun(59, 'uncertain')];
        const busyIds = [await oldRun(58, 'busy'), await oldRun(57, 'busy')];
        const eligible = [];
        for (let i = 0; i < 5; i += 1) eligible.push(await oldRun(40 - i, 'eligible'));

        for (let pass = 0; pass < 3; pass += 1) {
          const result = await small.retention.runPass();
          expect(result.runs).toBeLessThanOrEqual(2); // bounded
        }
        expect((await purgedIds(eligible)).sort()).toEqual([...eligible].sort());
        expect(await purgedIds([...protectedIds, ...busyIds])).toEqual([]);
        for (const id of protectedIds) {
          expect(await run(id)).toMatchObject({
            prompt: `uncertain ${MARKER}`,
            reconciledAt: null,
          });
        }

        // Legitimate resolution and completion make them eligible again.
        await reconcileUncertainRun(h.prisma, {
          runId: protectedIds[0] ?? '',
          resolution: 'PROVIDER_REQUEST_ABSENT',
          operator: 'op',
          note: 'checked',
        });
        await h.prisma.$executeRaw`
          UPDATE delivery SET state = 'SENT', lease_owner = NULL, lease_until = NULL
           WHERE run_id = ${busyIds[0]}::uuid`;
        await h.prisma.$executeRaw`
          UPDATE delivery_part SET state = 'SENT', telegram_message_id = 55
           WHERE delivery_id IN (SELECT id FROM delivery WHERE run_id = ${busyIds[0]}::uuid)`;
        await small.retention.runPass();
        expect((await purgedIds([...protectedIds, ...busyIds])).sort()).toEqual(
          [protectedIds[0] ?? '', busyIds[0] ?? ''].sort(),
        );
        expect(await run(protectedIds[1] ?? '')).toMatchObject({ contentPurgedAt: null });
      });

      it('keeps progress and idempotency across two cleaners and a restart', async () => {
        const a = await start({ RETENTION_BATCH_SIZE: '2' });
        const b = await start({ RETENTION_BATCH_SIZE: '2' });
        for (let i = 0; i < 2; i += 1) await oldRun(80 - i, 'uncertain');
        const eligible = [];
        for (let i = 0; i < 6; i += 1) eligible.push(await oldRun(50 - i, 'eligible'));
        let purged = 0;
        for (let pass = 0; pass < 3; pass += 1) {
          const [x, y] = await Promise.all([a.retention.runPass(), b.retention.runPass()]);
          purged += x.runs + y.runs;
        }
        expect(purged).toBe(6);
        expect((await purgedIds(eligible)).length).toBe(6);
        await close(a);
        await close(b);
        const restarted = await start({ RETENTION_BATCH_SIZE: '2' });
        expect((await restarted.retention.runPass()).runs).toBe(0);
      });
    });

    describe('Finding 2: replay protection outlives inbox metadata', () => {
      const MEMBER = 3003;
      const addMember = () =>
        h.prisma.$executeRaw`
          INSERT INTO app_user (id, telegram_user_id, private_chat_id, role, onboarding_state, time_zone,
                                invited_at, onboarded_at, updated_at)
          VALUES (gen_random_uuid(), ${MEMBER}, ${MEMBER}, 'MEMBER', 'COMPLETED', 'Europe/Kyiv', now(), now(), now())`;
      const work = async () => ({
        runs: await h.prisma.researchRun.count(),
        reservations: await h.prisma.budgetReservation.count(),
        outbox: await h.prisma.outboxEvent.count(),
        submissions: h.provider.calls.submit,
      });
      const expireMetadata = async () => {
        advance(91 * DAY);
        await h.retention.runPass();
      };

      it('never executes a replayed denied /research after its metadata expired', async () => {
        await addMember();
        await say(`/admin limit ${MEMBER} daily_runs 0`);
        const denied = privateMessage('/research denied before', MEMBER);
        await h.post(denied).expect(200);
        expect(
          (
            await h.prisma.telegramUpdate.findUniqueOrThrow({
              where: { updateId: BigInt(denied.update_id) },
            })
          ).reason,
        ).toBe('DAILY_RUN_LIMIT');
        const before = await work();
        expect(before.runs).toBe(0);
        await expireMetadata();
        await say(`/admin limit ${MEMBER} daily_runs default`); // research would be allowed now
        await h.post(denied).expect(200); // Telegram redelivers the old update
        await h.research.tick();
        expect(await work()).toEqual(before);
        // A genuinely new update still works.
        await h.post(privateMessage('/research fresh', MEMBER)).expect(200);
        expect(await h.prisma.researchRun.count()).toBe(1);
      });

      it('never re-executes old administrator commands after metadata cleanup', async () => {
        await addMember();
        const first = privateMessage(`/admin limit ${MEMBER} tasks 5`);
        await h.post(first).expect(200);
        await say(`/admin limit ${MEMBER} tasks 7`);
        const invite = privateMessage('/admin invite');
        await h.post(invite).expect(200);
        const suspend = privateMessage(`/admin suspend ${MEMBER}`);
        await h.post(suspend).expect(200);
        await say(`/admin reactivate ${MEMBER}`);
        const audits = await h.prisma.auditEvent.count();
        await expireMetadata();
        for (const update of [first, invite, suspend]) await h.post(update).expect(200);
        await drainDeliveries(h);
        const member = await h.prisma.appUser.findUniqueOrThrow({
          where: { telegramUserId: BigInt(MEMBER) },
        });
        expect(member).toMatchObject({ limitSavedTasks: 7, status: 'ACTIVE' });
        expect(await h.prisma.invitation.count()).toBe(1);
        expect(await h.prisma.auditEvent.count()).toBe(audits);
      });

      it('stays safe when cleanup and a replay race', async () => {
        await addMember();
        await say(`/admin limit ${MEMBER} daily_runs 0`);
        const denied = privateMessage('/research raced', MEMBER);
        await h.post(denied).expect(200);
        await say(`/admin limit ${MEMBER} daily_runs default`);
        advance(91 * DAY);
        const blocker = new Client({ connectionString: inject('databaseUrl') });
        await blocker.connect();
        try {
          // The cleaner's statement is held on the inbox row while Telegram redelivers it.
          await blocker.query('BEGIN');
          await blocker.query(
            'SELECT update_id FROM telegram_update WHERE update_id = $1 FOR UPDATE',
            [denied.update_id],
          );
          const cleaning = h.retention.runPass();
          const replay = h.post(denied).then((response) => response.status);
          await blocker.query('COMMIT');
          expect(await replay).toBe(200);
          await cleaning;
        } finally {
          await blocker.end();
        }
        await h.post(denied).expect(200);
        await h.research.tick();
        expect(await h.prisma.researchRun.count()).toBe(0);
        expect(h.provider.calls.submit).toBe(0);
      });
    });
  });

  describe('races with delivery and resend', () => {
    it('skips a run whose delivery is in flight, keeps the confirmed send, then purges', async () => {
      const r = await researched();
      const report = await h.prisma.delivery.findFirstOrThrow({
        where: { runId: r.id, kind: 'REPORT' },
      });
      const ack = await h.prisma.delivery.findFirstOrThrow({
        where: { runId: r.id, kind: 'STATUS' },
      });
      expect(await h.delivery.handle(ack.id)).toBe('sent');
      const inFlight = gate();
      const release = gate();
      h.sender.beforeSend = async () => {
        inFlight.open();
        await release.promise;
      };
      const sending = h.delivery.handle(report.id);
      await inFlight.promise;
      advance(31 * DAY);
      // Not a candidate while being sent; the locked recheck reports BUSY if called directly.
      await h.retention.runPass();
      expect(
        await h.retention.purgeRun(
          r.id,
          BigInt(ADMIN_ID),
          new Date(clock.now().getTime() - 30 * DAY),
        ),
      ).toBe('BUSY');
      expect((await run(r.id)).contentPurgedAt).toBeNull();
      release.open();
      expect(await sending).toBe('sent');
      h.sender.beforeSend = () => Promise.resolve();
      const sent = await h.prisma.deliveryPart.findFirstOrThrow({
        where: { deliveryId: report.id },
      });
      expect((await h.retention.runPass()).runs).toBe(1);
      expect(
        await h.prisma.deliveryPart.findFirstOrThrow({ where: { deliveryId: report.id } }),
      ).toMatchObject({
        state: 'SENT',
        telegramMessageId: sent.telegramMessageId,
        html: '',
      });
    });

    it('finalizes waiting copies whose content expired, including a resend, and unblocks the chat', async () => {
      const r = await researched();
      await drainDeliveries(h);
      await h.post(privateMessage(`/result ${r.id}`)).expect(200); // resend queued, not sent
      await h.post(privateMessage('/help')).expect(200); // a later message to the same chat
      h.sender.sent.length = 0;
      h.sender.attempts.length = 0;
      advance(31 * DAY);
      await h.retention.runPass();
      expect(await h.prisma.delivery.findFirstOrThrow({ where: { kind: 'RESEND' } })).toMatchObject(
        {
          state: 'SUPPRESSED',
          lastErrorCode: 'CONTENT_EXPIRED',
        },
      );
      await drainDeliveries(h);
      expect(h.sender.sent.map((m) => visible(m.html))).toEqual([
        expect.stringContaining('/history'),
      ]);
      expect(h.sender.attempts.some((a) => a.html.includes(REPORT_TITLE))).toBe(false);
    });

    it('serializes with an explicit resend through the owner identity lock', async () => {
      const r = await researched();
      await drainDeliveries(h);
      advance(31 * DAY);
      const blocker = new Client({ connectionString: inject('databaseUrl') });
      await blocker.connect();
      try {
        // An inbox transaction of the owner (e.g. /result) is in progress.
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock(30030, hashtext($1))', [
          String(ADMIN_ID),
        ]);
        const cleaning = h.retention.runPass();
        await vi.waitFor(
          async () => {
            const rows = await blocker.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event = 'advisory'`,
            );
            expect(rows.rows[0]?.n).toBe(1);
          },
          { timeout: 10_000 },
        );
        expect((await run(r.id)).contentPurgedAt).toBeNull();
        await blocker.query('COMMIT');
        expect((await cleaning).runs).toBe(1);
      } finally {
        await blocker.end();
      }
      await say(`/result ${r.id}`);
      expect(lastText()).toContain('більше недоступний');
    });
  });

  describe('upgrade with retained records from earlier tasks', () => {
    it('adds the TRB-090 schema without changing records, and cleanup honours their exceptions', async () => {
      const serverUrl = new URL(inject('databaseUrl'));
      const database = disposableDatabaseName();
      const url = withDatabase(serverUrl, database);
      const admin = new Client({ connectionString: withDatabase(serverUrl, 'postgres') });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${database}"`);
      const client = new Client({ connectionString: url });
      try {
        await client.connect();
        const dir = 'prisma/migrations';
        const migrations = readdirSync(dir)
          .filter((name) => /^\d{14}_/.test(name))
          .sort();
        const trb090 = migrations.indexOf('20261021150000_trb_090_admin_retention');
        expect(trb090).toBeGreaterThan(0);
        for (const name of migrations.slice(0, trb090)) {
          await client.query(readFileSync(join(dir, name, 'migration.sql'), 'utf8'));
        }
        const old = new Date(Date.now() - 60 * DAY).toISOString();
        const user = '00000000-0000-4000-8000-000000000001';
        await client.query(
          `INSERT INTO app_user (id, telegram_user_id, private_chat_id, role, onboarding_state, time_zone, onboarded_at, updated_at)
           VALUES ($1, 1001, 1001, 'ADMIN', 'COMPLETED', 'Europe/Kyiv', now(), now())`,
          [user],
        );
        const runs = {
          unknown: '00000000-0000-4000-8000-0000000000a1',
          unresolved: '00000000-0000-4000-8000-0000000000a2',
        };
        for (const [key, id] of Object.entries(runs)) {
          await client.query(
            `INSERT INTO research_run (id, requested_by_telegram_user_id, user_id, chat_id, source_update_id, state, prompt,
                                       provider_kind, request_snapshot, report_text, outcome, submission_state,
                                       provider_response_id, failure_code, completed_at, created_at, updated_at, admitted_day, admitted_month)
             VALUES ($1, 1001, $2, 1001, $3, $4, 'old ${MARKER}', $5, '{"config":{"timeZone":"Europe/Kyiv"},"request":{"x":"${MARKER}"}}',
                     'report ${MARKER}', $6, 'SUBMITTED', $7, $9, $8, $8, $8, '2026-08-01', '2026-08')`,
            [
              id,
              user,
              key === 'unknown' ? 5001 : 5002,
              key === 'unknown' ? 'SUCCEEDED' : 'UNCERTAIN',
              key === 'unknown' ? 'fake' : 'openai',
              key === 'unknown' ? 'FOUND' : null,
              `resp_${key}`,
              old,
              key === 'unknown' ? null : 'SUBMISSION_INTERRUPTED',
            ],
          );
        }
        await client.query(`
          INSERT INTO pricing_version (version, model, content, content_hash) VALUES ('p1', 'm', '{}', 'h');
          INSERT INTO budget_reservation (id, run_id, user_id, period_month, status, reserved_micros, exposure_micros,
                                          pricing_version, policy_version, policy, updated_at)
          VALUES (gen_random_uuid(), '${runs.unresolved}', '${user}', '2026-08', 'UNRESOLVED', 100, 100, 'p1', 'v1', '{}', now());
          INSERT INTO delivery (id, run_id, kind, chat_id, state, last_error_code, updated_at)
          VALUES ('00000000-0000-4000-8000-0000000000d1', '${runs.unknown}', 'REPORT', 1001, 'UNKNOWN', 'TELEGRAM_NETWORK', '${old}'),
                 ('00000000-0000-4000-8000-0000000000d2', '${runs.unknown}', 'RESEND', 1001, 'SENT', NULL, '${old}');
          INSERT INTO delivery (id, kind, chat_id, state, suppressed_at, last_error_code, updated_at)
          VALUES ('00000000-0000-4000-8000-0000000000d3', 'STATUS', 1001, 'SUPPRESSED', '${old}', 'RECIPIENT_SUSPENDED', '${old}');
          INSERT INTO delivery (id, kind, chat_id, state, last_error_code, destination_block_reason, destination_refused_at, updated_at)
          VALUES ('00000000-0000-4000-8000-0000000000d4', 'STATUS', 1001, 'PERMANENT_FAILURE', 'TELEGRAM_403', 'BOT_BLOCKED', '${old}', '${old}');
          INSERT INTO delivery_part (delivery_id, ordinal, kind, html, file_name, file_content, content_hash, state, telegram_message_id)
          VALUES ('00000000-0000-4000-8000-0000000000d1', 0, 'MESSAGE', 'part ${MARKER}', NULL, NULL, 'h1', 'UNKNOWN', NULL),
                 ('00000000-0000-4000-8000-0000000000d1', 1, 'DOCUMENT', 'caption', 'report.txt', 'file ${MARKER}', 'h2', 'PENDING', NULL),
                 ('00000000-0000-4000-8000-0000000000d2', 0, 'DOCUMENT', 'caption', 'report.txt', 'file ${MARKER}', 'h2', 'SENT', 777),
                 ('00000000-0000-4000-8000-0000000000d3', 0, 'MESSAGE', 'suppressed', NULL, NULL, 'h3', 'PENDING', NULL),
                 ('00000000-0000-4000-8000-0000000000d4', 0, 'MESSAGE', 'refused', NULL, NULL, 'h4', 'FAILED', NULL);
        `);
        type Row = Record<string, unknown>;
        const rowsOf = async (sql: string) => (await client.query<Row>(sql)).rows;
        const snapshotRows = async () => ({
          runs: await rowsOf(
            'SELECT id, state, prompt, report_text, request_snapshot FROM research_run ORDER BY id',
          ),
          parts: await rowsOf(
            'SELECT delivery_id, ordinal, html, file_content, state, telegram_message_id FROM delivery_part ORDER BY 1, 2',
          ),
          deliveries: await rowsOf(
            'SELECT id, state, last_error_code, suppressed_at, destination_block_reason, destination_block_applied_at FROM delivery ORDER BY id',
          ),
          reservations: await rowsOf('SELECT status, exposure_micros FROM budget_reservation'),
        });
        const before = await snapshotRows();
        await client.query(
          readFileSync(join(dir, migrations[trb090] ?? '', 'migration.sql'), 'utf8'),
        );
        expect(await snapshotRows()).toEqual(before);
        for (const name of migrations.slice(trb090 + 1)) {
          await client.query(readFileSync(join(dir, name, 'migration.sql'), 'utf8'));
        }

        // A cleanup pass on the upgraded database (disposable; never the development data).
        const upgraded = await startHarness({}, { clock, databaseUrl: url });
        try {
          await upgraded.retention.runPass();
        } finally {
          await upgraded.close();
        }
        const after = await snapshotRows();
        const purgedRun = after.runs.find((row) => row.id === runs.unknown);
        expect(purgedRun).toMatchObject({ prompt: REDACTED, report_text: null });
        expect(purgedRun?.request_snapshot).toEqual({ config: { timeZone: 'Europe/Kyiv' } });
        expect(after.runs.find((row) => row.id === runs.unresolved)).toMatchObject({
          prompt: `old ${MARKER}`,
        });
        expect(
          after.parts.filter(
            (row) =>
              String(row.delivery_id).endsWith('d1') || String(row.delivery_id).endsWith('d2'),
          ),
        ).toEqual([
          expect.objectContaining({ ordinal: 0, html: '', file_content: null, state: 'UNKNOWN' }),
          expect.objectContaining({ ordinal: 1, html: '', file_content: null, state: 'PENDING' }),
          expect.objectContaining({
            ordinal: 0,
            html: '',
            file_content: null,
            state: 'SENT',
            telegram_message_id: '777',
          }),
        ]);
        expect(after.deliveries.map((row) => [String(row.id).slice(-2), row.state])).toEqual([
          ['d1', 'UNKNOWN'],
          ['d2', 'SENT'],
          ['d3', 'SUPPRESSED'],
          ['d4', 'PERMANENT_FAILURE'],
        ]);
        expect(after.reservations).toEqual(before.reservations);
        const blocked = await resolveBlockStillPending(client);
        expect(blocked).toBe(true);
      } finally {
        await client.end();
        await admin
          .query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
          .catch(() => undefined);
        await admin.end();
      }
    });
  });
});

/** The recorded refusal of the upgraded database is still pending after cleanup. */
async function resolveBlockStillPending(client: Client): Promise<boolean> {
  const rows = await client.query<{ pending: boolean }>(
    `SELECT destination_block_applied_at IS NULL AS pending FROM delivery
      WHERE id = '00000000-0000-4000-8000-0000000000d4'`,
  );
  return rows.rows[0]?.pending ?? false;
}
