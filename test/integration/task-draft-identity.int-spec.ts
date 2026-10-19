import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

/**
 * TRB-040 review fix: a draft button acts only on the draft that issued it,
 * never on a later draft of the same user that happens to have the same version.
 */
describe('task draft buttons are bound to their draft (fakes, real PostgreSQL)', () => {
  const open: Harness[] = [];
  const all: Harness[] = [];
  const start = async (...args: Parameters<typeof startHarness>) => {
    const harness = await startHarness(...args);
    open.push(harness);
    all.push(harness);
    return harness;
  };
  let h: Harness;

  beforeEach(async () => {
    h = await start();
    await resetDatabase(h.prisma);
  });

  afterEach(async () => {
    expect(await h.prisma.researchRun.count()).toBe(0);
    for (const harness of all.splice(0)) expect(harness.provider.calls.submit).toBe(0);
    for (const harness of open.splice(0)) await harness.close();
  });

  const last = (id = ADMIN_ID) =>
    all
      .flatMap((harness) => harness.sender.sent)
      .filter((m) => m.chatId === BigInt(id))
      .at(-1);
  const button = (label: string, id = ADMIN_ID) => {
    const found = last(id)
      ?.replyMarkup?.inline_keyboard.flat()
      .find((b) => b.text.includes(label));
    if (!found) throw new Error(`no button "${label}" in: ${(last(id)?.html ?? '').slice(0, 200)}`);
    return found.callback_data;
  };
  const say = async (text: string, from = ADMIN_ID, harness = h) => {
    await harness.post(privateMessage(text, from)).expect(200);
    await drainDeliveries(harness);
  };
  const press = async (data: string, from = ADMIN_ID, harness = h) => {
    await harness.post(callbackQuery(data, from)).expect(200);
    await drainDeliveries(harness);
  };
  /** Everything that identifies and describes the current draft. */
  const snapshot = (id = ADMIN_ID) =>
    h.prisma.taskDraft.findFirst({
      where: { user: { telegramUserId: BigInt(id) } },
      select: { id: true, data: true, step: true, version: true, expiresAt: true },
    });
  const lastReason = async () =>
    (await h.prisma.telegramUpdate.findFirst({ orderBy: { updateId: 'desc' } }))?.reason;

  /** A creation draft advanced to the schedule-kind step (version 2). */
  async function toKind(name: string, from = ADMIN_ID) {
    await say('/new', from);
    await say(name, from);
    await say(`Запит ${name}`, from);
  }
  /** A manual creation draft at PREVIEW (version 4). */
  async function toPreview(name: string, from = ADMIN_ID) {
    await toKind(name, from);
    await press(button('Вручну', from), from);
    await press(button('Використати', from), from);
  }

  async function expectUnaffected(action: () => Promise<void>) {
    const before = await snapshot();
    expect(before).not.toBeNull();
    await action();
    expect(await snapshot()).toEqual(before);
    expect(await lastReason()).toMatch(/^CALLBACK_(STALE|UNKNOWN)$/);
    expect(await h.prisma.task.count()).toBe(0);
  }

  it("does not let an old draft's Cancel delete a newer draft at the same version", async () => {
    await say('/new');
    const cancelA = button('Скасувати');
    await say('/cancel');
    await say('/new'); // draft B, also at version 0
    expect((await snapshot())?.version).toBe(0);
    await expectUnaffected(() => press(cancelA));
  });

  it("does not let an old draft's Save save a newer draft at PREVIEW", async () => {
    await toPreview('A');
    const saveA = button('Зберегти');
    await say('/cancel');
    await toPreview('B');
    expect((await snapshot())?.step).toBe('PREVIEW');
    await expectUnaffected(() => press(saveA));
    // B's own Save still works.
    await press(button('Зберегти'));
    expect((await h.prisma.task.findMany()).map((t) => t.name)).toEqual(['B']);
  });

  it("does not let an old draft's navigation or schedule buttons change a newer draft", async () => {
    await toKind('A');
    const [dailyA, backA] = [button('Щодня'), button('Назад')];
    await say('/cancel');
    await toKind('B');
    await expectUnaffected(() => press(dailyA));
    await expectUnaffected(() => press(backA));
  });

  it('does not let old Resume or Discard buttons act on a replacement draft', async () => {
    await say('/new');
    await say('A'); // version 1
    await say('/new');
    const [resumeA, discardA] = [button('Продовжити'), button('Відкинути')];
    await say('/cancel');
    await say('/new');
    await say('B'); // replacement draft, version 1
    await expectUnaffected(() => press(resumeA));
    await expectUnaffected(() => press(discardA));
  });

  it("ignores another user's draft button even when the versions match", async () => {
    await say('/new', OTHER_ADMIN_ID);
    const foreignCancel = button('Скасувати', OTHER_ADMIN_ID);
    const foreign = await snapshot(OTHER_ADMIN_ID);
    await say('/new');
    await expectUnaffected(() => press(foreignCancel));
    expect(await snapshot(OTHER_ADMIN_ID)).toEqual(foreign);
  });

  it('rejects legacy version-only draft buttons', async () => {
    await toPreview('Поточна');
    for (const legacy of ['d:4:s', 'd:4:x', 'd:4:b', 'd:4:r', 'd:4:n', 'd:0:x']) {
      await expectUnaffected(() => press(legacy));
      expect(await lastReason()).toBe('CALLBACK_UNKNOWN');
    }
  });

  it('does not remove or extend an expired replacement draft for a mismatched button', async () => {
    await say('/new');
    const cancelA = button('Скасувати');
    await say('/cancel');
    await say('/new');
    await h.prisma.$executeRaw`UPDATE task_draft SET expires_at = now() - interval '1 second'`;
    await expectUnaffected(() => press(cancelA));
    expect(await lastReason()).toBe('CALLBACK_STALE');
    // The current draft's own button still reports the expiry.
    await press(button('Скасувати'));
    expect(await lastReason()).toBe('DRAFT_EXPIRED');
    expect(await snapshot()).toBeNull();
  });

  it('keeps valid draft buttons working after a restart', async () => {
    await toKind('Рестарт');
    const daily = button('Щодня');
    await h.close();
    open.splice(open.indexOf(h), 1);
    h = await start();
    await press(daily);
    expect(await snapshot()).toMatchObject({ step: 'LOCAL_TIME', data: { scheduleKind: 'DAILY' } });
  });

  it('creates exactly one task from repeated and concurrent valid Save presses', async () => {
    await toPreview('Один');
    const save = button('Зберегти');
    const other = await start();
    const update = callbackQuery(save);
    await Promise.all([h.post(update), h.post(update), other.post(callbackQuery(save))]);
    await h.post(callbackQuery(save)).expect(200);
    expect((await h.prisma.task.findMany()).map((t) => t.name)).toEqual(['Один']);
    expect(await snapshot()).toBeNull();
  });
});
