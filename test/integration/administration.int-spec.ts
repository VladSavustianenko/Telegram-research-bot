import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { correctResolution, resolveRun } from '../../src/accounting/ledger';
import { APP_CONFIG } from '../../src/config/config.module';
import type { Env } from '../../src/config/env.schema';
import { runAdminCallback, runAdminCommand } from '../../src/identity/admin-actions';
import { ProviderError } from '../../src/research/provider/provider.types';
import {
  adminAccessCallbackData,
  adminUserCallbackData,
  adminUsersCallbackData,
  compactId,
} from '../../src/telegram/callback-data';
import { FakeClock, ScriptedProvider, completed, echoed, snapshot } from '../support/fakes';
import { buildTextPart } from '../../src/research/provider/fake-fixtures';
import { LIVE_TEST_ENV, TEST_RESERVATION_MICROS } from '../support/live-env';
import {
  ADMIN_ID,
  OTHER_ADMIN_ID,
  callbackQuery,
  drainDeliveries,
  groupMessage,
  privateMessage,
  resetDatabase,
  startHarness,
  type Harness,
} from '../support/research-harness';

const MEMBER = 3003;
const SECRET = 'SECRET-CONTENT-7f3a';

const visible = (html: string) =>
  html
    .replace(/<\/?(?:b|i|code|a)(?:\s[^>]*)?>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

describe('TRB-090 administration and effective limits (real PostgreSQL)', () => {
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

  beforeEach(async () => {
    clock = new FakeClock(new Date('2026-10-19T05:00:00Z'));
    h = await start();
    await resetDatabase(h.prisma);
    await h.prisma.$executeRaw`
      INSERT INTO app_user (id, telegram_user_id, private_chat_id, role, onboarding_state, time_zone,
                            invited_at, onboarded_at, updated_at)
      VALUES (gen_random_uuid(), ${MEMBER}, ${MEMBER}, 'MEMBER', 'COMPLETED', 'Europe/Kyiv', now(), now(), now())`;
  });

  afterEach(async () => {
    for (const harness of open.splice(0)) await harness.close();
  });

  const say = async (text: string, from = ADMIN_ID, harness = h) => {
    await harness.post(privateMessage(text, from)).expect(200);
    await drainDeliveries(harness);
    return visible(harness.sender.sent.filter((m) => m.chatId === BigInt(from)).at(-1)?.html ?? '');
  };
  const press = async (data: string, from = ADMIN_ID, harness = h) => {
    await harness.post(callbackQuery(data, from)).expect(200);
    await drainDeliveries(harness);
    return visible(harness.sender.sent.filter((m) => m.chatId === BigInt(from)).at(-1)?.html ?? '');
  };
  const user = (telegramId: number) =>
    h.prisma.appUser.findUniqueOrThrow({ where: { telegramUserId: BigInt(telegramId) } });
  const lastReason = async () =>
    (await h.prisma.telegramUpdate.findFirst({ orderBy: { updateId: 'desc' } }))?.reason;
  const research = async (from: number, harness = h) => {
    await harness.post(privateMessage(`/research topic ${from}`, from)).expect(200);
    return lastReason();
  };
  const finishAll = async (harness = h) => {
    while (await harness.research.tick()) {
      /* drain the research queue */
    }
  };

  describe('authorization', () => {
    it('hides every admin command from members, revoked administrators and groups', async () => {
      for (const command of [
        '/admin users',
        '/admin user 3003',
        '/admin usage',
        '/admin limit 3003 tasks 1',
      ]) {
        expect(await say(command, MEMBER)).toBe('Невідома команда. /help - довідка.');
      }
      // Removed from ADMIN_TELEGRAM_IDS: the stored role no longer counts.
      const revoked = await start({ ADMIN_TELEGRAM_IDS: `${ADMIN_ID}` });
      expect(await say('/admin users', OTHER_ADMIN_ID, revoked)).toBe(
        'Цей бот приватний. Доступ лише за запрошенням.',
      );
      // Group chats are ignored before routing; nothing is sent or changed.
      const before = h.sender.sent.length;
      await h.post(groupMessage('/admin limit 3003 tasks 1', ADMIN_ID)).expect(200);
      await drainDeliveries(h);
      expect(h.sender.sent).toHaveLength(before);
      expect((await user(MEMBER)).limitSavedTasks).toBeNull();
      expect(await h.prisma.auditEvent.count({ where: { kind: 'LIMIT_CHANGED' } })).toBe(0);
    });

    it('authorizes in the service layer, not only in routing', async () => {
      const member = await user(MEMBER);
      const config = h.app.get<Env>(APP_CONFIG);
      await h.prisma.$transaction(async (tx) => {
        const command = await runAdminCommand(tx, config, {
          actor: member,
          chatId: BigInt(MEMBER),
          args: 'limit 3003 tasks 99',
        });
        expect(command).toMatchObject({ disposition: 'REJECTED', reason: 'NOT_ADMIN' });
        const callback = await runAdminCallback(tx, config, {
          actor: member,
          chatId: BigInt(MEMBER),
          now: clock.now(),
          action: {
            kind: 'admin_access',
            userId: member.id,
            revision: member.revision,
            op: 'suspend',
          },
        });
        expect(callback).toMatchObject({ disposition: 'REJECTED', reason: 'NOT_ADMIN' });
      });
      expect((await user(MEMBER)).limitSavedTasks).toBeNull();
      expect((await user(MEMBER)).status).toBe('ACTIVE');
    });

    it('fails safely on member, foreign, stale, malformed and duplicate admin buttons', async () => {
      const member = await user(MEMBER);
      // A member pressing an admin button changes nothing and learns nothing.
      await h
        .post(callbackQuery(adminAccessCallbackData(member.id, member.revision, 'suspend'), MEMBER))
        .expect(200);
      await h.post(callbackQuery(adminUsersCallbackData(0), MEMBER)).expect(200);
      expect((await user(MEMBER)).status).toBe('ACTIVE');
      // Malformed and unknown IDs.
      await press('ax:!!!:1:s');
      await press(adminUserCallbackData('11111111-2222-4333-8444-555555555555'));
      expect(await lastReason()).toBe('CALLBACK_STALE');
      // Stale revision: shows the current view, suspends nothing.
      expect(
        await press(adminAccessCallbackData(member.id, member.revision + 5, 'suspend')),
      ).toContain('Дані змінилися');
      expect((await user(MEMBER)).status).toBe('ACTIVE');
      // The same Telegram update twice: one suspension, one audit event.
      const update = callbackQuery(adminAccessCallbackData(member.id, member.revision, 'suspend'));
      await h.post(update).expect(200);
      await h.post(update).expect(200);
      await drainDeliveries(h);
      expect((await user(MEMBER)).status).toBe('SUSPENDED');
      expect(await h.prisma.auditEvent.count({ where: { kind: 'USER_SUSPENDED' } })).toBe(1);
      // The old button is stale now; an administrator target is protected.
      await press(adminAccessCallbackData(member.id, member.revision, 'suspend'));
      expect(await h.prisma.auditEvent.count({ where: { kind: 'USER_SUSPENDED' } })).toBe(1);
      const admin = await user(OTHER_ADMIN_ID);
      expect(await press(adminAccessCallbackData(admin.id, admin.revision, 'suspend'))).toContain(
        'Адміністратора не можна призупинити',
      );
      expect((await user(OTHER_ADMIN_ID)).status).toBe('ACTIVE');
    });
  });

  describe('views contain operational metadata only', () => {
    it('never shows prompts, task text, reports, documents or invitation secrets', async () => {
      const memberId = (await user(MEMBER)).id;
      await h.prisma.task.create({
        data: {
          userId: memberId,
          name: `Task ${SECRET}`,
          prompt: `Prompt ${SECRET}`,
          scheduleKind: 'MANUAL',
          timeZone: 'Europe/Kyiv',
        },
      });
      h.provider.onRetrieve = (id) =>
        Promise.resolve({
          ...completed([
            buildTextPart([
              `OUTCOME: FOUND\nReport ${SECRET}`,
              { cite: { url: 'https://a.example/', title: `Title ${SECRET}` } },
            ]),
          ]),
          id,
          bounds: echoed(h.provider.echo),
        });
      await h.post(privateMessage(`/research ${SECRET}`, MEMBER)).expect(200);
      await finishAll();
      await say('/admin invite');
      const invitationMessage = h.sender.sent.at(-1)?.html ?? '';
      const token = /start[= ]([A-Za-z0-9_-]{43})/.exec(invitationMessage)?.[1] ?? '';
      expect(token).toHaveLength(43);
      const hash = (await h.prisma.invitation.findFirstOrThrow()).tokenHash;

      const views = [
        await say('/admin users'),
        await say(`/admin user ${MEMBER}`),
        await press(adminUserCallbackData(memberId)),
        await say('/admin usage'),
        await say('/admin invites'),
        await say('/admin audit'),
        await say(`/admin limit ${MEMBER} tasks 3 support request`),
      ];
      for (const view of views) {
        expect(view).not.toContain(SECRET);
        expect(view).not.toContain(token);
        expect(view).not.toContain(hash);
      }
      expect(views[1]).toContain(`Користувач ${MEMBER}`);
      expect(views[1]).toContain('Завдання: збережених 1');
      expect(views[3]).toContain('Дослідження за 2026-10: усього 1; успішно 1');
      expect(views[4]).toContain('чинних 1');
    });
  });

  describe('effective limits', () => {
    it('applies overrides to manual admissions, keeps the manual quota off scheduled runs, and clears to defaults', async () => {
      expect(await say(`/admin limit ${MEMBER} daily_runs 1 trial`)).toContain('Ліміт змінено');
      expect(await research(MEMBER)).toBeNull();
      await finishAll();
      expect(await research(MEMBER)).toBe('DAILY_RUN_LIMIT');
      await drainDeliveries(h);
      expect(
        visible(h.sender.sent.filter((m) => m.chatId === BigInt(MEMBER)).at(-1)?.html ?? ''),
      ).toContain('(1 за добу UTC)');
      // Raising the total and setting a manual quota of 0.
      await say(`/admin limit ${MEMBER} daily_runs 10`);
      await say(`/admin limit ${MEMBER} manual_runs 0`);
      expect(await research(MEMBER)).toBe('DAILY_MANUAL_LIMIT');
      const memberId = (await user(MEMBER)).id;
      const task = await h.prisma.task.create({
        data: {
          userId: memberId,
          name: 'Daily',
          prompt: 'p',
          scheduleKind: 'DAILY',
          localTime: '09:00',
          timeZone: 'Europe/Kyiv',
          nextRunAt: new Date('2026-10-19T06:00:00Z'),
        },
      });
      clock.set('2026-10-19T06:00:10Z');
      await h.scheduler.tick();
      expect(
        await h.prisma.scheduleEvent.findFirstOrThrow({ where: { taskId: task.id } }),
      ).toMatchObject({
        disposition: 'ADMITTED',
      });
      // /usage shows the effective values.
      expect(await say('/usage', MEMBER)).toContain('з 10 (ручних: 1 з 0;');
      // Clearing returns to the environment default (100 in tests).
      expect(await say(`/admin limit ${MEMBER} manual_runs default`)).toContain(
        'ручних за добу: 100 (типово)',
      );
      const audits = await h.prisma.auditEvent.findMany({
        where: { kind: 'LIMIT_CHANGED' },
        orderBy: { createdAt: 'asc' },
      });
      expect(audits.map((event) => event.details)).toEqual([
        expect.objectContaining({
          limit: 'daily_runs',
          overrideBefore: null,
          overrideAfter: '1',
          effectiveBefore: '100',
          effectiveAfter: '1',
          reason: 'trial',
        }),
        expect.objectContaining({ limit: 'daily_runs', overrideBefore: '1', overrideAfter: '10' }),
        expect.objectContaining({ limit: 'manual_runs', overrideAfter: '0' }),
        expect.objectContaining({
          limit: 'manual_runs',
          overrideBefore: '0',
          overrideAfter: null,
          effectiveAfter: '100',
        }),
      ]);
      // A repeated value and a duplicate update add no audit events.
      await say(`/admin limit ${MEMBER} daily_runs 10`);
      const update = privateMessage(`/admin limit ${MEMBER} active_runs 2`);
      await h.post(update).expect(200);
      await h.post(update).expect(200);
      expect(await h.prisma.auditEvent.count({ where: { kind: 'LIMIT_CHANGED' } })).toBe(5);
      // Invalid values are refused.
      for (const bad of [
        'tasks -1',
        'tasks 1001',
        'budget_usd 1.1234567',
        'colour 3',
        'tasks many',
      ]) {
        expect(await say(`/admin limit ${MEMBER} ${bad}`)).toContain('Формат: /admin limit');
      }
    });

    it('lowers task limits without deleting tasks; only new operations are denied', async () => {
      for (let i = 0; i < 3; i += 1) {
        await h.prisma.task.create({
          data: {
            userId: (await user(MEMBER)).id,
            name: `T${i}`,
            prompt: 'p',
            scheduleKind: 'MANUAL',
            timeZone: 'Europe/Kyiv',
          },
        });
      }
      await say(`/admin limit ${MEMBER} tasks 1`);
      await say(`/admin limit ${MEMBER} active_runs 0`);
      expect(await h.prisma.task.count({ where: { userId: (await user(MEMBER)).id } })).toBe(3);
      expect(await say('/new', MEMBER)).toContain('Досягнуто ліміту збережених завдань (1)');
      expect(await research(MEMBER)).toBe('USER_ACTIVE_LIMIT');
      expect(await say('/tasks', MEMBER)).toContain('Ваші завдання: 3 з 1');
    });

    it('applies a lowered budget to admission and retry authorization without releasing exposure', async () => {
      const live = await start({ RESEARCH_SUBMISSION_RETRY_LIMIT: '1' }, true);
      h = live;
      // 0.284 per reservation. Admitted under a $1 override; lowered to $0.20 before the
      // provider's 429, so the retry's new reservation is refused by the override
      // (the environment default, $10, would allow it). The refused attempt is released.
      expect(await say(`/admin limit ${ADMIN_ID} budget_usd 1`, ADMIN_ID, live)).toContain(
        '$1.00 (перевизначено; типово $10.00)',
      );
      live.provider.onSubmit = () =>
        Promise.reject(
          new ProviderError('OPENAI_HTTP_429_rate_limit_exceeded', 'not_accepted', false, 1000),
        );
      expect(await research(ADMIN_ID, live)).toBeNull();
      await say(`/admin limit ${ADMIN_ID} budget_usd 0.2`, ADMIN_ID, live);
      await live.research.tick();
      const run = await live.prisma.researchRun.findFirstOrThrow();
      expect(run).toMatchObject({ state: 'FAILED' });
      expect(run.failureCode).toContain('RETRY_REFUSED:USER_BUDGET_EXHAUSTED');
      expect(await live.prisma.budgetReservation.count()).toBe(1);

      // A settled run's exposure stays when the budget is lowered below it.
      live.provider.onSubmit = (request) =>
        Promise.resolve(snapshot(request, { id: `resp_${request.runId}` }));
      await say(`/admin limit ${ADMIN_ID} budget_usd 1`, ADMIN_ID, live);
      expect(await research(ADMIN_ID, live)).toBeNull();
      await finishAll(live);
      const exposure = async () =>
        (await live.prisma.budgetReservation.aggregate({ _sum: { exposureMicros: true } }))._sum
          .exposureMicros;
      const before = await exposure();
      expect(before).toBeGreaterThan(0n);
      await say(`/admin limit ${ADMIN_ID} budget_usd 0`, ADMIN_ID, live);
      expect(await exposure()).toBe(before);
      expect(await research(ADMIN_ID, live)).toBe('USER_BUDGET_EXHAUSTED');
      expect(TEST_RESERVATION_MICROS).toBe(284_000n);
    });

    it('serializes a limit change with admission: a change committed first is respected', async () => {
      const memberId = (await user(MEMBER)).id;
      const blocker = new Client({ connectionString: inject('databaseUrl') });
      await blocker.connect();
      try {
        // A limit change in progress holds the member's row (as setLimitOverride does).
        await blocker.query('BEGIN');
        await blocker.query(
          'UPDATE app_user SET limit_daily_runs = 0, revision = revision + 1 WHERE id = $1',
          [memberId],
        );
        // supertest sends on subscription: start the request now.
        const admission = h
          .post(privateMessage('/research raced', MEMBER))
          .then((response) => response);
        await vi.waitFor(
          async () => {
            const rows = await blocker.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`,
            );
            expect(rows.rows[0]?.n).toBeGreaterThanOrEqual(1);
          },
          { timeout: 10_000 },
        );
        await blocker.query('COMMIT');
        expect((await admission).status).toBe(200);
      } finally {
        await blocker.end();
      }
      expect(await lastReason()).toBe('DAILY_RUN_LIMIT');
      expect(await h.prisma.researchRun.count()).toBe(0);
    });
  });

  describe('invitations and accounting corrections', () => {
    it('revokes an unredeemed invitation and suppresses its undelivered link', async () => {
      await h.post(privateMessage('/admin invite')).expect(200);
      const invitation = await h.prisma.invitation.findFirstOrThrow();
      expect(await say(`/admin revoke ${invitation.id}`)).toContain('відкликано');
      expect(
        await h.prisma.delivery.findFirstOrThrow({ where: { kind: 'INVITATION' } }),
      ).toMatchObject({
        state: 'SUPPRESSED',
        lastErrorCode: 'INVITATION_REVOKED',
      });
      expect(h.sender.sent.some((m) => m.html.includes('start='))).toBe(false);
      expect(await say(`/admin revoke ${invitation.id}`)).toContain('не знайдено, вже використане');
      expect(await h.prisma.auditEvent.count({ where: { kind: 'INVITATION_REVOKED' } })).toBe(1);
      expect(compactId(invitation.id)).toHaveLength(22);
    });

    it('corrects a resolved amount with an appended ledger entry and never rewrites history', async () => {
      const live = await start({}, true);
      h = live;
      await research(ADMIN_ID, live);
      await finishAll(live);
      const run = await live.prisma.researchRun.findFirstOrThrow();
      await live.prisma.$transaction((tx) =>
        resolveRun(tx, {
          runId: run.id,
          confirmedMicros: 50_000n,
          operator: 'op',
          note: 'invoice A',
        }),
      );
      const before = await live.prisma.usageLedger.findMany({ orderBy: { createdAt: 'asc' } });
      const corrected = await live.prisma.$transaction((tx) =>
        correctResolution(tx, {
          runId: run.id,
          confirmedMicros: 70_000n,
          operator: 'op',
          note: 'invoice B',
        }),
      );
      expect(corrected).toMatchObject({
        previousExposureMicros: 50_000n,
        exposureMicros: 70_000n,
        correction: 1,
      });
      const after = await live.prisma.usageLedger.findMany({ orderBy: { createdAt: 'asc' } });
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after.at(-1)).toMatchObject({
        kind: 'CORRECT',
        amountMicros: 20_000n,
        exposureAfterMicros: 70_000n,
      });
      expect(await live.prisma.budgetReservation.findFirstOrThrow()).toMatchObject({
        status: 'RESOLVED',
        exposureMicros: 70_000n,
        confirmedMicros: 70_000n,
      });
      await expect(
        live.prisma.$transaction((tx) =>
          correctResolution(tx, {
            runId: run.id,
            confirmedMicros: 70_000n,
            operator: 'op',
            note: 'again',
          }),
        ),
      ).rejects.toThrow('SAME_AMOUNT');
    });
  });
});
