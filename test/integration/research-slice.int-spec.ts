import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTextPart } from '../../src/research/provider/fake-fixtures';
import type { ProviderSnapshot } from '../../src/research/provider/provider.types';
import {
  completed,
  notAccepted,
  snapshot,
  telegramBlocked,
  telegramRateLimited,
  telegramTimeout,
  unknownOutcome,
} from '../support/fakes';
import {
  ADMIN_ID,
  BOT_TOKEN,
  OTHER_ADMIN_ID,
  WEBHOOK_SECRET,
  drainDeliveries,
  groupMessage,
  privateMessage,
  resetDatabase,
  startHarness,
  type Harness,
} from '../support/research-harness';

describe('research-to-Telegram slice (fake provider and Telegram, real PostgreSQL)', () => {
  let h: Harness;
  const extra: Harness[] = [];

  beforeEach(async () => {
    h = await startHarness();
    await resetDatabase(h.prisma);
  });

  afterEach(async () => {
    for (const harness of [h, ...extra.splice(0)]) await harness.close();
  });

  const runs = () => h.prisma.researchRun.findMany({ orderBy: { createdAt: 'asc' } });
  const deliveries = () =>
    h.prisma.delivery.findMany({ orderBy: { createdAt: 'asc' }, include: { parts: true } });

  describe('webhook ingress', () => {
    it('rejects missing or wrong secrets before touching the database', async () => {
      await h.post(privateMessage('/research football'), null).expect(401);
      await h.post(privateMessage('/research football'), 'wrong_secret').expect(401);
      expect(await h.prisma.telegramUpdate.count()).toBe(0);
      expect(await h.prisma.researchRun.count()).toBe(0);
    });

    it('is not exposed unless TELEGRAM_MODE=webhook', async () => {
      const off = await startHarness({ TELEGRAM_MODE: 'disabled' });
      extra.push(off);
      await off.post(privateMessage('/research football')).expect(404);
    });

    it('rejects unregistered users and group chats without creating research', async () => {
      await h.post(privateMessage('/research football', 2002)).expect(200);
      await h.post(groupMessage('/research football')).expect(200);
      await h.research.tick();

      expect(await h.prisma.researchRun.count()).toBe(0);
      expect(h.provider.calls.submit).toBe(0);
      const updates = await h.prisma.telegramUpdate.findMany({ orderBy: { updateId: 'asc' } });
      expect(updates.map((u) => [u.disposition, u.reason])).toEqual([
        ['REJECTED', 'NOT_REGISTERED'],
        ['IGNORED', 'NOT_PRIVATE_CHAT'],
      ]);
      // Only the private unregistered user gets a generic reply; nothing is sent to the group.
      const sent = await deliveries();
      expect(sent.map((d) => d.chatId)).toEqual([2002n]);
    });

    it('turns a replayed update into exactly one research run', async () => {
      const update = privateMessage('/research football');
      await h.post(update).expect(200);
      await h.post(update).expect(200);
      await Promise.all([h.post(update), h.post(update)]);

      expect(await h.prisma.researchRun.count()).toBe(1);
      expect(await h.prisma.telegramUpdate.count()).toBe(1);
      expect(await h.prisma.delivery.count()).toBe(1); // one acknowledgment
    });

    it('persists accepted work before acknowledging and does not wait for research', async () => {
      let finishSubmit: (snapshot: ProviderSnapshot) => void = () => undefined;
      h.provider.onSubmit = () => new Promise((resolve) => (finishSubmit = resolve));

      const response = await h.post(privateMessage('/research football')).expect(200);
      expect(response.body).toEqual({ ok: true });
      const [run] = await runs();
      expect(run).toMatchObject({ state: 'QUEUED', chatId: BigInt(ADMIN_ID), prompt: 'football' });
      expect(h.provider.calls.submit).toBe(0);

      const ticking = h.research.tick();
      await vi.waitFor(() => expect(h.provider.calls.submit).toBe(1));
      // Research is now pending at the provider; ingress and delivery still work.
      await h.post(privateMessage('/help')).expect(200);
      await drainDeliveries(h);
      expect(h.sender.sent.map((s) => s.html.split('\n')[0])).toEqual([
        'Запит прийнято (СИМУЛЯЦІЯ, без реального пошуку).',
        'Приватний дослідницький бот (прототип).',
      ]);
      expect((await runs())[0]).toMatchObject({ state: 'RUNNING', submissionState: 'SUBMITTING' });

      finishSubmit(snapshot(h.provider.requests[0] ?? null));
      await ticking;
      expect((await runs())[0]?.state).toBe('SUCCEEDED');
    });

    it('refuses research without a provider call when research is disabled', async () => {
      const disabled = await startHarness({ RESEARCH_MODE: 'disabled' });
      extra.push(disabled);
      await disabled.post(privateMessage('/research football')).expect(200);
      expect(await disabled.research.tick()).toBe(false);
      expect(await disabled.prisma.researchRun.count()).toBe(0);
      expect(disabled.provider.calls.submit).toBe(0);
      await drainDeliveries(disabled);
      expect(disabled.sender.sent[0]?.html).toBe('Дослідження зараз вимкнено оператором.');
    });

    it('bounds the queue under concurrent requests', async () => {
      const limited = await startHarness({ RESEARCH_QUEUE_LIMIT: '2' });
      extra.push(limited);
      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) => limited.post(privateMessage(`/research topic ${i}`))),
      );
      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(await limited.prisma.researchRun.count()).toBe(2);
      expect(await limited.prisma.telegramUpdate.count({ where: { reason: 'QUEUE_FULL' } })).toBe(
        4,
      );
    });
  });

  describe('execution', () => {
    it('allows only one running research request across concurrent workers', async () => {
      const second = await startHarness();
      extra.push(second);
      await h.post(privateMessage('/research one')).expect(200);
      await h.post(privateMessage('/research two')).expect(200);

      const release: (() => void)[] = [];
      for (const harness of [h, second]) {
        harness.provider.onSubmit = (request) =>
          new Promise((resolve) => release.push(() => resolve(snapshot(request))));
      }
      let settled = 0;
      const ticks = [h.research.tick(), second.research.tick(), h.research.tick()].map((tick) =>
        tick.then((handled) => {
          settled += 1;
          return handled;
        }),
      );
      // The two losing ticks finish while the winner is still waiting at the provider.
      await vi.waitFor(() => {
        expect(settled).toBe(2);
        expect(h.provider.calls.submit + second.provider.calls.submit).toBe(1);
      });
      expect(await h.prisma.researchRun.count({ where: { state: 'RUNNING' } })).toBe(1);
      expect(await h.prisma.researchRun.count({ where: { state: 'QUEUED' } })).toBe(1);

      release.forEach((fn) => fn());
      expect((await Promise.all(ticks)).filter(Boolean)).toHaveLength(1);
      expect(h.provider.calls.submit + second.provider.calls.submit).toBe(1);
    });

    it('saves the report before delivering it with claim-linked citations', async () => {
      await h.post(privateMessage('/research football next week')).expect(200);
      h.sender.beforeSend = async (html) => {
        if (!html.includes('Результат дослідження')) return;
        const [run] = await runs();
        expect(run).toMatchObject({ state: 'SUCCEEDED', outcome: 'FOUND' });
        expect(run?.reportText).toContain('Claim one.');
      };
      await h.research.tick();
      await drainDeliveries(h);

      const report = h.sender.sent.find((s) => s.html.includes('Результат дослідження'));
      expect(report?.html).toContain('Claim one. <a href="https://example.com/a">[1]</a>');
      expect(report?.html).toContain('СИМУЛЯЦІЯ');
      const [run] = await runs();
      expect(run).toMatchObject({
        submissionState: 'SUBMITTED',
        providerResponseId: 'resp_test_1',
        toolCallCount: 1,
      });
      expect(run?.usage).toMatchObject({ inputTokens: 1200, outputTokens: 300 });
      expect(run?.requestSnapshot).toMatchObject({
        config: { policyVersion: 'research-policy-2026-10-20.1', maxToolCalls: 3 },
        request: { maxOutputTokens: 2000, maxToolCalls: 3 },
        context: { timeZone: 'Europe/Kyiv', utcNow: '2026-10-18T12:00:00Z' },
      });
      expect(h.provider.calls).toMatchObject({ submit: 1, cancel: 0 });
    });

    it.each([
      ['not accepted', 'FAILED', 'OPENAI_HTTP_400'],
      ['unknown', 'UNCERTAIN', 'OPENAI_CONNECTION'],
    ])('records a %s submission without retrying it', async (_case, state, code) => {
      h.provider.onSubmit = () =>
        Promise.reject(state === 'FAILED' ? notAccepted() : unknownOutcome());
      await h.post(privateMessage('/research x')).expect(200);
      await h.research.tick();
      await h.research.tick();

      expect((await runs())[0]).toMatchObject({ state, failureCode: code });
      expect(h.provider.calls.submit).toBe(1);
      await drainDeliveries(h);
      expect(h.sender.sent.at(-1)?.html).toContain(code);
    });

    it('refuses to continue when the provider does not confirm the bounds', async () => {
      h.provider.onSubmit = (request) =>
        Promise.resolve({
          ...completed([]),
          status: 'queued',
          bounds: {
            maxOutputTokens: request.maxOutputTokens,
            maxToolCalls: null,
            toolChoice: 'auto',
            webSearchTool: true,
          },
        });
      await h.post(privateMessage('/research x')).expect(200);
      await h.research.tick();
      expect((await runs())[0]).toMatchObject({
        state: 'FAILED',
        failureCode: 'BOUNDS_NOT_CONFIRMED:max_tool_calls,tool_choice',
      });
      expect(h.provider.calls.cancel).toBe(1);
      expect(h.provider.calls.retrieve).toBe(0);
    });

    it('never delivers incomplete output as a report', async () => {
      h.provider.onRetrieve = () =>
        Promise.resolve(
          completed(
            [
              buildTextPart([
                'OUTCOME: FOUND\nPartial',
                { cite: { url: 'https://a.example/', title: 'A' } },
              ]),
            ],
            {
              status: 'incomplete',
              incompleteReason: 'max_output_tokens',
            },
          ),
        );
      await h.post(privateMessage('/research x')).expect(200);
      await h.research.tick();
      const [run] = await runs();
      expect(run).toMatchObject({
        state: 'FAILED',
        failureCode: 'INCOMPLETE:max_output_tokens',
        reportText: null,
      });
      expect(run?.usage).toMatchObject({ outputTokens: 300 });
      expect(await h.prisma.delivery.count({ where: { kind: 'REPORT' } })).toBe(0);
    });

    it('cancels at the run deadline instead of waiting indefinitely', async () => {
      h.provider.onRetrieve = (id) => {
        h.clock.advance(61_000);
        return Promise.resolve({ ...completed([]), id, status: 'in_progress' });
      };
      await h.post(privateMessage('/research x')).expect(200);
      await h.research.tick();
      expect((await runs())[0]).toMatchObject({
        state: 'FAILED',
        failureCode: 'DEADLINE_EXCEEDED',
      });
      expect(h.provider.calls.cancel).toBe(1);
      expect(h.provider.calls.retrieve).toBe(2); // 120 s fake deadline
    });
  });

  describe('delivery', () => {
    /** A completed report long enough for several Telegram messages. */
    function longReport() {
      h.provider.onRetrieve = () =>
        Promise.resolve(
          completed([
            buildTextPart([
              'OUTCOME: FOUND\n',
              ...Array.from({ length: 30 }, (_, i) => [
                `Пункт ${i} ${'довгий текст '.repeat(25)}`,
                { cite: { url: `https://s${i}.example/`, title: `S${i}` } },
                '\n\n',
              ]).flat(),
            ]),
          ]),
        );
    }

    async function researchAndAck() {
      await h.post(privateMessage('/research long')).expect(200);
      await h.research.tick();
      await h.delivery.tick(); // acknowledgment
      h.sender.sent.length = 0;
      h.sender.attempts.length = 0;
    }

    it('resumes after a known failure without resending confirmed parts or calling the provider', async () => {
      longReport();
      await researchAndAck();
      let calls = 0;
      h.sender.beforeSend = () => {
        calls += 1;
        return calls === 2 ? Promise.reject(telegramRateLimited()) : Promise.resolve();
      };
      await h.delivery.tick();
      let [, report] = await deliveries();
      expect(report).toMatchObject({
        kind: 'REPORT',
        state: 'RETRYABLE_FAILURE',
        lastErrorCode: 'TELEGRAM_429',
      });
      const total = report?.parts.length ?? 0;
      expect(total).toBeGreaterThan(2);

      await drainDeliveries(h);
      [, report] = await deliveries();
      expect(report?.state).toBe('SENT');
      expect(report?.parts.every((part) => part.state === 'SENT' && part.telegramMessageId)).toBe(
        true,
      );
      // Part 1 was sent once; part 2 was attempted twice; nothing else repeated.
      expect(h.sender.sent).toHaveLength(total);
      expect(new Set(h.sender.sent.map((s) => s.html)).size).toBe(total);
      expect(h.sender.attempts).toHaveLength(total + 1);
      expect(h.provider.calls).toMatchObject({ submit: 1, retrieve: 1 });
    });

    it('marks an ambiguous send UNKNOWN, never resends it automatically, and allows explicit /result', async () => {
      await researchAndAck();
      h.sender.failNext(telegramTimeout());
      await h.delivery.tick();
      const [, report] = await deliveries();
      expect(report).toMatchObject({ state: 'UNKNOWN', lastErrorCode: 'TELEGRAM_NETWORK' });
      expect(report?.parts[0]?.state).toBe('UNKNOWN');

      await drainDeliveries(h);
      expect(h.sender.sent).toHaveLength(0);

      const [run] = await runs();
      await h.post(privateMessage(`/result ${run?.id}`)).expect(200);
      await drainDeliveries(h);
      // TRB-080: the resend is preceded by a notice that the first send may have arrived.
      expect(h.sender.sent).toHaveLength(2);
      expect(h.sender.sent[0]?.html).toContain('могло вже надійти');
      expect(h.sender.sent[1]?.html).toBe(report?.parts[0]?.html);
      expect((await deliveries()).at(-1)).toMatchObject({ kind: 'RESEND', state: 'SENT' });
      expect(h.provider.calls).toMatchObject({ submit: 1, retrieve: 1 });
    });

    it('treats a worker crash while sending as UNKNOWN', async () => {
      await researchAndAck();
      const [, report] = await deliveries();
      await h.prisma
        .$executeRaw`UPDATE delivery SET state = 'SENDING', lease_until = now() - interval '1 minute' WHERE id = ${report?.id}::uuid`;
      await h.prisma
        .$executeRaw`UPDATE delivery_part SET state = 'SENDING' WHERE delivery_id = ${report?.id}::uuid`;
      await drainDeliveries(h);
      expect((await deliveries())[1]).toMatchObject({
        state: 'UNKNOWN',
        lastErrorCode: 'INTERRUPTED_WHILE_SENDING',
      });
      expect(h.sender.attempts).toHaveLength(0);
    });

    it('keeps the research result when delivery fails permanently', async () => {
      await researchAndAck();
      h.sender.failNext(telegramBlocked());
      await drainDeliveries(h);
      expect((await deliveries())[1]).toMatchObject({
        state: 'PERMANENT_FAILURE',
        lastErrorCode: 'TELEGRAM_403',
      });
      expect((await runs())[0]?.state).toBe('SUCCEEDED');
    });

    it('scopes /result to the requesting administrator and never starts research', async () => {
      await researchAndAck();
      await drainDeliveries(h);
      h.sender.sent.length = 0;
      const [run] = await runs();
      await h.post(privateMessage(`/result ${run?.id}`, OTHER_ADMIN_ID)).expect(200);
      await h.post(privateMessage('/result 11111111-2222-4333-8444-555555555555')).expect(200);
      await drainDeliveries(h);
      expect(h.sender.sent.map((s) => [s.chatId, s.html])).toEqual([
        [BigInt(OTHER_ADMIN_ID), 'Запуск не знайдено.'],
        [BigInt(ADMIN_ID), 'Запуск не знайдено.'],
      ]);
      expect(await h.prisma.delivery.count({ where: { kind: 'RESEND' } })).toBe(0);
      expect(h.provider.calls.submit).toBe(1);
    });
  });

  it('keeps tokens, secrets, connection strings and prompt text out of logs', async () => {
    const prompt = 'PROMPT-MARKER-7f3a confidential topic';
    let polls = 0;
    // A poll error whose message embeds secrets, then a deadline failure and an ambiguous send.
    h.provider.onRetrieve = (id) => {
      polls += 1;
      if (polls === 1) return Promise.reject(new Error(`leak ${BOT_TOKEN} ${prompt}`));
      h.clock.advance(200_000);
      return Promise.resolve({ ...completed([]), id, status: 'in_progress' });
    };
    h.sender.failNext(telegramTimeout());
    await h.post(privateMessage(`/research ${prompt}`)).expect(200);
    await h.post(privateMessage(`/research ${prompt}`), 'bad').expect(401);
    await h.research.tick();
    await drainDeliveries(h);

    const logs = h.logger.lines.join(String.fromCharCode(10));
    expect(logs).toContain('Telegram update processed');
    expect(logs).toContain('Research poll failed');
    expect(logs).toContain('DEADLINE_EXCEEDED');
    for (const forbidden of [
      'PROMPT-MARKER',
      'confidential',
      BOT_TOKEN,
      WEBHOOK_SECRET,
      'trb:trb@',
    ]) {
      expect(logs).not.toContain(forbidden);
    }
  });
});
