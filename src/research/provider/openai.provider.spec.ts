import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import type { Response } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';
import { buildResearchContext, buildResearchRequest, snapshotRunConfig } from '../request-builder';
import { parseEnv } from '../../config/env.schema';
import {
  buildCreateBody,
  classifyError,
  retryAfterMs,
  mapResponse,
  openAiClientOptions,
  OpenAiResearchProvider,
  type ResponsesApi,
} from './openai.provider';
import { unconfirmedBounds } from './provider.types';

const liveEnv = parseEnv({
  DATABASE_URL: 'postgresql://u:p@localhost:5434/db',
  RESEARCH_MODE: 'live',
  OPENAI_API_KEY: 'sk-test-not-a-real-key',
  OPENAI_MODEL: 'operator-selected-model',
  OUTPUT_TOKEN_LIMIT: '4000',
  TOOL_CALL_LIMIT: '4',
  RUN_DEADLINE_SECONDS: '300',
});
const config = snapshotRunConfig(liveEnv);
if (!config) throw new Error('expected live config');
const now = new Date('2026-10-18T12:00:00Z');
const request = buildResearchRequest(
  'run-1',
  'Football fixtures next week',
  config,
  buildResearchContext(now, now, 'Europe/Kyiv'),
);

/** Minimal Responses API object as documented (web_search_call + message with url_citation). */
function response(overrides: Partial<Record<string, unknown>> = {}): Response {
  return {
    id: 'resp_123',
    object: 'response',
    status: 'completed',
    model: 'operator-selected-model-2026-01-01',
    max_output_tokens: 4000,
    max_tool_calls: 4,
    tool_choice: 'required',
    tools: [{ type: 'web_search' }],
    incomplete_details: null,
    error: null,
    output: [
      {
        type: 'web_search_call',
        id: 'ws_1',
        status: 'completed',
        action: {
          type: 'search',
          query: 'q',
          sources: [{ type: 'url', url: 'https://a.example/' }],
        },
      },
      {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'OUTCOME: FOUND\nClaim.',
            annotations: [
              {
                type: 'url_citation',
                start_index: 15,
                end_index: 21,
                url: 'https://a.example/',
                title: 'A',
              },
              { type: 'file_citation', index: 0, file_id: 'f', filename: 'x' },
            ],
          },
        ],
      },
    ],
    usage: {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens: 200,
      output_tokens_details: { reasoning_tokens: 50 },
      total_tokens: 1200,
    },
    ...overrides,
  } as unknown as Response;
}

describe('buildCreateBody', () => {
  it('requires web search and passes finite bounds, background polling and no shared state', () => {
    const body = buildCreateBody(request) as unknown as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'operator-selected-model',
      tools: [{ type: 'web_search' }],
      tool_choice: 'required',
      max_output_tokens: 4000,
      max_tool_calls: 4,
      background: true,
      store: false,
      include: ['web_search_call.action.sources'],
      metadata: { run_id: 'run-1' },
    });
    expect(body).not.toHaveProperty('previous_response_id');
    expect(body).not.toHaveProperty('conversation');
    expect(body).not.toHaveProperty('text'); // no Structured Outputs format
    expect(body).not.toHaveProperty('reasoning');
    expect(String(body['instructions'])).toContain('untrusted evidence');
    expect(String(body['input'])).toContain('<<<TASK\nFootball fixtures next week\nTASK>>>');
  });

  it('sends reasoning effort only when configured', () => {
    const body = buildCreateBody({ ...request, reasoningEffort: 'low' });
    expect(body.reasoning).toEqual({ effort: 'low' });
  });
});

describe('OpenAI client', () => {
  it('disables SDK retries so a create is never sent twice', () => {
    expect(openAiClientOptions({ apiKey: 'k', httpTimeoutMs: 30_000 })).toEqual({
      apiKey: 'k',
      maxRetries: 0,
      timeout: 30_000,
    });
  });

  it('submits exactly the built body once and maps the response', async () => {
    const bodies: unknown[] = [];
    const api: ResponsesApi = {
      create: (body) => {
        bodies.push(body);
        return Promise.resolve(response({ status: 'queued', output: [], usage: null }));
      },
      retrieve: () => Promise.resolve(response()),
      cancel: () => Promise.resolve(response({ status: 'cancelled' })),
    };
    const provider = new OpenAiResearchProvider(api);
    const submitted = await provider.submit(request);
    expect(bodies).toEqual([buildCreateBody(request)]);
    expect(submitted).toMatchObject({ id: 'resp_123', status: 'queued', simulated: false });
    expect(unconfirmedBounds(request, submitted.bounds)).toEqual([]);
  });
});

describe('mapResponse', () => {
  it('extracts text, url citations, consulted sources, usage and echoed bounds', () => {
    const mapped = mapResponse(response());
    expect(mapped.textParts).toEqual([
      {
        text: 'OUTCOME: FOUND\nClaim.',
        citations: [{ startIndex: 15, endIndex: 21, url: 'https://a.example/', title: 'A' }],
      },
    ]);
    expect(mapped.webSearchCalls).toBe(1);
    expect(mapped.sources).toEqual([{ url: 'https://a.example/' }]);
    expect(mapped.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 50,
      cachedInputTokens: 10,
      totalTokens: 1200,
    });
    expect(mapped.bounds).toEqual({
      maxOutputTokens: 4000,
      maxToolCalls: 4,
      toolChoice: 'required',
      webSearchTool: true,
    });
  });

  it('reports unconfirmed bounds when the API does not echo them', () => {
    const mapped = mapResponse(
      response({ max_tool_calls: undefined, tool_choice: 'auto', tools: [] }),
    );
    expect(unconfirmedBounds(request, mapped.bounds)).toEqual([
      'max_tool_calls',
      'tool_choice',
      'web_search_tool',
    ]);
  });

  it('keeps incomplete details and maps unknown statuses to failed', () => {
    expect(
      mapResponse(
        response({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }),
      ),
    ).toMatchObject({ status: 'incomplete', incompleteReason: 'max_output_tokens' });
    expect(mapResponse(response({ status: 'something_new' })).status).toBe('failed');
  });
});

describe('classifyError', () => {
  const apiError = (status: number, code?: string) =>
    APIError.generate(
      status,
      { error: { code, message: 'secret-ish detail' } },
      undefined,
      new Headers(),
    );

  it.each([400, 401, 403, 404, 422, 429])('treats HTTP %i on submit as not accepted', (status) => {
    expect(classifyError(apiError(status), 'submit')).toMatchObject({ certainty: 'not_accepted' });
  });

  it('treats 5xx, timeouts, connection errors and aborts on submit as unknown', () => {
    for (const error of [
      apiError(500),
      apiError(503),
      new APIConnectionTimeoutError(),
      new APIConnectionError({ message: 'reset' }),
      new APIUserAbortError(),
      new Error('boom'),
    ]) {
      expect(classifyError(error, 'submit').certainty).toBe('unknown');
    }
  });

  it('marks only a rate-limited submission as retryable, with its Retry-After (TRB-060)', () => {
    const limited = (code: string | undefined, headers: Record<string, string>) =>
      classifyError(
        APIError.generate(429, { error: { code } }, undefined, new Headers(headers)),
        'submit',
      );
    expect(limited('rate_limit_exceeded', { 'retry-after': '7' }).retryAfterMs).toBe(7_000);
    expect(limited(undefined, { 'retry-after-ms': '1500' }).retryAfterMs).toBe(1_500);
    expect(limited('rate_limit_exceeded', {}).retryAfterMs).toBeNull();
    // Exhausted quota is not a transient refusal.
    expect(limited('insufficient_quota', { 'retry-after': '7' }).retryAfterMs).toBeUndefined();
    // Other refusals, and a 429 while polling, are never retried as submissions.
    expect(classifyError(apiError(400), 'submit').retryAfterMs).toBeUndefined();
    expect(classifyError(apiError(429), 'poll').retryAfterMs).toBeUndefined();
    // Ambiguous outcomes are never retryable.
    expect(classifyError(apiError(503), 'submit').retryAfterMs).toBeUndefined();
  });

  it('parses Retry-After as seconds or an HTTP date and ignores garbage', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    expect(retryAfterMs(new Headers({ 'retry-after': 'Tue, 20 Oct 2026 12:00:30 GMT' }), now)).toBe(
      30_000,
    );
    expect(retryAfterMs(new Headers({ 'retry-after': 'soon' }), now)).toBeNull();
    expect(retryAfterMs(undefined, now)).toBeNull();
  });

  it('marks a 404 while polling as gone and keeps messages out of the code', () => {
    const error = classifyError(apiError(404, 'not_found'), 'poll');
    expect(error.gone).toBe(true);
    expect(error.code).toBe('OPENAI_HTTP_404_not_found');
    expect(error.message).not.toContain('secret-ish');
  });
});

describe('mapResponse tool item diagnostics', () => {
  it('keeps ID, status and action type of every web_search_call, verbatim', () => {
    const mapped = mapResponse(
      response({
        output: [
          {
            type: 'web_search_call',
            id: 'ws_1',
            status: 'completed',
            action: { type: 'search', query: 'secret query', sources: [] },
          },
          {
            type: 'web_search_call',
            id: 'ws_2',
            status: 'completed',
            action: { type: 'open_page', url: 'https://a.example/' },
          },
          {
            type: 'web_search_call',
            id: 'ws_3',
            status: 'failed',
            action: { type: 'find_in_page', pattern: 'x', url: 'https://a.example/' },
          },
          { type: 'web_search_call', id: 'ws_4', status: 'incomplete' },
          {
            type: 'web_search_call',
            status: 'brand_new_status',
            action: { type: 'brand_new_action' },
          },
          { type: 'web_search_call', id: 'ws_6' },
          { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [] },
        ],
      }),
    );
    expect(mapped.webSearchCalls).toBe(6);
    expect(mapped.toolItems).toEqual([
      {
        itemId: 'ws_1',
        position: 0,
        type: 'web_search_call',
        status: 'completed',
        actionType: 'search',
      },
      {
        itemId: 'ws_2',
        position: 1,
        type: 'web_search_call',
        status: 'completed',
        actionType: 'open_page',
      },
      {
        itemId: 'ws_3',
        position: 2,
        type: 'web_search_call',
        status: 'failed',
        actionType: 'find_in_page',
      },
      {
        itemId: 'ws_4',
        position: 3,
        type: 'web_search_call',
        status: 'incomplete',
        actionType: null,
      },
      {
        itemId: null,
        position: 4,
        type: 'web_search_call',
        status: 'brand_new_status',
        actionType: 'brand_new_action',
      },
      { itemId: 'ws_6', position: 5, type: 'web_search_call', status: null, actionType: null },
    ]);
    // Diagnostics never carry queries, URLs or patterns.
    expect(JSON.stringify(mapped.toolItems)).not.toMatch(/secret query|https:|pattern/);
  });
});
