import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env.schema';
import { bootstrapAdministrators } from '../../src/identity/users';
import { timeZoneCallbackData } from '../../src/telegram/callback-data';
import { ScriptedProvider, snapshot } from '../support/fakes';
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

const MEMBER_A = 3003;
const MEMBER_B = 3004;
const STRANGER = 3999;

const LIVE_ENV = {
  RESEARCH_MODE: 'live',
  OPENAI_API_KEY: 'sk-test-not-a-real-key',
  OPENAI_MODEL: 'operator-selected-model',
  OUTPUT_TOKEN_LIMIT: '3000',
  TOOL_CALL_LIMIT: '3',
  RUN_DEADLINE_SECONDS: '300',
};

describe('TRB-030 identity, invitations and authorization (fakes, real PostgreSQL)', () => {
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

  const sentTo = (harness: Harness, id: number) =>
    harness.sender.sent.filter((message) => message.chatId === BigInt(id));
  const lastTo = (harness: Harness, id: number) => sentTo(harness, id).at(-1);
  const buttons = (harness: Harness, id: number) =>
    lastTo(harness, id)
      ?.replyMarkup?.inline_keyboard.flat()
      .map((button) => button.callback_data) ?? [];
  const userOf = (id: number) =>
    h.prisma.appUser.findUnique({ where: { telegramUserId: BigInt(id) } });
  const reasons = async () =>
    (await h.prisma.telegramUpdate.findMany({ orderBy: { updateId: 'asc' } })).map((u) => u.reason);

  /** Admin creates an invitation; returns the token from the delivered link. */
  async function invite(harness = h, admin = ADMIN_ID): Promise<string> {
    await harness.post(privateMessage('/admin invite', admin)).expect(200);
    await drainDeliveries(harness);
    const token = /\?start=([A-Za-z0-9_-]{43})/.exec(lastTo(harness, admin)?.html ?? '')?.[1];
    if (!token) throw new Error('no invitation link delivered');
    return token;
  }

  /** Full onboarding of a member: invitation, redemption, time zone confirmation. */
  async function onboard(id: number, zone?: string): Promise<void> {
    const token = await invite();
    await h.post(privateMessage(`/start ${token}`, id)).expect(200);
    if (zone) await h.post(privateMessage(zone, id)).expect(200);
    await drainDeliveries(h);
    await h.post(callbackQuery(buttons(h, id)[0] ?? '', id)).expect(200);
    await drainDeliveries(h);
    expect((await userOf(id))?.onboardingState).toBe('COMPLETED');
  }

  describe('administrator bootstrap', () => {
    const configWith = (ids: string) =>
      parseEnv({ DATABASE_URL: 'postgresql://unused@localhost:1/x', ADMIN_TELEGRAM_IDS: ids });

    it('is idempotent, revokes removed administrators and never reactivates suspended users', async () => {
      await resetDatabase(h.prisma, { onboardedAdmins: false });
      const both = configWith(`${ADMIN_ID},${OTHER_ADMIN_ID}`);
      expect(await bootstrapAdministrators(h.prisma, both)).toMatchObject({ created: 2 });
      expect(await bootstrapAdministrators(h.prisma, both)).toMatchObject({
        created: 0,
        granted: 0,
        revoked: 0,
      });
      const users = await h.prisma.appUser.findMany({ orderBy: { telegramUserId: 'asc' } });
      expect(users.map((u) => [u.telegramUserId, u.role, u.status, u.onboardingState])).toEqual([
        [BigInt(ADMIN_ID), 'ADMIN', 'ACTIVE', 'AWAITING_TIME_ZONE'],
        [BigInt(OTHER_ADMIN_ID), 'ADMIN', 'ACTIVE', 'AWAITING_TIME_ZONE'],
      ]);
      expect(await h.prisma.invitation.count()).toBe(0);

      // Removed from the configuration: the role is revoked (record and status kept).
      expect(await bootstrapAdministrators(h.prisma, configWith(`${ADMIN_ID}`))).toMatchObject({
        revoked: 1,
      });
      expect((await userOf(OTHER_ADMIN_ID))?.role).toBe('MEMBER');

      // Suspended while not an administrator, then re-added: role back, still suspended.
      await h.prisma.appUser.update({
        where: { telegramUserId: BigInt(OTHER_ADMIN_ID) },
        data: { status: 'SUSPENDED', suspendedAt: new Date() },
      });
      expect(await bootstrapAdministrators(h.prisma, both)).toMatchObject({ granted: 1 });
      expect(await userOf(OTHER_ADMIN_ID)).toMatchObject({ role: 'ADMIN', status: 'SUSPENDED' });
      await h.post(privateMessage('/help', OTHER_ADMIN_ID)).expect(200);
      await h.post(privateMessage('/admin invite', OTHER_ADMIN_ID)).expect(200);
      expect(await h.prisma.invitation.count()).toBe(0);

      const audit = await h.prisma.auditEvent.findMany({ orderBy: { createdAt: 'asc' } });
      expect(audit.map((event) => event.kind)).toEqual([
        'ADMIN_GRANTED',
        'ADMIN_GRANTED',
        'ADMIN_REVOKED',
        'ADMIN_GRANTED',
      ]);
    });

    it('lets an administrator onboard without an invitation, and a removed one loses access', async () => {
      await resetDatabase(h.prisma, { onboardedAdmins: false });
      // Lazy bootstrap: the first update from a configured administrator creates the record.
      await h.post(privateMessage('/start', ADMIN_ID)).expect(200);
      await h.post(privateMessage('/research too early', ADMIN_ID)).expect(200);
      await drainDeliveries(h);
      expect(await h.prisma.researchRun.count()).toBe(0);
      expect(buttons(h, ADMIN_ID)).toEqual([timeZoneCallbackData(0, 'Europe/Kyiv')]);

      await h.post(callbackQuery(timeZoneCallbackData(0, 'Europe/Kyiv'), ADMIN_ID)).expect(200);
      expect(await userOf(ADMIN_ID)).toMatchObject({
        role: 'ADMIN',
        onboardingState: 'COMPLETED',
        timeZone: 'Europe/Kyiv',
        invitedAt: null,
      });
      await h.post(privateMessage('/research now', ADMIN_ID)).expect(200);
      expect(await h.prisma.researchRun.count()).toBe(1);
      expect(await h.prisma.invitation.count()).toBe(0);

      // Same record, configuration without this administrator: no account any more.
      const removed = await start({ ADMIN_TELEGRAM_IDS: `${OTHER_ADMIN_ID}` });
      await removed.post(privateMessage('/research again', ADMIN_ID)).expect(200);
      expect(await removed.prisma.researchRun.count()).toBe(1);
      expect(await userOf(ADMIN_ID)).toMatchObject({ role: 'MEMBER', status: 'ACTIVE' });
      await drainDeliveries(removed);
      expect(lastTo(removed, ADMIN_ID)?.html).toBe(
        'Цей бот приватний. Доступ лише за запрошенням.',
      );
    });
  });

  describe('invitations', () => {
    it('onboards an invited user through /start and time zone confirmation; the token is never stored', async () => {
      const token = await invite();
      await h.post(privateMessage(`/start ${token}`, MEMBER_A)).expect(200);
      await h.post(privateMessage('/research before onboarding', MEMBER_A)).expect(200);
      await h.post(privateMessage('Mars/Olympus', MEMBER_A)).expect(200);
      await h.post(privateMessage('america/new_york', MEMBER_A)).expect(200);
      await drainDeliveries(h);

      const member = await userOf(MEMBER_A);
      expect(member).toMatchObject({
        role: 'MEMBER',
        status: 'ACTIVE',
        onboardingState: 'AWAITING_TIME_ZONE',
        privateChatId: BigInt(MEMBER_A),
      });
      expect(await h.prisma.researchRun.count()).toBe(0);
      expect(lastTo(h, MEMBER_A)?.html).toBe('Підтвердити часовий пояс America/New_York?');
      expect(buttons(h, MEMBER_A)).toEqual([
        timeZoneCallbackData(member?.revision ?? -1, 'America/New_York'),
        timeZoneCallbackData(member?.revision ?? -1, 'Europe/Kyiv'),
      ]);
      // The inviting administrator learns the new user's Telegram ID, nothing else.
      expect(lastTo(h, ADMIN_ID)?.html).toBe(
        `Ваше запрошення використано. Telegram ID нового користувача: ${MEMBER_A}.`,
      );

      await h.post(callbackQuery(buttons(h, MEMBER_A)[0] ?? '', MEMBER_A)).expect(200);
      expect(await userOf(MEMBER_A)).toMatchObject({
        onboardingState: 'COMPLETED',
        timeZone: 'America/New_York',
      });
      expect(h.sender.callbackAnswers.at(-1)?.text).toBe(
        'Часовий пояс підтверджено: America/New_York.',
      );

      // Fake research works; the run uses the confirmed zone.
      await h.post(privateMessage('/research football', MEMBER_A)).expect(200);
      await h.research.tick();
      await drainDeliveries(h);
      const [run] = await h.prisma.researchRun.findMany();
      expect(run).toMatchObject({ state: 'SUCCEEDED', userId: member?.id });
      expect(run?.requestSnapshot).toMatchObject({ context: { timeZone: 'America/New_York' } });
      expect(sentTo(h, MEMBER_A).some((m) => m.html.includes('Результат дослідження'))).toBe(true);

      // Invitation audit, and no table or log contains the token.
      const invitation = await h.prisma.invitation.findFirstOrThrow();
      expect(invitation.redeemedByUserId).toBe(member?.id);
      expect(
        (await h.prisma.auditEvent.findMany({ orderBy: { createdAt: 'asc' } })).map((e) => e.kind),
      ).toEqual(['INVITATION_CREATED', 'INVITATION_REDEEMED']);
      const dump = JSON.stringify(
        await Promise.all([
          h.prisma.invitation.findMany(),
          h.prisma.deliveryPart.findMany(),
          h.prisma.telegramUpdate.findMany(),
          h.prisma.auditEvent.findMany(),
          h.prisma.appUser.findMany(),
        ]),
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );
      expect(dump).not.toContain(token);
      expect(dump).toContain('{{INVITATION_TOKEN}}');
      expect(h.logger.lines.join('\n')).not.toContain(token);
    });

    it('rejects malformed, unknown, expired and consumed invitations safely', async () => {
      const valid = await invite();
      const expired = await invite();
      await h.prisma.$executeRaw`
        UPDATE invitation SET created_at = now() - interval '9 days', expires_at = now() - interval '1 day'
         WHERE id = (SELECT id FROM invitation ORDER BY created_at DESC LIMIT 1)`;

      await h.post(privateMessage('/start not-a-token', MEMBER_B)).expect(200);
      await h.post(privateMessage(`/start ${'A'.repeat(43)}`, MEMBER_B)).expect(200);
      await h.post(privateMessage(`/start ${expired}`, MEMBER_B)).expect(200);
      await h.post(privateMessage(`/start ${valid}`, MEMBER_A)).expect(200);
      await h.post(privateMessage(`/start ${valid}`, MEMBER_B)).expect(200);
      await drainDeliveries(h);

      expect(await userOf(MEMBER_B)).toBeNull();
      const invalid =
        'Запрошення недійсне, прострочене або вже використане. Попросіть адміністратора про нове.';
      // Every failure looks the same and reveals nothing about the invitation or its user.
      expect(sentTo(h, MEMBER_B).map((m) => m.html)).toEqual(Array(4).fill(invalid));
      expect(await h.prisma.invitation.count({ where: { redeemedAt: { not: null } } })).toBe(1);
      expect(await h.prisma.auditEvent.count({ where: { kind: 'INVITATION_REDEEMED' } })).toBe(1);
    });

    it('lets exactly one of two concurrent redeemers win', async () => {
      // Two processes with their own connection pools, as in a deployment overlap.
      const other = await start();
      for (let round = 0; round < 5; round += 1) {
        const token = await invite();
        const [first, second] = [5000 + round * 2, 5001 + round * 2];
        await Promise.all([
          h.post(privateMessage(`/start ${token}`, first)),
          other.post(privateMessage(`/start ${token}`, second)),
        ]);
        const created = await h.prisma.appUser.count({
          where: { telegramUserId: { in: [BigInt(first), BigInt(second)] } },
        });
        expect(created).toBe(1);
      }
      expect(await h.prisma.invitation.count({ where: { redeemedAt: { not: null } } })).toBe(5);
      expect(await h.prisma.auditEvent.count({ where: { kind: 'INVITATION_REDEEMED' } })).toBe(5);
    });

    it('does not consume invitations for registered, suspended or group senders', async () => {
      await onboard(MEMBER_A);
      const token = await invite();
      await h.post(privateMessage(`/start ${token}`, MEMBER_A)).expect(200); // already a member
      await h.post(privateMessage(`/start ${token}`, OTHER_ADMIN_ID)).expect(200); // administrator
      await h.post(groupMessage(`/start ${token}`, STRANGER)).expect(200); // group chat
      await h.post(privateMessage(`/admin suspend ${MEMBER_B}`, ADMIN_ID)).expect(200);
      await drainDeliveries(h);

      expect(await h.prisma.invitation.count({ where: { redeemedAt: null } })).toBe(1);
      expect(await userOf(STRANGER)).toBeNull();
      expect(lastTo(h, MEMBER_A)?.html).toContain(
        'Ви вже зареєстровані; запрошення не використано.',
      );
      expect(sentTo(h, STRANGER)).toHaveLength(0);

      // A suspended member cannot use an invitation to come back.
      await h.post(privateMessage(`/admin suspend ${MEMBER_A}`, ADMIN_ID)).expect(200);
      await h.post(privateMessage(`/start ${token}`, MEMBER_A)).expect(200);
      await drainDeliveries(h);
      expect(lastTo(h, MEMBER_A)?.html).toBe('Ваш доступ призупинено адміністратором.');
      expect(await h.prisma.invitation.count({ where: { redeemedAt: null } })).toBe(1);
      // The unused invitation still works for someone new, as a member only.
      await h.post(privateMessage(`/start ${token}`, STRANGER)).expect(200);
      expect(await userOf(STRANGER)).toMatchObject({ role: 'MEMBER' });
    });

    it('refuses to create invitations without the token secret', async () => {
      const noSecret = await start({ INVITATION_TOKEN_SECRET: '' });
      await noSecret.post(privateMessage('/admin invite', ADMIN_ID)).expect(200);
      await drainDeliveries(noSecret);
      expect(await noSecret.prisma.invitation.count()).toBe(0);
      expect(lastTo(noSecret, ADMIN_ID)?.html).toContain('INVITATION_TOKEN_SECRET');
    });
  });

  describe('duplicate updates and restarts', () => {
    it('performs each business action once for replayed updates', async () => {
      const inviteUpdate = privateMessage('/admin invite', ADMIN_ID);
      await Promise.all([h.post(inviteUpdate), h.post(inviteUpdate), h.post(inviteUpdate)]);
      expect(await h.prisma.invitation.count()).toBe(1);
      await drainDeliveries(h);
      const token = /\?start=([A-Za-z0-9_-]{43})/.exec(lastTo(h, ADMIN_ID)?.html ?? '')?.[1];

      const redeem = privateMessage(`/start ${token}`, MEMBER_A);
      await Promise.all([h.post(redeem), h.post(redeem)]);
      await h.post(redeem).expect(200);
      expect(await h.prisma.appUser.count({ where: { telegramUserId: BigInt(MEMBER_A) } })).toBe(1);
      expect(await h.prisma.auditEvent.count({ where: { kind: 'INVITATION_REDEEMED' } })).toBe(1);

      await drainDeliveries(h);
      const press = callbackQuery(buttons(h, MEMBER_A)[0] ?? '', MEMBER_A);
      await Promise.all([h.post(press), h.post(press)]);
      // A second, distinct press of the same button after completion changes nothing.
      await h.post(callbackQuery(buttons(h, MEMBER_A)[0] ?? '', MEMBER_A)).expect(200);

      const research = privateMessage('/research once', MEMBER_A);
      await Promise.all([h.post(research), h.post(research)]);
      await h.research.tick();
      await drainDeliveries(h);

      expect(await h.prisma.researchRun.count()).toBe(1);
      expect(h.provider.calls.submit).toBe(1);
      const memberMessages = sentTo(h, MEMBER_A).map((m) => m.html);
      expect(memberMessages).toHaveLength(4);
      expect(memberMessages.slice(0, 3).map((html) => html.split('\n')[0])).toEqual([
        'Вітаємо! Запрошення прийнято.',
        'Часовий пояс підтверджено: Europe/Kyiv.',
        'Запит прийнято (СИМУЛЯЦІЯ, без реального пошуку).',
      ]);
      expect(memberMessages[3]).toContain('Результат дослідження');
      expect(
        sentTo(h, ADMIN_ID).filter((m) => m.html.includes('запрошення використано')),
      ).toHaveLength(1);
    });

    it('resumes onboarding after a restart', async () => {
      const token = await invite();
      await h.post(privateMessage(`/start ${token}`, MEMBER_A)).expect(200);
      await drainDeliveries(h);
      const button = buttons(h, MEMBER_A)[0] ?? '';
      await h.close();
      open.splice(open.indexOf(h), 1);

      const restarted = await start();
      await restarted.post(privateMessage('/research hello', MEMBER_A)).expect(200);
      await restarted.post(callbackQuery(button, MEMBER_A)).expect(200);
      await restarted.post(privateMessage('/research hello', MEMBER_A)).expect(200);
      await drainDeliveries(restarted);
      expect(await restarted.prisma.researchRun.count()).toBe(1);
      expect(sentTo(restarted, MEMBER_A).map((m) => m.html.split('\n')[0])).toEqual([
        'Спершу завершіть реєстрацію: підтвердіть часовий пояс.',
        'Часовий пояс підтверджено: Europe/Kyiv.',
        'Запит прийнято (СИМУЛЯЦІЯ, без реального пошуку).',
      ]);
    });
  });

  describe('callbacks', () => {
    it('rejects stale, foreign, forged and group button presses without side effects', async () => {
      const token = await invite();
      await h.post(privateMessage(`/start ${token}`, MEMBER_A)).expect(200);
      const before = await userOf(MEMBER_A);
      const revision = before?.revision ?? -1;

      await h.post(callbackQuery(timeZoneCallbackData(revision + 5, 'Europe/Kyiv'), MEMBER_A));
      await h.post(callbackQuery(`tz:${revision}:EST`, MEMBER_A));
      await h.post(callbackQuery('tz:1:Europe/Kyiv;owner=3004', MEMBER_A));
      await h.post(callbackQuery(`run:${'1'.repeat(36)}`, MEMBER_A));
      // MEMBER_A's button pressed by someone else: acts on the presser only (who has no account).
      await h.post(callbackQuery(timeZoneCallbackData(revision, 'Europe/Kyiv'), MEMBER_B));
      // Same data in a group, or in a chat that is not the presser's.
      await h.post(
        callbackQuery(timeZoneCallbackData(revision, 'Europe/Kyiv'), MEMBER_A, undefined, {
          id: -100123,
          type: 'supergroup',
        }),
      );
      await h.post(
        callbackQuery(timeZoneCallbackData(revision, 'Europe/Kyiv'), MEMBER_A, undefined, {
          id: MEMBER_B,
          type: 'private',
        }),
      );

      expect(await userOf(MEMBER_A)).toEqual(before);
      expect(await userOf(MEMBER_B)).toBeNull();
      expect((await reasons()).slice(-7)).toEqual([
        'CALLBACK_STALE',
        'TIME_ZONE_INVALID',
        'CALLBACK_UNKNOWN',
        'CALLBACK_UNKNOWN',
        'NOT_REGISTERED',
        'NOT_PRIVATE_CHAT',
        'CHAT_SENDER_MISMATCH',
      ]);
      // Rejected presses get a short acknowledgement only; no message is queued.
      const deliveriesBefore = await h.prisma.delivery.count();
      await h.post(callbackQuery(timeZoneCallbackData(revision + 5, 'Europe/Kyiv'), MEMBER_A));
      expect(await h.prisma.delivery.count()).toBe(deliveriesBefore);
      expect(h.sender.callbackAnswers.at(-1)?.text).toBe('Ця кнопка застаріла.');
    });
  });

  describe('ownership', () => {
    it('keeps every user to their own runs and results', async () => {
      await onboard(MEMBER_A);
      await onboard(MEMBER_B);
      await h.post(privateMessage('/research b-topic', MEMBER_B)).expect(200);
      await h.research.tick();
      await drainDeliveries(h);
      const runB = await h.prisma.researchRun.findFirstOrThrow();
      const deliveriesBefore = await h.prisma.delivery.count();

      await h.post(privateMessage(`/result ${runB.id}`, MEMBER_A)).expect(200);
      await h.post(privateMessage('/result 11111111-2222-4333-8444-555555555555', MEMBER_A));
      await h.post(privateMessage(`/result ${runB.id}`, ADMIN_ID)).expect(200);
      await h.post(privateMessage(`/admin suspend ${MEMBER_B}`, MEMBER_A)).expect(200);
      await h.post(privateMessage('/admin invite', MEMBER_A)).expect(200);
      await drainDeliveries(h);

      // Foreign and nonexistent IDs get the same answer; administrators cannot read content either.
      expect(
        sentTo(h, MEMBER_A)
          .slice(-4)
          .map((m) => m.html),
      ).toEqual([
        'Запуск не знайдено.',
        'Запуск не знайдено.',
        'Невідома команда. /help - довідка.',
        'Невідома команда. /help - довідка.',
      ]);
      expect(lastTo(h, ADMIN_ID)?.html).toBe('Запуск не знайдено.');
      expect(await h.prisma.delivery.count({ where: { kind: 'RESEND' } })).toBe(0);
      expect(await h.prisma.delivery.count()).toBe(deliveriesBefore + 5);
      expect(await userOf(MEMBER_B)).toMatchObject({ status: 'ACTIVE' });
      expect(await h.prisma.invitation.count()).toBe(2);
      // The run ID typed by another user is not recorded against their update.
      const updates = await h.prisma.telegramUpdate.findMany({ where: { runId: runB.id } });
      expect(updates.map((u) => u.senderTelegramId)).toEqual([BigInt(MEMBER_B)]);

      await h.post(privateMessage(`/result ${runB.id}`, MEMBER_B)).expect(200);
      expect(await h.prisma.delivery.count({ where: { kind: 'RESEND' } })).toBe(1);
      expect(h.provider.calls.submit).toBe(1);
    });

    it('answers unregistered senders without disclosing anything', async () => {
      await onboard(MEMBER_A);
      await h.post(privateMessage('/research football', MEMBER_A)).expect(200);
      const [run] = await h.prisma.researchRun.findMany();
      for (const text of ['/start', '/help', `/result ${run?.id}`, '/admin invite', 'hello']) {
        await h.post(privateMessage(text, STRANGER)).expect(200);
      }
      await drainDeliveries(h);
      expect(new Set(sentTo(h, STRANGER).map((m) => m.html))).toEqual(
        new Set(['Цей бот приватний. Доступ лише за запрошенням.']),
      );
      expect(await userOf(STRANGER)).toBeNull();
      expect(await h.prisma.invitation.count()).toBe(1);
    });

    it('validates prompts and result IDs for members', async () => {
      const short = await start({ RESEARCH_PROMPT_MAX_CHARS: '20' });
      await short.post(privateMessage('/research   ', ADMIN_ID)).expect(200);
      await short.post(privateMessage(`/research ${'я'.repeat(21)}`, ADMIN_ID)).expect(200);
      await short.post(privateMessage(`/research ${'я'.repeat(20)}`, ADMIN_ID)).expect(200);
      await short.post(privateMessage('/result 42', ADMIN_ID)).expect(200);
      expect((await reasons()).slice(-4)).toEqual([
        'EMPTY_PROMPT',
        'PROMPT_TOO_LONG',
        null,
        'RESULT_USAGE',
      ]);
      expect(await short.prisma.researchRun.count()).toBe(1);
    });
  });

  describe('suspension', () => {
    it('cancels queued work, suppresses its messages and blocks further use', async () => {
      await onboard(MEMBER_A);
      await h.post(privateMessage('/research queued', MEMBER_A)).expect(200);
      await h.post(privateMessage(`/admin suspend ${MEMBER_A}`, ADMIN_ID)).expect(200);
      await h.post(privateMessage(`/admin suspend ${MEMBER_A}`, ADMIN_ID)).expect(200);
      await h.post(privateMessage(`/admin suspend ${OTHER_ADMIN_ID}`, ADMIN_ID)).expect(200);
      await h.post(privateMessage(`/admin suspend ${STRANGER}`, ADMIN_ID)).expect(200);
      expect(await h.research.tick()).toBe(false);
      await h.post(privateMessage('/research more', MEMBER_A)).expect(200);
      await drainDeliveries(h);

      const [run] = await h.prisma.researchRun.findMany();
      expect(run).toMatchObject({ state: 'CANCELLED', failureCode: 'USER_SUSPENDED' });
      expect(await h.prisma.researchRun.count()).toBe(1);
      expect(h.provider.calls.submit).toBe(0);
      // The acknowledgment of the cancelled run is suppressed; only the refusal is sent.
      expect(await h.prisma.delivery.findFirst({ where: { runId: run?.id } })).toMatchObject({
        state: 'SUPPRESSED',
      });
      expect(lastTo(h, MEMBER_A)?.html).toBe('Ваш доступ призупинено адміністратором.');
      expect(
        sentTo(h, ADMIN_ID)
          .slice(-4)
          .map((m) => m.html.split('.')[0]),
      ).toEqual([
        `Доступ користувача ${MEMBER_A} призупинено`,
        `Доступ користувача ${MEMBER_A} уже призупинено`,
        'Адміністратора не можна призупинити; змініть ADMIN_TELEGRAM_IDS',
        'Користувача з таким Telegram ID не знайдено',
      ]);
      expect(await userOf(OTHER_ADMIN_ID)).toMatchObject({ status: 'ACTIVE' });
      const audit = await h.prisma.auditEvent.findFirstOrThrow({
        where: { kind: 'USER_SUSPENDED' },
      });
      expect(audit.details).toEqual({ cancelledRuns: 1, suppressedDeliveries: 1, runningRuns: 0 });

      // Reactivation restores access without delivering the backlog.
      await h.post(privateMessage(`/admin reactivate ${MEMBER_A}`, ADMIN_ID)).expect(200);
      await drainDeliveries(h);
      expect(await h.prisma.delivery.findFirst({ where: { runId: run?.id } })).toMatchObject({
        state: 'SUPPRESSED',
      });
      await h.post(privateMessage('/research after', MEMBER_A)).expect(200);
      expect(await h.prisma.researchRun.count({ where: { state: 'QUEUED' } })).toBe(1);
    });

    it('rechecks the owner when a queued run is claimed (suspension after admission)', async () => {
      await onboard(MEMBER_A);
      await h.post(privateMessage('/research queued', MEMBER_A)).expect(200);
      // Suspension committed without the admission-side cancellation (e.g. a race).
      await h.prisma.appUser.update({
        where: { telegramUserId: BigInt(MEMBER_A) },
        data: { status: 'SUSPENDED', suspendedAt: new Date() },
      });
      await h.research.tick();
      await drainDeliveries(h);
      expect((await h.prisma.researchRun.findFirstOrThrow()).failureCode).toBe('USER_SUSPENDED');
      expect((await h.prisma.researchRun.findFirstOrThrow()).state).toBe('CANCELLED');
      expect(h.provider.calls.submit).toBe(0);
      expect(sentTo(h, MEMBER_A).some((m) => m.html.includes('скасовано'))).toBe(false);
    });

    it('does not deliver a pending report to a suspended user and keeps the result', async () => {
      await onboard(MEMBER_A);
      await h.post(privateMessage('/research report', MEMBER_A)).expect(200);
      await h.delivery.tick(); // acknowledgment
      await h.research.tick();
      const sentBefore = sentTo(h, MEMBER_A).length;
      // Suspended directly: the delivery worker's own check must stop the report.
      await h.prisma.appUser.update({
        where: { telegramUserId: BigInt(MEMBER_A) },
        data: { status: 'SUSPENDED', suspendedAt: new Date() },
      });
      await drainDeliveries(h);

      expect(sentTo(h, MEMBER_A)).toHaveLength(sentBefore);
      const run = await h.prisma.researchRun.findFirstOrThrow();
      expect(run).toMatchObject({ state: 'SUCCEEDED', outcome: 'FOUND' });
      expect(run.reportText).toBeTruthy();
      expect(
        await h.prisma.delivery.findFirst({ where: { runId: run.id, kind: 'REPORT' } }),
      ).toMatchObject({ state: 'SUPPRESSED', lastErrorCode: 'RECIPIENT_SUSPENDED' });
      await h.post(privateMessage(`/result ${run.id}`, MEMBER_A)).expect(200);
      expect(await h.prisma.delivery.count({ where: { kind: 'RESEND' } })).toBe(0);
    });

    it('requests cancellation of in-flight work and keeps it tracked', async () => {
      await onboard(MEMBER_A);
      await onboard(MEMBER_B);
      let polls = 0;
      h.provider.onRetrieve = async (id) => {
        polls += 1;
        if (polls === 1) await h.post(privateMessage(`/admin suspend ${MEMBER_A}`, ADMIN_ID));
        return snapshot(h.provider.echo, { id, status: 'in_progress' });
      };
      await h.post(privateMessage('/research running', MEMBER_A)).expect(200);
      await h.research.tick();
      expect(await h.prisma.researchRun.findFirstOrThrow()).toMatchObject({
        state: 'CANCELLED',
        failureCode: 'USER_SUSPENDED',
        submissionState: 'SUBMITTED',
        providerResponseId: 'resp_test_1',
        providerStatus: 'cancelled',
      });
      expect(h.provider.calls).toMatchObject({ submit: 1, cancel: 1 });

      // Unconfirmed cancellation stays UNCERTAIN (here simulated, so it does not block).
      polls = 0;
      h.provider.onRetrieve = async (id) => {
        polls += 1;
        if (polls === 1) await h.post(privateMessage(`/admin suspend ${MEMBER_B}`, ADMIN_ID));
        return snapshot(h.provider.echo, { id, status: 'in_progress' });
      };
      h.provider.onSubmit = (request) => Promise.resolve(snapshot(request, { id: 'resp_test_2' }));
      h.provider.onCancel = () => Promise.reject(new Error('network'));
      await h.post(privateMessage('/research running', MEMBER_B)).expect(200);
      await h.research.tick();
      expect(
        await h.prisma.researchRun.findFirstOrThrow({
          where: { providerResponseId: 'resp_test_2' },
        }),
      ).toMatchObject({ state: 'UNCERTAIN', failureCode: 'SUSPENDED_CANCEL_UNCONFIRMED' });
      await drainDeliveries(h);
      expect(sentTo(h, MEMBER_A).some((m) => m.html.includes('скасовано'))).toBe(false);
      expect(sentTo(h, MEMBER_B).some((m) => m.html.includes('невизначений'))).toBe(false);
    });
  });

  describe('live research before TRB-050', () => {
    it('is administrator-only at admission and at execution, without a fake substitute', async () => {
      await onboard(MEMBER_A);
      const live = await start(LIVE_ENV, { provider: new ScriptedProvider('openai') });
      await live.post(privateMessage('/research live please', MEMBER_A)).expect(200);
      await drainDeliveries(live);
      expect(await live.prisma.researchRun.count()).toBe(0);
      expect(lastTo(live, MEMBER_A)?.html).toBe(
        'Live-дослідження поки доступні лише адміністраторам (до запровадження бюджетів). Запит не прийнято.',
      );

      // A live run of a member that reached the queue anyway (e.g. admitted under an
      // older configuration) is cancelled before any provider call.
      const member = await userOf(MEMBER_A);
      await live.prisma.$executeRaw`
        INSERT INTO research_run (id, user_id, requested_by_telegram_user_id, chat_id, source_update_id,
                                  prompt, provider_kind, request_snapshot, updated_at)
        SELECT gen_random_uuid(), ${member?.id}::uuid, ${MEMBER_A}, ${MEMBER_A}, 990001, 'p', 'openai',
               request_snapshot, now()
          FROM (SELECT jsonb_build_object('config', jsonb_build_object(
                  'policyVersion', 'x', 'providerKind', 'openai', 'model', 'operator-selected-model',
                  'maxOutputTokens', 3000, 'maxToolCalls', 3, 'deadlineSeconds', 300,
                  'reasoningEffort', null, 'timeZone', 'Europe/Kyiv')) AS request_snapshot) s`;
      await live.research.tick();
      expect(await live.prisma.researchRun.findFirstOrThrow()).toMatchObject({
        state: 'CANCELLED',
        failureCode: 'LIVE_NOT_PERMITTED',
        submissionState: 'NOT_SUBMITTED',
      });

      await live.post(privateMessage('/research live admin', ADMIN_ID)).expect(200);
      await live.research.tick();
      expect(await live.prisma.researchRun.count({ where: { state: 'SUCCEEDED' } })).toBe(1);
      expect(live.provider.calls.submit).toBe(1);
      expect(live.provider.requests[0]?.input).toContain('live admin');
    });
  });
});
