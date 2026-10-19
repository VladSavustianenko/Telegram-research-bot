import type { Clock } from '../../src/common/clock';
import { buildTextPart } from '../../src/research/provider/fake-fixtures';
import {
  ProviderError,
  type ProviderKind,
  type ProviderSnapshot,
  type ProviderTextPart,
  type ResearchProvider,
  type ResearchRequest,
} from '../../src/research/provider/provider.types';
import { TelegramSendError, type TelegramSender } from '../../src/telegram/telegram-sender';

export class FakeClock implements Clock {
  constructor(private current = new Date('2026-10-18T12:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function snapshot(
  request: Pick<ResearchRequest, 'maxOutputTokens' | 'maxToolCalls'> | null,
  overrides: Partial<ProviderSnapshot> = {},
): ProviderSnapshot {
  return {
    id: 'resp_test_1',
    status: 'queued',
    model: 'test-model',
    textParts: [],
    webSearchCalls: 0,
    sources: [],
    usage: null,
    incompleteReason: null,
    errorCode: null,
    bounds: {
      maxOutputTokens: request?.maxOutputTokens ?? null,
      maxToolCalls: request?.maxToolCalls ?? null,
      toolChoice: 'required',
      webSearchTool: true,
    },
    simulated: false,
    ...overrides,
  };
}

export function completed(parts: ProviderTextPart[], overrides: Partial<ProviderSnapshot> = {}) {
  return snapshot(null, {
    status: 'completed',
    textParts: parts,
    webSearchCalls: 1,
    usage: {
      inputTokens: 1200,
      outputTokens: 300,
      reasoningTokens: 100,
      cachedInputTokens: 0,
      totalTokens: 1500,
    },
    ...overrides,
  });
}

/** Research provider whose behaviour each test scripts; counts every call. */
export class ScriptedProvider implements ResearchProvider {
  readonly calls = { submit: 0, retrieve: 0, cancel: 0 };
  readonly requests: ResearchRequest[] = [];
  onSubmit: (request: ResearchRequest) => Promise<ProviderSnapshot> = (request) =>
    Promise.resolve(snapshot(request));
  onRetrieve: (id: string) => Promise<ProviderSnapshot> = () =>
    Promise.resolve(
      completed([
        buildTextPart([
          'OUTCOME: FOUND\nClaim one.',
          { cite: { url: 'https://example.com/a', title: 'Example A' } },
        ]),
      ]),
    );
  onCancel: (id: string) => Promise<ProviderSnapshot> = (id) =>
    Promise.resolve(snapshot(null, { id, status: 'cancelled' }));

  constructor(readonly kind: ProviderKind = 'fake') {}

  submit(request: ResearchRequest): Promise<ProviderSnapshot> {
    this.calls.submit += 1;
    this.requests.push(request);
    return this.onSubmit(request);
  }
  retrieve(id: string): Promise<ProviderSnapshot> {
    this.calls.retrieve += 1;
    return this.onRetrieve(id);
  }
  cancel(id: string): Promise<ProviderSnapshot> {
    this.calls.cancel += 1;
    return this.onCancel(id);
  }

  get totalResearchCalls(): number {
    return this.calls.submit;
  }
}

export const notAccepted = (code = 'OPENAI_HTTP_400') => new ProviderError(code, 'not_accepted');
export const unknownOutcome = (code = 'OPENAI_CONNECTION') => new ProviderError(code, 'unknown');

/** Records sent messages; `failNext` scripts failures for upcoming sends. */
export class RecordingSender implements TelegramSender {
  readonly sent: { chatId: bigint; html: string }[] = [];
  readonly attempts: { chatId: bigint; html: string }[] = [];
  private readonly failures: TelegramSendError[] = [];
  beforeSend: (html: string) => Promise<void> = () => Promise.resolve();
  private nextMessageId = 100;

  failNext(...errors: TelegramSendError[]): void {
    this.failures.push(...errors);
  }

  async sendHtml(chatId: bigint, html: string): Promise<{ messageId: number }> {
    this.attempts.push({ chatId, html });
    await this.beforeSend(html);
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push({ chatId, html });
    this.nextMessageId += 1;
    return { messageId: this.nextMessageId };
  }
}

export const telegramRateLimited = () =>
  new TelegramSendError('TELEGRAM_429', 'not_sent', false, 0);
export const telegramBlocked = () => new TelegramSendError('TELEGRAM_403', 'not_sent', true);
export const telegramTimeout = () => new TelegramSendError('TELEGRAM_NETWORK', 'unknown', false);
