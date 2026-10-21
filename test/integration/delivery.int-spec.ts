import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStatusDelivery } from '../../src/delivery/delivery-records';
import { partContentHash, renderReport } from '../../src/delivery/report-renderer';
import { DELIVERY_QUEUE, RESEARCH_QUEUE } from '../../src/queue/queue.service';
import { buildTextPart, type Segment } from '../../src/research/provider/fake-fixtures';
import type { Citation, ReportWarning } from '../../src/research/report';
import {
  compactId,
  historyCallbackData,
  resendCallbackData,
  runCallbackData,
  taskCallbackData,
} from '../../src/telegram/callback-data';
import { TelegramSendError } from '../../src/telegram/telegram-sender';
import {
  FakeClock,
  ScriptedProvider,
  completed,
  echoed,
  snapshot,
  telegramBadRequest,
  telegramBlocked,
  telegramRateLimited,
  telegramServerError,
  telegramTimeout,
} from '../support/fakes';
import { LIVE_TEST_ENV } from '../support/live-env';
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

const REPORT_TITLE = 'Результат дослідження';
const ALLOWED_TAGS = /<\/?(?:b|i|code|a)(?:\s[^>]*)?>/g;

function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** A report of `items` cited paragraphs with mixed scripts, emoji and markup-like text. */
function unicodeReport(items: number): Segment[] {
  const segments: Segment[] = ['OUTCOME: FOUND\n'];
  for (let i = 0; i < items; i += 1) {
    segments.push(`Пункт ${i}: 👨‍👩‍👧‍👦 «Динамо» 🇺🇦 & <b>ціна</b> ${'довгий текст '.repeat(20)}`);
    segments.push({
      cite: { url: `https://s${i % 7}.example/p?n=${i % 7}`, title: `Джерело ${i % 7}` },
    });
    segments.push(i % 4 === 3 ? '\n\n' : ' ');
  }
  return segments;
}

/** Telegram-visible text approximation: tags removed, entities decoded. */
const visible = (html: string) =>
  html
    .replace(ALLOWED_TAGS, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

describe('TRB-080 delivery and history (recording sender, real pg-boss and PostgreSQL)', () => {
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
    clock = new FakeClock(new Date('2026-10-19T05:00:00Z'));
    h = await start();
    await resetDatabase(h.prisma);
  });

  afterEach(async () => {
    for (const harness of open.splice(0)) await harness.close();
  });

  const completeWith = (harness: Harness, segments: Segment[]) => {
    harness.provider.onRetrieve = (id) =>
      Promise.resolve({
        ...completed([buildTextPart(segments)]),
        id,
        bounds: echoed(harness.provider.echo),
      });
  };
  const say = async (text: string, from = ADMIN_ID, harness = h) => {
    await harness.post(privateMessage(text, from)).expect(200);
  };
  const press = async (data: string, from = ADMIN_ID, harness = h) => {
    await harness.post(callbackQuery(data, from)).expect(200);
  };
  /** /research, executed; its acknowledgement is sent and the recording cleared. */
  const researched = async (harness = h, text = 'topic', from = ADMIN_ID) => {
    await say(`/research ${text}`, from, harness);
    expect(await harness.research.tick()).toBe(true);
    const run = await harness.prisma.researchRun.findFirstOrThrow({
      orderBy: { createdAt: 'desc' },
    });
    const ack = await harness.prisma.delivery.findFirstOrThrow({
      where: { runId: run.id, kind: 'STATUS' },
    });
    expect(await harness.delivery.handle(ack.id)).toBe('sent');
    harness.sender.sent.length = 0;
    harness.sender.attempts.length = 0;
    return run;
  };
  const reportOf = (runId: string) =>
    h.prisma.delivery.findFirstOrThrow({
      where: { runId, kind: 'REPORT' },
      include: { parts: { orderBy: { ordinal: 'asc' } } },
    });
  const jobs = (queue: string) =>
    h.prisma.$queryRawUnsafe<{ id: string; data: Record<string, string> }[]>(
      `SELECT id::text, data FROM pgboss.job WHERE name = '${queue}' ORDER BY created_on, id`,
    );
  const pendingEvents = (deliveryId?: string) =>
    h.prisma.deliveryEvent.findMany({
      where: { dispatchedAt: null, cancelledAt: null, ...(deliveryId ? { deliveryId } : {}) },
    });
  const evidence = async () => ({
    runs: await h.prisma.researchRun.findMany({ orderBy: { id: 'asc' } }),
    reservations: await h.prisma.budgetReservation.findMany({ orderBy: { id: 'asc' } }),
    ledger: await h.prisma.usageLedger.count(),
    outbox: await h.prisma.outboxEvent.count(),
    attempts: await h.prisma.researchAttempt.count(),
  });
  const lastText = (harness = h) => visible(harness.sender.sent.at(-1)?.html ?? '');
  const lastButtons = (harness = h) =>
    harness.sender.sent.at(-1)?.replyMarkup?.inline_keyboard.flat() ?? [];
  const button = (label: string, harness = h) => {
    const found = lastButtons(harness).find((b) => b.text.includes(label));
    if (!found) throw new Error(`no button "${label}" in ${lastText(harness)}`);
    return found.callback_data;
  };
  const adminId = async (telegramId = ADMIN_ID) =>
    (await h.prisma.appUser.findUniqueOrThrow({ where: { telegramUserId: BigInt(telegramId) } }))
      .id;
  /** A finished worker crash: the delivery is SENDING under a lease that already expired. */
  const crashWhileHolding = (deliveryId: string) =>
    h.prisma.$executeRaw`
      UPDATE delivery SET state = 'SENDING', lease_owner = 'dead-worker',
             lease_until = now() - interval '1 second', fencing_token = fencing_token + 1
       WHERE id = ${deliveryId}::uuid`;

  describe('separate queue and independence from research', () => {
    it('publishes deliveries to their own queue; Telegram failures and resends never research or account', async () => {
      const live = await start({}, true);
      h = live;
      const run = await researched(live);
      const report = await reportOf(run.id);
      const before = await evidence();
      expect(before.reservations).toHaveLength(1);

      // Ambiguous first send, then an explicit resend that hits a 5xx answer before succeeding.
      live.sender.failNext(telegramTimeout());
      await drainDeliveries(live);
      expect(await reportOf(run.id)).toMatchObject({ state: 'UNKNOWN' });
      live.sender.failNext(telegramServerError());
      await say(`/result ${run.id}`, ADMIN_ID, live);
      await drainDeliveries(live);
      await live.prisma
        .$executeRaw`UPDATE delivery SET next_attempt_at = now() WHERE state = 'RETRYABLE_FAILURE'`;
      await live.prisma
        .$executeRaw`UPDATE delivery_event SET available_at = now() WHERE dispatched_at IS NULL`;
      await drainDeliveries(live);
      const resend = await live.prisma.delivery.findFirstOrThrow({ where: { kind: 'RESEND' } });
      expect(resend.state).toBe('SENT');
      // The UNKNOWN notice went first and took the 5xx answer: retried once, then sent.
      expect(await live.prisma.delivery.count({ where: { state: 'SENT', attempts: 2 } })).toBe(1);

      // Research evidence and accounting are exactly as research left them.
      expect(await evidence()).toEqual(before);
      expect(live.provider.calls.submit).toBe(1);
      // Delivery jobs only name deliveries; research jobs only name runs.
      const deliveryJobs = await jobs(DELIVERY_QUEUE);
      expect(deliveryJobs.length).toBeGreaterThanOrEqual(3);
      expect(deliveryJobs.every((job) => job.data['deliveryId'] && !job.data['runId'])).toBe(true);
      const researchJobs = await jobs(RESEARCH_QUEUE);
      expect(researchJobs.every((job) => job.data['runId'] && !job.data['deliveryId'])).toBe(true);
      expect(researchJobs.map((job) => job.data['runId'])).toEqual([run.id]);
      expect(deliveryJobs.some((job) => job.data['deliveryId'] === report.id)).toBe(true);
    });
  });

  describe('transactional publication and crash recovery', () => {
    it('commits the report with its delivery event and publishes it once after a crash before publication', async () => {
      await say('/research topic');
      expect(await h.research.tick()).toBe(true);
      const run = await h.prisma.researchRun.findFirstOrThrow();
      const report = await reportOf(run.id);
      expect(await pendingEvents(report.id)).toHaveLength(1);
      expect(await jobs(DELIVERY_QUEUE)).toHaveLength(0);

      await close(h); // dies before the delivery dispatcher ran
      h = await start();
      await drainDeliveries(h);
      // The committed event was published after the restart. The report then waited for
      // the earlier acknowledgement to the same chat and was woken again when it finished.
      const created = await h.prisma.deliveryEvent.findFirstOrThrow({
        where: { deliveryId: report.id, reason: 'CREATED' },
      });
      expect(created.dispatchedAt).toBeInstanceOf(Date);
      expect((await jobs(DELIVERY_QUEUE)).map((job) => job.id)).toContain(created.id);
      expect(await pendingEvents()).toHaveLength(0);
      expect(await reportOf(run.id)).toMatchObject({ state: 'SENT' });
      expect(h.sender.sent.filter((m) => m.html.includes(REPORT_TITLE))).toHaveLength(1);
    });

    it('rolls back an interrupted publication with its acknowledgement and publishes once', async () => {
      await say('/help');
      const [event] = await pendingEvents();
      const data = { deliveryId: event?.deliveryId ?? '', eventId: event?.id ?? '' };
      await expect(
        h.prisma.$transaction(async (tx) => {
          expect(await h.queue.publishDelivery(tx, data)).toBe(data.eventId);
          throw new Error('crash before acknowledgement');
        }),
      ).rejects.toThrow('crash before acknowledgement');
      expect(await jobs(DELIVERY_QUEUE)).toHaveLength(0);
      expect(await pendingEvents()).toHaveLength(1);

      expect(await h.deliveryDispatcher.dispatchDue()).toBe(1);
      expect(await h.prisma.$transaction((tx) => h.queue.publishDelivery(tx, data))).toBeNull();
      expect(await jobs(DELIVERY_QUEUE)).toHaveLength(1);
      await drainDeliveries(h);
      expect(h.sender.sent).toHaveLength(1);
    });
  });

  describe('duplicates, concurrency and restarts', () => {
    it('sends every part once with two workers and a duplicate job', async () => {
      completeWith(h, unicodeReport(40));
      const run = await researched();
      const report = await reportOf(run.id);
      expect(report.parts.length).toBeGreaterThan(2);
      const second = await start();
      await h.deliveryDispatcher.dispatchDue();
      // A duplicate job for the same delivery (at-least-once transport).
      await h.prisma.$transaction((tx) =>
        h.queue.publishDelivery(tx, { deliveryId: report.id, eventId: randomUUID() }),
      );

      const inFlight = gate();
      const release = gate();
      let first = true;
      h.sender.beforeSend = async () => {
        if (!first) return;
        first = false;
        inFlight.open();
        await release.promise;
      };
      const sending = h.delivery.tick();
      await inFlight.promise;
      // While worker A holds the delivery, worker B consumes the other job and does nothing.
      expect(await second.delivery.tick()).toBe(false);
      release.open();
      await sending;
      await drainDeliveries(h);
      await drainDeliveries(second);

      expect(second.sender.attempts).toHaveLength(0);
      expect(h.sender.sent).toHaveLength(report.parts.length);
      expect(new Set(h.sender.sent.map((m) => m.html)).size).toBe(report.parts.length);
      expect(await reportOf(run.id)).toMatchObject({ state: 'SENT' });
    });

    it('resumes after a restart from the first unsent part; confirmed parts keep their message IDs', async () => {
      completeWith(h, unicodeReport(40));
      const run = await researched();
      const report = await reportOf(run.id);
      // Shutdown after the first part: the delivery is handed over (lease released, wake-up).
      const stop = new AbortController();
      h.sender.beforeSend = () => {
        stop.abort();
        return Promise.resolve();
      };
      expect(await h.delivery.handle(report.id, stop.signal)).toBe('stopped');
      let current = await reportOf(run.id);
      expect(current.state).toBe('PENDING');
      expect(current.parts.map((p) => p.state)).toEqual([
        'SENT',
        ...report.parts.slice(1).map(() => 'PENDING'),
      ]);
      expect(await pendingEvents(report.id)).toHaveLength(1);
      const firstId = current.parts[0]?.telegramMessageId;

      // Crash before the next send intent: SENDING with an expired lease, no wake-up.
      await crashWhileHolding(report.id);
      await h.prisma
        .$executeRaw`UPDATE delivery_event SET cancelled_at = now() WHERE delivery_id = ${report.id}::uuid AND dispatched_at IS NULL`;
      await close(h);
      h = await start();
      await drainDeliveries(h);

      current = await reportOf(run.id);
      expect(current.state).toBe('SENT');
      expect(current.parts[0]?.telegramMessageId).toBe(firstId);
      expect(h.sender.sent.map((m) => m.html)).toEqual(report.parts.slice(1).map((p) => p.html));
      expect(h.provider.calls.submit).toBe(0);
    });

    it('turns a part interrupted after its send intent into UNKNOWN and sends nothing more', async () => {
      completeWith(h, unicodeReport(40));
      const run = await researched();
      const report = await reportOf(run.id);
      await h.prisma.$executeRaw`
        UPDATE delivery_part SET state = 'SENDING', send_started_at = now()
         WHERE delivery_id = ${report.id}::uuid AND ordinal = 0`;
      await crashWhileHolding(report.id);
      await close(h);
      h = await start();
      await drainDeliveries(h);

      const current = await reportOf(run.id);
      expect(current).toMatchObject({
        state: 'UNKNOWN',
        lastErrorCode: 'INTERRUPTED_WHILE_SENDING',
      });
      expect(current.parts.map((p) => p.state)).toEqual([
        'UNKNOWN',
        ...report.parts.slice(1).map(() => 'PENDING'),
      ]);
      expect(h.sender.attempts).toHaveLength(0);
      expect(await pendingEvents(report.id)).toHaveLength(0);
    });
  });

  describe('retry classification', () => {
    it('stops a multipart delivery at an ambiguous outcome and never resends automatically', async () => {
      completeWith(h, unicodeReport(40));
      const run = await researched();
      let calls = 0;
      h.sender.beforeSend = () =>
        (calls += 1) === 2 ? Promise.reject(telegramTimeout()) : Promise.resolve();
      await drainDeliveries(h);
      const current = await reportOf(run.id);
      expect(current).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'TELEGRAM_NETWORK' });
      expect(current.parts.slice(0, 3).map((p) => p.state)).toEqual(['SENT', 'UNKNOWN', 'PENDING']);
      expect(current.parts[1]?.errorCode).toBe('TELEGRAM_NETWORK');
      await h.deliveryDispatcher.sweep();
      await drainDeliveries(h);
      expect(h.sender.attempts).toHaveLength(2);
    });

    it('respects Retry-After with a durable retry time and no busy loop', async () => {
      await say('/help');
      h.sender.failNext(new TelegramSendError('TELEGRAM_429', 'not_sent', false, 30));
      expect(await h.delivery.tick()).toBe(true);
      const delivery = await h.prisma.delivery.findFirstOrThrow({ include: { parts: true } });
      expect(delivery).toMatchObject({ state: 'RETRYABLE_FAILURE', lastErrorCode: 'TELEGRAM_429' });
      const wait = (delivery.nextAttemptAt.getTime() - Date.now()) / 1000;
      expect(wait).toBeGreaterThan(25);
      expect(wait).toBeLessThanOrEqual(31);
      const [retry] = await pendingEvents(delivery.id);
      expect(
        Math.abs((retry?.availableAt.getTime() ?? 0) - delivery.nextAttemptAt.getTime()),
      ).toBeLessThan(2000);
      expect(delivery.parts[0]).toMatchObject({ state: 'PENDING', errorCode: 'TELEGRAM_429' });

      // Not due: repeated ticks publish nothing and send nothing.
      const jobsBefore = (await jobs(DELIVERY_QUEUE)).length;
      for (let i = 0; i < 3; i += 1) expect(await h.delivery.tick()).toBe(false);
      expect((await jobs(DELIVERY_QUEUE)).length).toBe(jobsBefore);
      expect(h.sender.attempts).toHaveLength(1);

      await h.prisma.$executeRaw`UPDATE delivery SET next_attempt_at = now()`;
      await h.prisma
        .$executeRaw`UPDATE delivery_event SET available_at = now() WHERE dispatched_at IS NULL`;
      await drainDeliveries(h);
      expect(await h.prisma.delivery.findFirstOrThrow()).toMatchObject({
        state: 'SENT',
        attempts: 2,
      });
    });

    it('gives up after the bounded number of attempts', async () => {
      await say('/help');
      // retry_after = 0 is not a usable value: bounded backoff, made due here.
      for (let i = 0; i < 5; i += 1) {
        h.sender.failNext(telegramRateLimited());
        await drainDeliveries(h);
        await h.prisma
          .$executeRaw`UPDATE delivery SET next_attempt_at = now() WHERE state = 'RETRYABLE_FAILURE'`;
        await h.prisma
          .$executeRaw`UPDATE delivery_event SET available_at = now() WHERE dispatched_at IS NULL AND cancelled_at IS NULL`;
      }
      await drainDeliveries(h);
      expect(await h.prisma.delivery.findFirstOrThrow()).toMatchObject({
        state: 'PERMANENT_FAILURE',
        lastErrorCode: 'TELEGRAM_429',
        attempts: 5,
      });
      expect(h.sender.attempts).toHaveLength(5);
      expect(h.sender.sent).toHaveLength(0);
    });

    it('stops at a permanent refusal; rate limits and transient errors never mark the chat blocked', async () => {
      const task = await h.prisma.task.create({
        data: {
          userId: await adminId(),
          name: 'Daily',
          prompt: 'p',
          scheduleKind: 'DAILY',
          localTime: '09:00',
          timeZone: 'Europe/Kyiv',
          nextRunAt: new Date('2026-10-19T06:00:00Z'),
        },
      });
      // Terminal outcomes first: a retryable delivery holds back later ones to the same chat.
      const failures: [TelegramSendError, number][] = [
        [telegramBadRequest(), ADMIN_ID],
        [new TelegramSendError('TELEGRAM_403', 'not_sent', true), ADMIN_ID], // no block description
        [telegramTimeout(), ADMIN_ID],
        [new TelegramSendError('TELEGRAM_429', 'not_sent', false, 60), ADMIN_ID],
        [telegramServerError(), OTHER_ADMIN_ID],
      ];
      for (const [failure, chat] of failures) {
        await say('/help', chat);
        h.sender.failNext(failure);
        await h.delivery.tick();
      }
      const states = await h.prisma.delivery.findMany({
        orderBy: { seq: 'asc' },
        select: { state: true, lastErrorCode: true },
      });
      expect(states).toEqual([
        { state: 'PERMANENT_FAILURE', lastErrorCode: 'TELEGRAM_400' },
        { state: 'PERMANENT_FAILURE', lastErrorCode: 'TELEGRAM_403' },
        { state: 'UNKNOWN', lastErrorCode: 'TELEGRAM_NETWORK' },
        { state: 'RETRYABLE_FAILURE', lastErrorCode: 'TELEGRAM_429' },
        { state: 'RETRYABLE_FAILURE', lastErrorCode: 'TELEGRAM_502' },
      ]);
      expect(await h.prisma.appUser.count({ where: { chatBlockedAt: { not: null } } })).toBe(0);
      const admin = await h.prisma.appUser.findUniqueOrThrow({ where: { id: await adminId() } });
      expect(admin.chatBlockedAt).toBeNull();
      expect(await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
        state: 'ACTIVE',
      });
      expect(await h.prisma.auditEvent.count({ where: { kind: 'DESTINATION_BLOCKED' } })).toBe(0);
    });
  });

  describe('rendering and the document fallback', () => {
    it('delivers a long Unicode report completely, with valid markup and linked claims', async () => {
      completeWith(h, unicodeReport(40));
      const run = await researched();
      await drainDeliveries(h);
      const report = await reportOf(run.id);
      expect(report.parts.every((p) => p.kind === 'MESSAGE')).toBe(true);
      expect(h.sender.sent.map((m) => m.html)).toEqual(report.parts.map((p) => p.html));
      for (const message of h.sender.sent) {
        expect(message.html.length).toBeLessThanOrEqual(4096);
        expect(message.html.isWellFormed()).toBe(true);
        expect(message.html.match(/<a /g)?.length ?? 0).toBe(
          message.html.match(/<\/a>/g)?.length ?? 0,
        );
        expect(message.html.replace(ALLOWED_TAGS, '')).not.toMatch(/[<>]/);
      }
      const all = h.sender.sent
        .map((m) => visible(m.html).replace(/^\(\d+\/\d+\)\n/, ''))
        .join(' ')
        .replace(/\s+/g, ' ');
      for (let i = 0; i < 40; i += 1) {
        expect(all).toContain(`Пункт ${i}: 👨‍👩‍👧‍👦 «Динамо» 🇺🇦 & <b>ціна</b>`);
      }
      const joined = h.sender.sent.map((m) => m.html).join('');
      expect(joined).toContain('<a href="https://s3.example/p?n=3">[4]</a>');
    });

    it('sends a complete, reproducible document when the report exceeds the part limit', async () => {
      completeWith(h, unicodeReport(400));
      const run = await researched();
      await drainDeliveries(h);
      const report = await reportOf(run.id);
      expect(report.parts.map((p) => p.kind)).toEqual(['MESSAGE', 'DOCUMENT']);
      const [summary, file] = report.parts;
      const sentFile = h.sender.sent[1];
      expect(sentFile?.document?.fileName).toBe(`report-${run.id}.txt`);
      expect(sentFile?.document?.content.toString('utf8')).toBe(file?.fileContent);
      expect(sentFile?.html).toBe(file?.html);
      expect(visible(summary?.html ?? '')).toContain('файлом нижче');
      expect(file?.contentHash).toBe(partContentHash(file ?? { html: '' }));
      const text = file?.fileContent ?? '';
      expect(text).toContain(`Запуск: ${run.id}`);
      expect(text).toContain('СИМУЛЯЦІЯ');
      expect(text).toContain('Перевірено: ');
      for (let i = 0; i < 400; i += 1) expect(text).toContain(`Пункт ${i}: `);
      expect(text).toContain('[4] Джерело 3 — https://s3.example/p?n=3');

      // After a restart: the stored representation is resent byte for byte, and the
      // stored report re-renders to the identical document.
      await close(h);
      h = await start();
      await say(`/result ${run.id}`);
      await drainDeliveries(h);
      const resent = h.sender.sent.find((m) => m.document);
      expect(resent?.document?.content.equals(Buffer.from(text, 'utf8'))).toBe(true);
      const stored = await h.prisma.researchRun.findUniqueOrThrow({ where: { id: run.id } });
      const rerendered = renderReport({
        runId: stored.id,
        checkedAt: stored.completedAt ?? new Date(0),
        timeZone: 'Europe/Kyiv',
        outcome: stored.outcome ?? 'INCONCLUSIVE',
        warnings: (stored.warnings ?? []) as ReportWarning[],
        simulated: true,
        text: stored.reportText ?? '',
        citations: (stored.citations ?? []) as unknown as Citation[],
      });
      expect(rerendered.map((p) => p.html)).toEqual(report.parts.map((p) => p.html));
      expect(rerendered[1]).toMatchObject({ fileName: file?.fileName, fileContent: text });
      expect(h.provider.calls.submit).toBe(0);
    });

    it('keeps malicious text, URLs and titles inert in messages, caption and file name', async () => {
      completeWith(h, [
        'OUTCOME: FOUND\n<a href="javascript:alert(1)">x</a> <script>1</script> https://evil.example/raw ',
        { cite: { url: 'https://ok.example/?a=1&b="2"', title: '<b onclick=1>t</b>' } },
        ' and ',
        { cite: { url: 'javascript:alert(2)', title: 'js' } },
        ' and ',
        { cite: { url: 'https://user:pass@creds.example/', title: 'creds' } },
        ...unicodeReport(300).slice(1),
      ]);
      const run = await researched();
      await drainDeliveries(h);
      const report = await reportOf(run.id);
      for (const part of report.parts) {
        expect(part.html.replace(ALLOWED_TAGS, '')).not.toMatch(/[<>]/);
        for (const [, href] of part.html.matchAll(/href="([^"]*)"/g)) {
          expect(href).toMatch(/^https:\/\/(ok|s\d)\.example\//);
        }
      }
      const document = report.parts.find((p) => p.kind === 'DOCUMENT');
      expect(document?.fileName).toBe(`report-${run.id}.txt`);
      expect(document?.html).toBe(`Повний звіт (текст UTF-8). Запуск ${run.id}`);
      // Rejected annotations (scheme, credentials) never become sources; the model's own
      // text stays plain text in the body.
      const sources = (document?.fileContent ?? '').split('\nДжерела\n')[1] ?? '';
      expect(sources).toContain('[1] <b onclick=1>t</b> — https://ok.example/?a=1&b=%222%22');
      expect(sources).not.toMatch(/javascript:|creds\.example|user:pass/);
      expect(
        sources.split('\n').every((line) => !line || /^\[\d+\] .* — https:\/\//.test(line)),
      ).toBe(true);
      expect(report.parts.map((p) => p.html).join('')).not.toMatch(/href="[^"]*(creds|javascript)/);
    });
  });

  describe('history and explicit resend', () => {
    let updateId = 700_000;
    const insertRun = async (fields: {
      owner?: number;
      createdAt: Date;
      taskId?: string;
      scheduled?: { occurrenceAt: Date; startedAt: Date };
      report?: 'SENT' | 'UNKNOWN' | 'SUPPRESSED';
    }) => {
      const owner = fields.owner ?? ADMIN_ID;
      const run = await h.prisma.researchRun.create({
        data: {
          userId: await adminId(owner),
          requestedByTelegramUserId: BigInt(owner),
          chatId: BigInt(owner),
          sourceUpdateId: fields.scheduled ? null : BigInt((updateId += 1)),
          trigger: fields.scheduled ? 'SCHEDULED' : 'MANUAL',
          occurrenceAt: fields.scheduled?.occurrenceAt ?? null,
          taskId: fields.taskId ?? null,
          taskRevision: fields.taskId ? 1 : null,
          prompt: 'Stored prompt',
          providerKind: 'fake',
          requestSnapshot: { config: { timeZone: 'Europe/Kyiv' } },
          state: 'SUCCEEDED',
          outcome: 'FOUND',
          reportText: 'Stored report',
          createdAt: fields.createdAt,
          startedAt: fields.scheduled?.startedAt ?? fields.createdAt,
          completedAt: fields.createdAt,
        },
      });
      await h.prisma.delivery.create({
        data: {
          kind: 'REPORT',
          runId: run.id,
          chatId: BigInt(owner),
          state: fields.report ?? 'SENT',
          ...(fields.report === 'SUPPRESSED'
            ? { suppressedAt: new Date(), lastErrorCode: 'CHAT_BLOCKED' }
            : {}),
          parts: {
            create: [
              { ordinal: 0, html: `<b>Report ${run.id}</b>`, contentHash: 'h', state: 'SENT' },
            ],
          },
        },
      });
      return run;
    };
    const ownTask = async (owner = ADMIN_ID, name = 'Daily') =>
      h.prisma.task.create({
        data: {
          userId: await adminId(owner),
          name,
          prompt: 'p',
          scheduleKind: 'DAILY',
          localTime: '09:00',
          timeZone: 'Europe/Kyiv',
        },
      });
    const shown = () => [...lastText().matchAll(/^(\d)\. (.*)$/gm)].map((m) => m[2] ?? '');
    const runIdsOnPage = () =>
      lastButtons()
        .filter((b) => b.callback_data.startsWith('r:'))
        .map((b) => b.callback_data.slice(2, 24));

    it('pages deterministically by keyset and isolates users', async () => {
      const base = new Date('2026-10-10T10:00:00Z').getTime();
      const runs = [];
      for (let i = 0; i < 12; i += 1) {
        runs.push(await insertRun({ createdAt: new Date(base + i * 3_600_000) }));
      }
      const foreign = await insertRun({ owner: OTHER_ADMIN_ID, createdAt: new Date(base) });
      const newestFirst = [...runs].reverse().map((r) => compactId(r.id));

      await say('/history');
      await drainDeliveries(h);
      expect(runIdsOnPage()).toEqual(newestFirst.slice(0, 5));
      expect(lastButtons().every((b) => Buffer.byteLength(b.callback_data) <= 64)).toBe(true);
      await press(button('Старіші'));
      await drainDeliveries(h);
      const page2 = runIdsOnPage();
      expect(page2).toEqual(newestFirst.slice(5, 10));
      // A run added meanwhile does not shift the open pages.
      await insertRun({ createdAt: new Date(base + 99 * 3_600_000) });
      await press(button('Старіші'));
      await drainDeliveries(h);
      expect(runIdsOnPage()).toEqual(newestFirst.slice(10));
      expect(lastButtons().some((b) => b.text.includes('Старіші'))).toBe(false);
      await press(historyCallbackData('all', { direction: 'newer', runId: runs[6]?.id ?? '' }));
      await drainDeliveries(h);
      expect(runIdsOnPage()).toEqual(newestFirst.slice(0, 5));

      // Another user sees only their own run and cannot open, page from or resend foreign ones.
      await say('/history', OTHER_ADMIN_ID);
      await drainDeliveries(h);
      expect(runIdsOnPage()).toEqual([compactId(foreign.id)]);
      const before = h.sender.sent.length;
      await press(runCallbackData(runs[0]?.id ?? '', 'all'), OTHER_ADMIN_ID);
      await press(resendCallbackData(runs[0]?.id ?? ''), OTHER_ADMIN_ID);
      await press(
        historyCallbackData('all', { direction: 'older', runId: runs[3]?.id ?? '' }),
        OTHER_ADMIN_ID,
      );
      await drainDeliveries(h);
      const replies = h.sender.sent.slice(before).map((m) => visible(m.html));
      expect(replies[0]).toBe('Запуск не знайдено.');
      expect(replies[1]).toBe('Запуск не знайдено.');
      expect(replies[2]).toContain('Список змінився');
      expect(replies[2]).not.toContain(runs[3]?.id.slice(0, 8));
      expect(await h.prisma.delivery.count({ where: { kind: 'RESEND' } })).toBe(0);
    });

    it('fails safely on malformed, stale and foreign task callbacks, and hides deleted tasks', async () => {
      const mine = await ownTask();
      const foreignTask = await ownTask(OTHER_ADMIN_ID, 'Foreign');
      const run = await insertRun({ createdAt: new Date('2026-10-18T10:00:00Z'), taskId: mine.id });
      for (const data of [
        'h:zzz',
        'r:!!!!!!!!!!!!!!!!!!!!!!:*',
        `rs:${'A'.repeat(21)}_`,
        'h:*:o:x',
      ]) {
        await press(data);
      }
      const reasons = await h.prisma.telegramUpdate.findMany({
        orderBy: { updateId: 'asc' },
        select: { disposition: true, reason: true },
      });
      expect(reasons).toEqual(
        Array.from({ length: 4 }, () => ({ disposition: 'IGNORED', reason: 'CALLBACK_UNKNOWN' })),
      );
      await press(historyCallbackData({ taskId: foreignTask.id }));
      await press(taskCallbackData(foreignTask.id, 1, 'lr'));
      await drainDeliveries(h);
      expect(h.sender.sent.map((m) => visible(m.html))).toEqual([
        'Завдання не знайдено.',
        'Завдання не знайдено.',
      ]);

      // The task's own history and latest result.
      await press(taskCallbackData(mine.id, 1, 'h'));
      await drainDeliveries(h);
      expect(runIdsOnPage()).toEqual([compactId(run.id)]);
      await press(taskCallbackData(mine.id, 999, 'lr')); // read-only: any revision shows current state
      await drainDeliveries(h);
      expect(lastText()).toContain(`Запуск ${run.id}`);

      // Deleting the task hides its runs everywhere, including /result.
      await h.prisma.task.update({
        where: { id: mine.id },
        data: { state: 'DELETED', deletedAt: new Date() },
      });
      h.sender.sent.length = 0;
      await say('/history');
      await press(runCallbackData(run.id, 'all'));
      await press(resendCallbackData(run.id));
      await say(`/result ${run.id}`);
      await press(taskCallbackData(mine.id, 1, 'h'));
      await drainDeliveries(h);
      const texts = h.sender.sent.map((m) => visible(m.html));
      expect(texts[0]).toContain('Запусків ще немає');
      expect(texts.slice(1)).toEqual([
        'Запуск не знайдено.',
        'Запуск не знайдено.',
        'Запуск не знайдено.',
        'Завдання не знайдено.',
      ]);
      expect(await h.prisma.delivery.count({ where: { kind: 'RESEND' } })).toBe(0);
    });

    it('shows manual and scheduled runs with planned and actual times, states and usage', async () => {
      const task = await ownTask();
      await insertRun({
        createdAt: new Date('2026-10-18T06:00:05Z'),
        taskId: task.id,
        scheduled: {
          occurrenceAt: new Date('2026-10-18T06:00:00Z'),
          startedAt: new Date('2026-10-18T06:42:00Z'),
        },
        report: 'UNKNOWN',
      });
      await insertRun({ createdAt: new Date('2026-10-18T09:00:00Z'), report: 'SUPPRESSED' });
      await say('/history');
      await drainDeliveries(h);
      expect(shown()).toEqual([
        '2026-10-18 12:00 · вручну · /research · завершено: знайдено · доставка: не надсилалося (чат був недоступний) · симуляція',
        '2026-10-18 09:00 (факт 09:42) · за розкладом · «Daily» · завершено: знайдено · доставка: невідомо (могло надійти) · симуляція',
      ]);
      await press(button('2'));
      await drainDeliveries(h);
      const card = lastText();
      expect(card).toContain('Тип: за розкладом');
      expect(card).toContain('Заплановано на: 2026-10-18 09:00 (Europe/Kyiv)');
      expect(card).toContain(
        'Фактичний початок: 2026-10-18 09:42 (Europe/Kyiv) — на 42 хв пізніше запланованого',
      );
      expect(card).toContain('Дослідження: завершено успішно');
      expect(card).toContain('Доставка звіту: невідомо (могло надійти)');
      expect(card).toContain('могло вже дійти');
      expect(card).toContain('Витрати: немає (симуляція');
      expect(button('можливий дубль')).toMatch(/^rs:/);
    });

    it('resends stored content from a task card, preserving evidence and costing no research', async () => {
      const live = await start({}, true);
      h = live;
      const task = await ownTask();
      await press(taskCallbackData(task.id, 1, 'r'), ADMIN_ID, live);
      expect(await live.research.tick()).toBe(true);
      await drainDeliveries(live);
      const run = await live.prisma.researchRun.findFirstOrThrow();
      const original = await reportOf(run.id);
      const before = await evidence();
      const usageBefore = await live.prisma.researchRun.count({
        where: { admittedDay: run.admittedDay },
      });

      live.sender.sent.length = 0;
      await press(taskCallbackData(task.id, 1, 'lr'), ADMIN_ID, live);
      await drainDeliveries(live);
      expect(lastText(live)).toContain('Витрати: оцінка ≈ $');
      expect(lastText(live)).toContain('Доставка звіту: доставлено');
      const resend = button('Надіслати звіт', live);
      // The same Telegram update delivered twice creates one resend.
      const update = callbackQuery(resend);
      await live.post(update).expect(200);
      await live.post(update).expect(200);
      await drainDeliveries(live);

      const resends = await live.prisma.delivery.findMany({
        where: { kind: 'RESEND' },
        include: { parts: { orderBy: { ordinal: 'asc' } } },
      });
      expect(resends).toHaveLength(1);
      expect(resends[0]?.parts.map((p) => p.html)).toEqual(original.parts.map((p) => p.html));
      expect(live.sender.sent.slice(1).map((m) => m.html)).toEqual(
        original.parts.map((p) => p.html),
      );
      expect(await reportOf(run.id)).toEqual(original);
      expect(await evidence()).toEqual(before);
      expect(await live.prisma.researchRun.count({ where: { admittedDay: run.admittedDay } })).toBe(
        usageBefore,
      );
      expect(live.provider.calls.submit).toBe(1);
    });

    it('explains an UNKNOWN original delivery before resending it', async () => {
      const run = await researched();
      h.sender.failNext(telegramTimeout());
      await drainDeliveries(h);
      h.sender.sent.length = 0;
      await press(runCallbackData(run.id, 'all'));
      await drainDeliveries(h);
      expect(lastText()).toContain('могло вже дійти');
      await press(button('можливий дубль'));
      await drainDeliveries(h);
      const texts = h.sender.sent.map((m) => visible(m.html));
      expect(texts.at(-2)).toContain('повідомлення могло вже надійти');
      expect(texts.at(-1)).toContain(REPORT_TITLE);
      expect(await reportOf(run.id)).toMatchObject({ state: 'UNKNOWN' });
    });

    it('never releases suppressed automatic deliveries after reactivation; an explicit resend works', async () => {
      await h.prisma.$executeRaw`
        INSERT INTO app_user (id, telegram_user_id, private_chat_id, role, onboarding_state, time_zone,
                              invited_at, onboarded_at, updated_at)
        VALUES (gen_random_uuid(), 3003, 3003, 'MEMBER', 'COMPLETED', 'Europe/Kyiv', now(), now(), now())`;
      await say('/research member topic', 3003);
      expect(await h.research.tick()).toBe(true);
      const run = await h.prisma.researchRun.findFirstOrThrow();
      await h.deliveryDispatcher.dispatchDue(); // jobs published before the suspension
      await say('/admin suspend 3003');
      await say('/admin reactivate 3003');
      await drainDeliveries(h);
      expect(h.sender.sent.filter((m) => m.chatId === 3003n)).toHaveLength(0);
      expect(await reportOf(run.id)).toMatchObject({
        state: 'SUPPRESSED',
        lastErrorCode: 'RECIPIENT_SUSPENDED',
      });

      await press(runCallbackData(run.id, 'all'), 3003);
      await drainDeliveries(h);
      await press(button('Надіслати звіт'), 3003);
      await drainDeliveries(h);
      const toMember = h.sender.sent.filter((m) => m.chatId === 3003n).map((m) => m.html);
      expect(toMember.at(-1)).toContain(REPORT_TITLE);
      expect(await reportOf(run.id)).toMatchObject({ state: 'SUPPRESSED' });
      expect(h.provider.calls.submit).toBe(1);
    });
  });

  describe('blocked private chat', () => {
    const DAY = 24 * 3_600_000;

    it('pauses automatic research, releases queued reservations, suppresses deliveries and recovers only explicitly', async () => {
      const live = await start({}, true);
      h = live;
      const userId = await adminId();
      const scheduled = await h.prisma.task.create({
        data: {
          userId,
          name: 'Daily',
          prompt: 'p',
          scheduleKind: 'DAILY',
          localTime: '09:00',
          timeZone: 'Europe/Kyiv',
          nextRunAt: new Date('2026-10-19T06:00:00Z'),
        },
      });
      const other = await h.prisma.task.create({
        data: {
          userId,
          name: 'Other',
          prompt: 'p',
          scheduleKind: 'WEEKLY',
          weekday: 5,
          localTime: '10:00',
          timeZone: 'Europe/Kyiv',
          nextRunAt: new Date('2026-10-23T07:00:00Z'),
        },
      });
      clock.set('2026-10-19T06:00:10Z');
      await live.scheduler.tick();
      const queued = await h.prisma.researchRun.findFirstOrThrow({
        where: { trigger: 'SCHEDULED' },
      });
      expect(queued.state).toBe('QUEUED');
      await say('/usage', ADMIN_ID, live); // a waiting reply

      // Telegram confirms the block on the first send.
      live.sender.failNext(telegramBlocked());
      await drainDeliveries(live);
      expect(live.sender.attempts).toHaveLength(1);
      const user = await h.prisma.appUser.findUniqueOrThrow({ where: { id: userId } });
      expect(user).toMatchObject({ chatBlockReason: 'BOT_BLOCKED' });
      expect(user.chatBlockedAt).toBeInstanceOf(Date);
      for (const id of [scheduled.id, other.id]) {
        expect(await h.prisma.task.findUniqueOrThrow({ where: { id } })).toMatchObject({
          state: 'PAUSED',
          nextRunAt: null,
        });
      }
      expect(
        await h.prisma.researchRun.findUniqueOrThrow({ where: { id: queued.id } }),
      ).toMatchObject({
        state: 'CANCELLED',
        failureCode: 'CHAT_BLOCKED',
      });
      expect(
        (
          await h.prisma.usageLedger.findMany({
            where: { runId: queued.id },
            orderBy: { createdAt: 'asc' },
          })
        ).map((entry) => entry.kind),
      ).toEqual(['RESERVE', 'RELEASE']);
      expect(
        await h.prisma.budgetReservation.findFirstOrThrow({ where: { runId: queued.id } }),
      ).toMatchObject({
        status: 'RELEASED',
      });
      const deliveries = await h.prisma.delivery.findMany({
        select: { state: true, lastErrorCode: true },
      });
      expect(deliveries).toEqual([{ state: 'PERMANENT_FAILURE', lastErrorCode: 'TELEGRAM_403' }]);
      const audit = await h.prisma.auditEvent.findFirstOrThrow({
        where: { kind: 'DESTINATION_BLOCKED' },
      });
      expect(audit.details).toMatchObject({
        reason: 'BOT_BLOCKED',
        pausedTasks: 2,
        cancelledRuns: 1,
      });

      // Nothing automatic happens while blocked; new automatic messages are stored suppressed.
      clock.set(new Date(clock.now().getTime() + 2 * DAY));
      await live.scheduler.tick();
      expect(await h.prisma.scheduleEvent.count()).toBe(1);
      expect(await h.prisma.researchRun.count()).toBe(1);
      await h.prisma.$transaction((tx) =>
        createStatusDelivery(tx, BigInt(ADMIN_ID), 'automatic notice'),
      );
      await drainDeliveries(live);
      expect(live.sender.attempts).toHaveLength(1);
      expect(
        await h.prisma.delivery.findFirstOrThrow({
          where: { kind: 'STATUS', state: 'SUPPRESSED' },
        }),
      ).toMatchObject({
        lastErrorCode: 'CHAT_BLOCKED',
      });

      // The user unblocks and writes again: the chat is restored, tasks stay paused.
      await say('/start', ADMIN_ID, live);
      await drainDeliveries(live);
      const texts = live.sender.sent.map((m) => visible(m.html));
      expect(texts[0]).toContain('Бот знову може надсилати вам повідомлення');
      expect(texts[0]).toContain('завдань на паузі зараз — 2');
      expect(texts).toHaveLength(2); // the notice and the /start reply; nothing suppressed is released
      expect(
        (await h.prisma.appUser.findUniqueOrThrow({ where: { id: userId } })).chatBlockedAt,
      ).toBeNull();
      expect(await h.prisma.auditEvent.count({ where: { kind: 'DESTINATION_RESTORED' } })).toBe(1);
      expect(await h.prisma.task.count({ where: { state: 'PAUSED' } })).toBe(2);

      // Explicit resume: the next future occurrence, no replay of what was missed.
      const paused = await h.prisma.task.findUniqueOrThrow({ where: { id: scheduled.id } });
      await press(taskCallbackData(paused.id, paused.revision, 'u'), ADMIN_ID, live);
      const resumed = await h.prisma.task.findUniqueOrThrow({ where: { id: scheduled.id } });
      expect(resumed.state).toBe('ACTIVE');
      expect(resumed.nextRunAt).toEqual(new Date('2026-10-22T06:00:00Z'));
      await live.scheduler.tick();
      expect(await h.prisma.scheduleEvent.count()).toBe(1);
      expect(await h.prisma.researchRun.count()).toBe(1);
    });

    it('lets running research finish with its report stored and suppressed; it stays resendable', async () => {
      let polls = 0;
      h.provider.onRetrieve = async (id) => {
        polls += 1;
        if (polls === 1) {
          // Another delivery to this chat reveals the block while the request runs.
          h.sender.failNext(telegramBlocked());
          await drainDeliveries(h);
          return snapshot(h.provider.echo, { id, status: 'in_progress' });
        }
        return {
          ...completed([
            buildTextPart([
              'OUTCOME: FOUND\nClaim.',
              { cite: { url: 'https://a.example/', title: 'A' } },
            ]),
          ]),
          id,
          bounds: echoed(h.provider.echo),
        };
      };
      await say('/research running');
      expect(await h.research.tick()).toBe(true);
      const run = await h.prisma.researchRun.findFirstOrThrow();
      expect(run).toMatchObject({
        state: 'SUCCEEDED',
        deliverySuppressionReason: 'CHAT_BLOCKED',
      });
      expect(run.reportText).toBeTruthy();
      expect(await reportOf(run.id)).toMatchObject({
        state: 'SUPPRESSED',
        lastErrorCode: 'CHAT_BLOCKED',
      });
      await drainDeliveries(h);
      expect(h.sender.sent).toHaveLength(0);

      await say(`/result ${run.id}`); // writing restores the chat; the resend is explicit
      await drainDeliveries(h);
      expect(h.sender.sent.at(-1)?.html).toContain(REPORT_TITLE);
      expect(await reportOf(run.id)).toMatchObject({ state: 'SUPPRESSED' });
      expect(h.provider.calls.submit).toBe(1);
    });
  });

  describe('review fixes (commit f23221c)', () => {
    const MEMBER = 3003;
    const addMember = () =>
      h.prisma.$executeRaw`
        INSERT INTO app_user (id, telegram_user_id, private_chat_id, role, onboarding_state, time_zone,
                              invited_at, onboarded_at, updated_at)
        VALUES (gen_random_uuid(), ${MEMBER}, ${MEMBER}, 'MEMBER', 'COMPLETED', 'Europe/Kyiv', now(), now(), now())`;
    const toChat = (chat: number) => h.sender.sent.filter((m) => m.chatId === BigInt(chat));
    const rateLimited = (seconds?: number) =>
      new TelegramSendError('TELEGRAM_429', 'not_sent', false, seconds);
    /** Holds the first send in flight until `release`, then fails it with `failure`. */
    const holdFirstSend = (failure: TelegramSendError) => {
      const inFlight = gate();
      const release = gate();
      let first = true;
      h.sender.beforeSend = async () => {
        if (!first) return;
        first = false;
        inFlight.open();
        await release.promise;
        throw failure;
      };
      return { inFlight, release };
    };
    const makeDue = async () => {
      await h.prisma
        .$executeRaw`UPDATE delivery SET next_attempt_at = now() WHERE state = 'RETRYABLE_FAILURE'`;
      await h.prisma
        .$executeRaw`UPDATE delivery_event SET available_at = now() WHERE dispatched_at IS NULL AND cancelled_at IS NULL`;
    };
    const secondsUntil = (instant: Date) => (instant.getTime() - Date.now()) / 1000;

    describe('Finding 1: suppression during a send never strands the chat', () => {
      it('finalizes a delivery suspended in flight and refused with 429; later messages flow after reactivation', async () => {
        await addMember();
        const run = await researched(h, 'member topic', MEMBER);
        const report = await reportOf(run.id);
        const { inFlight, release } = holdFirstSend(rateLimited(1));
        const sending = h.delivery.handle(report.id);
        await inFlight.promise;
        await say(`/admin suspend ${MEMBER}`);
        release.open();
        await sending;

        expect(await reportOf(run.id)).toMatchObject({
          state: 'SUPPRESSED',
          lastErrorCode: 'RECIPIENT_SUSPENDED',
        });
        expect((await reportOf(run.id)).parts[0]).toMatchObject({
          state: 'PENDING',
          errorCode: 'TELEGRAM_429',
        });
        expect(await pendingEvents(report.id)).toHaveLength(0);

        await say(`/admin reactivate ${MEMBER}`);
        await makeDue();
        await drainDeliveries(h);
        await say('/help', MEMBER);
        await drainDeliveries(h);
        expect(toChat(MEMBER).map((m) => visible(m.html))).toEqual([
          expect.stringContaining('/history'),
        ]);
        expect((await reportOf(run.id)).suppressedAt).toBeInstanceOf(Date);
        expect(h.sender.attempts.filter((a) => a.html.includes(REPORT_TITLE))).toHaveLength(1);
      });

      it('finalizes a delivery whose task is deleted in flight and refused with 5xx', async () => {
        const task = await h.prisma.task.create({
          data: {
            userId: await adminId(),
            name: 'Task',
            prompt: 'p',
            scheduleKind: 'MANUAL',
            timeZone: 'Europe/Kyiv',
          },
        });
        await press(taskCallbackData(task.id, 1, 'r'));
        expect(await h.research.tick()).toBe(true);
        const run = await h.prisma.researchRun.findFirstOrThrow();
        const ack = await h.prisma.delivery.findFirstOrThrow({
          where: { runId: run.id, kind: 'STATUS' },
        });
        expect(await h.delivery.handle(ack.id)).toBe('sent');
        const report = await reportOf(run.id);
        const { inFlight, release } = holdFirstSend(telegramServerError());
        const sending = h.delivery.handle(report.id);
        await inFlight.promise;
        await press(taskCallbackData(task.id, 1, 'dy'));
        release.open();
        await sending;

        expect(await reportOf(run.id)).toMatchObject({
          state: 'SUPPRESSED',
          lastErrorCode: 'TASK_DELETED',
        });
        await makeDue();
        h.sender.sent.length = 0;
        await drainDeliveries(h);
        await say('/help');
        await drainDeliveries(h);
        const texts = h.sender.sent.map((m) => visible(m.html));
        expect(texts.some((t) => t.includes('видалено'))).toBe(true); // the deletion reply
        expect(texts.at(-1)).toContain('/history');
        expect(texts.some((t) => t.includes(REPORT_TITLE))).toBe(false);
      });

      it('finalizes a delivery suppressed before a shutdown hand-over, keeping the confirmed part', async () => {
        await addMember();
        completeWith(h, unicodeReport(40));
        const run = await researched(h, 'member long', MEMBER);
        const report = await reportOf(run.id);
        const stop = new AbortController();
        h.sender.beforeSend = async () => {
          await say(`/admin suspend ${MEMBER}`);
          stop.abort();
        };
        expect(await h.delivery.handle(report.id, stop.signal)).toBe('stopped');
        h.sender.beforeSend = () => Promise.resolve();

        const current = await reportOf(run.id);
        expect(current).toMatchObject({
          state: 'SUPPRESSED',
          lastErrorCode: 'RECIPIENT_SUSPENDED',
        });
        expect(current.parts[0]).toMatchObject({ state: 'SENT' });
        expect(current.parts[0]?.telegramMessageId).toBe(BigInt(toChat(MEMBER)[0]?.messageId ?? 0));
        expect(current.parts.slice(1).every((p) => p.state === 'PENDING')).toBe(true);
        expect(await pendingEvents(report.id)).toHaveLength(0);

        await say(`/admin reactivate ${MEMBER}`);
        await say('/help', MEMBER);
        await drainDeliveries(h);
        expect(toChat(MEMBER)).toHaveLength(2);
        expect(visible(toChat(MEMBER)[1]?.html ?? '')).toContain('/history');
      });

      it('repairs waiting deliveries already stranded with a suppression decision', async () => {
        const stranded = [];
        for (const state of ['RETRYABLE_FAILURE', 'PENDING'] as const) {
          stranded.push(
            await h.prisma.delivery.create({
              data: {
                kind: 'STATUS',
                chatId: BigInt(ADMIN_ID),
                state,
                suppressedAt: new Date(),
                nextAttemptAt: new Date(Date.now() + 3_600_000),
                parts: { create: [{ ordinal: 0, html: `stranded ${state}`, contentHash: 'x' }] },
              },
            }),
          );
        }
        await say('/help');
        await drainDeliveries(h);
        expect(h.sender.sent.map((m) => visible(m.html))).toEqual([
          expect.stringContaining('/history'),
        ]);
        for (const delivery of stranded) {
          expect(
            await h.prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } }),
          ).toMatchObject({
            state: 'SUPPRESSED',
            lastErrorCode: 'RECIPIENT_SUSPENDED',
          });
        }
      });

      it('keeps an ambiguous in-flight send UNKNOWN even when suppressed meanwhile', async () => {
        await addMember();
        const run = await researched(h, 'member topic', MEMBER);
        const report = await reportOf(run.id);
        const { inFlight, release } = holdFirstSend(telegramTimeout());
        const sending = h.delivery.handle(report.id);
        await inFlight.promise;
        await say(`/admin suspend ${MEMBER}`);
        release.open();
        await sending;
        expect(await reportOf(run.id)).toMatchObject({
          state: 'UNKNOWN',
          lastErrorCode: 'TELEGRAM_NETWORK',
        });
        await h.deliveryDispatcher.sweep();
        await drainDeliveries(h);
        expect(h.sender.attempts.filter((a) => a.html.includes(REPORT_TITLE))).toHaveLength(1);
      });
    });

    describe('Finding 2: a confirmed block survives a failure after the refusal is recorded', () => {
      const failBlockStep = () =>
        h.prisma.$executeRawUnsafe(`
          CREATE OR REPLACE FUNCTION test_fail_block() RETURNS trigger AS $$
          BEGIN
            IF NEW.chat_blocked_at IS NOT NULL AND OLD.chat_blocked_at IS NULL THEN
              RAISE EXCEPTION 'injected failure applying the destination block';
            END IF;
            RETURN NEW;
          END $$ LANGUAGE plpgsql;
          CREATE TRIGGER test_fail_block BEFORE UPDATE ON app_user
            FOR EACH ROW EXECUTE FUNCTION test_fail_block();`);
      const healBlockStep = async () => {
        await h.prisma.$executeRawUnsafe('DROP TRIGGER test_fail_block ON app_user');
        await h.prisma.$executeRawUnsafe('DROP FUNCTION test_fail_block()');
      };
      /** Live mode: an active daily task with a queued scheduled run, and a waiting reply. */
      const setUp = async () => {
        const live = await start({}, true);
        h = live;
        const task = await h.prisma.task.create({
          data: {
            userId: await adminId(),
            name: 'Daily',
            prompt: 'p',
            scheduleKind: 'DAILY',
            localTime: '09:00',
            timeZone: 'Europe/Kyiv',
            nextRunAt: new Date('2026-10-19T06:00:00Z'),
          },
        });
        clock.set('2026-10-19T06:00:10Z');
        await live.scheduler.tick();
        const queued = await h.prisma.researchRun.findFirstOrThrow({
          where: { trigger: 'SCHEDULED' },
        });
        const usage = privateMessage('/usage', ADMIN_ID);
        await live.post(usage).expect(200);
        await failBlockStep();
        live.sender.failNext(telegramBlocked());
        await expect(drainDeliveries(live)).rejects.toThrow();
        const failed = await h.prisma.delivery.findFirstOrThrow({ where: { kind: 'STATUS' } });
        expect(failed).toMatchObject({ state: 'PERMANENT_FAILURE', lastErrorCode: 'TELEGRAM_403' });
        await healBlockStep();
        return { live, task, queued, failed, usage };
      };
      const ledgerKinds = async (runId: string) =>
        (
          await h.prisma.usageLedger.findMany({ where: { runId }, orderBy: { createdAt: 'asc' } })
        ).map((entry) => entry.kind);

      it('applies the recorded block after a restart, once, without resending', async () => {
        const { live, task, queued } = await setUp();
        expect(
          (await h.prisma.appUser.findUniqueOrThrow({ where: { id: await adminId() } }))
            .chatBlockedAt,
        ).toBeNull();
        await close(live);
        h = await start({}, true);
        await h.deliveryDispatcher.sweep();
        await h.deliveryDispatcher.sweep(); // replay
        await drainDeliveries(h);

        const user = await h.prisma.appUser.findUniqueOrThrow({ where: { id: await adminId() } });
        expect(user).toMatchObject({ chatBlockReason: 'BOT_BLOCKED' });
        expect(await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
          state: 'PAUSED',
          nextRunAt: null,
        });
        expect(
          await h.prisma.researchRun.findUniqueOrThrow({ where: { id: queued.id } }),
        ).toMatchObject({
          state: 'CANCELLED',
          failureCode: 'CHAT_BLOCKED',
        });
        expect(await ledgerKinds(queued.id)).toEqual(['RESERVE', 'RELEASE']);
        expect(await h.prisma.auditEvent.count({ where: { kind: 'DESTINATION_BLOCKED' } })).toBe(1);
        expect(h.sender.attempts).toHaveLength(0);
        expect(h.provider.calls.submit).toBe(0);

        // Nothing resumes automatically.
        clock.set('2026-10-21T06:00:10Z');
        await h.scheduler.tick();
        expect(await h.prisma.researchRun.count()).toBe(1);
      });

      it('does not re-block a chat the user restored before the recorded block was applied', async () => {
        const { live, task } = await setUp();
        await say('/help', ADMIN_ID, live); // the user writes again: the chat works
        await drainDeliveries(live);
        await live.deliveryDispatcher.sweep();
        await drainDeliveries(live);

        expect(
          (await h.prisma.appUser.findUniqueOrThrow({ where: { id: await adminId() } }))
            .chatBlockedAt,
        ).toBeNull();
        expect(await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
          state: 'ACTIVE',
        });
        expect(await h.prisma.auditEvent.count({ where: { kind: 'DESTINATION_BLOCKED' } })).toBe(0);
        expect(
          await h.prisma.delivery.count({
            where: { destinationBlockAppliedAt: null, destinationBlockReason: { not: null } },
          }),
        ).toBe(0);
        expect(live.sender.sent.map((m) => visible(m.html)).at(-1)).toContain('/history');
      });

      describe('follow-up: only a verified private interaction supersedes a recorded block', () => {
        /** The recorded block is applied, once, with all its effects, and nothing is resent. */
        const expectBlockApplied = async (
          harness: Harness,
          task: { id: string },
          queued: { id: string },
          attemptsBefore: number,
        ) => {
          await harness.deliveryDispatcher.sweep();
          await harness.deliveryDispatcher.sweep(); // replay
          await drainDeliveries(harness);
          const user = await h.prisma.appUser.findUniqueOrThrow({ where: { id: await adminId() } });
          expect(user.chatBlockReason).toBe('BOT_BLOCKED');
          expect(await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
            state: 'PAUSED',
            nextRunAt: null,
          });
          expect(
            await h.prisma.researchRun.findUniqueOrThrow({ where: { id: queued.id } }),
          ).toMatchObject({
            state: 'CANCELLED',
            failureCode: 'CHAT_BLOCKED',
          });
          expect(await ledgerKinds(queued.id)).toEqual(['RESERVE', 'RELEASE']);
          expect(await h.prisma.auditEvent.count({ where: { kind: 'DESTINATION_BLOCKED' } })).toBe(
            1,
          );
          expect(
            await h.prisma.delivery.count({
              where: { destinationBlockReason: { not: null }, destinationBlockAppliedAt: null },
            }),
          ).toBe(0);
          expect(harness.sender.attempts).toHaveLength(attemptsBefore);
          expect(harness.provider.calls.submit).toBe(0);
        };

        it('ignores a later group message from the same user and still applies the block', async () => {
          const { live, task, queued, usage } = await setUp();
          const attempts = live.sender.attempts.length;
          await live.post(groupMessage('/help', ADMIN_ID)).expect(200);
          await live.post(usage).expect(200); // a duplicate update creates no evidence
          expect(
            await h.prisma.telegramUpdate.findFirstOrThrow({ where: { chatType: 'supergroup' } }),
          ).toMatchObject({ disposition: 'IGNORED', reason: 'NOT_PRIVATE_CHAT' });
          await expectBlockApplied(live, task, queued, attempts);
        });

        it('ignores private updates that fail the transport and identity checks', async () => {
          const { live, task, queued } = await setUp();
          const attempts = live.sender.attempts.length;
          const foreignChat = privateMessage('/help', ADMIN_ID);
          foreignChat.message.chat.id = OTHER_ADMIN_ID; // chat is not the sender's own
          const fromBot = privateMessage('/help', ADMIN_ID);
          fromBot.message.from.is_bot = true;
          await live.post(foreignChat).expect(200);
          await live.post(fromBot).expect(200);
          expect(
            (await h.prisma.telegramUpdate.findMany({ where: { disposition: 'IGNORED' } })).map(
              (row) => row.reason,
            ),
          ).toEqual(['CHAT_SENDER_MISMATCH', 'BOT_SENDER']);
          await expectBlockApplied(live, task, queued, attempts);
        });

        it('lets a verified private interaction supersede it, even one that gets a refusal reply', async () => {
          const { live, task } = await setUp();
          await live.post(privateMessage('/nosuchcommand', ADMIN_ID)).expect(200);
          await live.deliveryDispatcher.sweep();
          await drainDeliveries(live);
          expect(
            (await h.prisma.appUser.findUniqueOrThrow({ where: { id: await adminId() } }))
              .chatBlockedAt,
          ).toBeNull();
          expect(await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({
            state: 'ACTIVE',
          });
          expect(await h.prisma.auditEvent.count({ where: { kind: 'DESTINATION_BLOCKED' } })).toBe(
            0,
          );
          expect(visible(live.sender.sent.at(-1)?.html ?? '')).toContain('Невідома команда');
        });
      });
    });

    describe('Finding 3: Retry-After is honoured in full', () => {
      it('keeps a 7200 s Retry-After across early wake-ups, duplicate jobs and a restart', async () => {
        await say('/help');
        h.sender.failNext(rateLimited(7200));
        expect(await h.delivery.tick()).toBe(true);
        const delivery = await h.prisma.delivery.findFirstOrThrow();
        expect(delivery.state).toBe('RETRYABLE_FAILURE');
        expect(secondsUntil(delivery.nextAttemptAt)).toBeGreaterThan(7190);
        expect(secondsUntil(delivery.nextAttemptAt)).toBeLessThanOrEqual(7200);

        // Early and duplicate wake-ups only re-inspect.
        await h.prisma
          .$executeRaw`UPDATE delivery_event SET available_at = now() WHERE dispatched_at IS NULL`;
        await h.prisma.$transaction((tx) =>
          h.queue.publishDelivery(tx, { deliveryId: delivery.id, eventId: randomUUID() }),
        );
        await drainDeliveries(h);
        await close(h);
        h = await start();
        await h.prisma
          .$executeRaw`UPDATE delivery_event SET available_at = now() WHERE dispatched_at IS NULL`;
        await drainDeliveries(h);
        expect(h.sender.attempts).toHaveLength(0);
        const waiting = await h.prisma.delivery.findFirstOrThrow();
        expect(waiting.nextAttemptAt).toEqual(delivery.nextAttemptAt);
        expect(await pendingEvents(delivery.id)).toHaveLength(1);

        // Eligible only once the full interval has passed.
        await makeDue();
        await drainDeliveries(h);
        expect(await h.prisma.delivery.findFirstOrThrow()).toMatchObject({
          state: 'SENT',
          attempts: 2,
        });
      });

      it('honours a short Retry-After, and falls back to bounded backoff for missing or invalid values', async () => {
        const cases: [number | undefined, number, number][] = [
          [2, 1, 2], // provider value
          [undefined, 4, 5], // missing: backoff 5 s
          [0, 4, 5], // invalid: backoff, never an immediate retry
          [-3, 4, 5],
          [Number.NaN, 4, 5],
          [1.5, 4, 5],
        ];
        for (const [retryAfter, min, max] of cases) {
          await h.prisma.$executeRawUnsafe(
            'TRUNCATE delivery_event, delivery_part, delivery CASCADE',
          );
          await say('/help');
          h.sender.failNext(rateLimited(retryAfter));
          await h.delivery.tick();
          const delivery = await h.prisma.delivery.findFirstOrThrow();
          expect(delivery.state, String(retryAfter)).toBe('RETRYABLE_FAILURE');
          const wait = secondsUntil(delivery.nextAttemptAt);
          expect(wait, String(retryAfter)).toBeGreaterThan(min - 0.5);
          expect(wait, String(retryAfter)).toBeLessThanOrEqual(max);
        }
        // Application backoff grows and stays bounded.
        await h.prisma.$executeRaw`UPDATE delivery SET attempts = 3`;
        await makeDue();
        h.sender.failNext(rateLimited(undefined));
        await h.delivery.tick();
        const later = await h.prisma.delivery.findFirstOrThrow();
        expect(secondsUntil(later.nextAttemptAt)).toBeGreaterThan(35);
        expect(secondsUntil(later.nextAttemptAt)).toBeLessThanOrEqual(40);
      });
    });
  });
});
