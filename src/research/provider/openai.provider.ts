import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai';
import type {
  Response,
  ResponseCreateParamsNonStreaming,
} from 'openai/resources/responses/responses';
import {
  ProviderError,
  type ProviderSnapshot,
  type ProviderStatus,
  type ResearchProvider,
  type ResearchRequest,
} from './provider.types';

/** The subset of the SDK the adapter uses; tests substitute a fake. */
export interface ResponsesApi {
  create(body: ResponseCreateParamsNonStreaming): Promise<Response>;
  retrieve(id: string, query: { include: string[] }): Promise<Response>;
  cancel(id: string): Promise<Response>;
}

const INCLUDE = ['web_search_call.action.sources'] as const;

/**
 * Request body for one research run, per the Responses API reference
 * (checked 2026-10-18 against openai@7.27.0):
 * - `web_search` tool with `tool_choice: "required"` forces a search;
 * - `max_output_tokens` bounds visible + reasoning tokens;
 * - `max_tool_calls` bounds built-in tool calls. It is documented for
 *   POST /v1/responses but missing from this SDK version's REST types, so it is
 *   added explicitly; the echoed value is verified after creation;
 * - `background: true` returns an ID immediately so it can be persisted and
 *   polled; `store: false` keeps provider retention to the polling window;
 * - no `previous_response_id` or conversation: every run is independent.
 */
export function buildCreateBody(request: ResearchRequest): ResponseCreateParamsNonStreaming {
  const body: ResponseCreateParamsNonStreaming & { max_tool_calls: number } = {
    model: request.model,
    instructions: request.instructions,
    input: request.input,
    tools: [{ type: 'web_search' }],
    tool_choice: 'required',
    max_output_tokens: request.maxOutputTokens,
    max_tool_calls: request.maxToolCalls,
    background: true,
    store: false,
    include: [...INCLUDE],
    metadata: { run_id: request.runId },
  };
  if (request.reasoningEffort) body.reasoning = { effort: request.reasoningEffort };
  return body;
}

export function openAiClientOptions(options: { apiKey: string; httpTimeoutMs: number }): {
  apiKey: string;
  maxRetries: number;
  timeout: number;
} {
  return {
    apiKey: options.apiKey,
    // Never let the SDK retry: a retried create could start a second billed request.
    maxRetries: 0,
    timeout: options.httpTimeoutMs,
  };
}

export class OpenAiResearchProvider implements ResearchProvider {
  readonly kind = 'openai' as const;

  constructor(private readonly api: ResponsesApi) {}

  static create(options: { apiKey: string; httpTimeoutMs: number }): OpenAiResearchProvider {
    const client = new OpenAI(openAiClientOptions(options));
    return new OpenAiResearchProvider({
      create: (body) => client.responses.create(body),
      retrieve: (id, query) =>
        client.responses.retrieve(id, query as Parameters<typeof client.responses.retrieve>[1]),
      cancel: (id) => client.responses.cancel(id),
    });
  }

  async submit(request: ResearchRequest): Promise<ProviderSnapshot> {
    return mapResponse(await this.call(() => this.api.create(buildCreateBody(request)), 'submit'));
  }

  async retrieve(responseId: string): Promise<ProviderSnapshot> {
    return mapResponse(
      await this.call(() => this.api.retrieve(responseId, { include: [...INCLUDE] }), 'poll'),
    );
  }

  async cancel(responseId: string): Promise<ProviderSnapshot> {
    return mapResponse(await this.call(() => this.api.cancel(responseId), 'poll'));
  }

  private async call(action: () => Promise<Response>, phase: 'submit' | 'poll'): Promise<Response> {
    try {
      return await action();
    } catch (error) {
      throw classifyError(error, phase);
    }
  }
}

/**
 * A 4xx response means the request was rejected before execution. 5xx,
 * timeouts and connection failures leave the outcome of a submission unknown.
 */
export function classifyError(error: unknown, phase: 'submit' | 'poll'): ProviderError {
  if (error instanceof APIUserAbortError || error instanceof APIConnectionError) {
    return new ProviderError(
      error instanceof APIUserAbortError ? 'OPENAI_ABORTED' : 'OPENAI_CONNECTION',
      'unknown',
    );
  }
  if (error instanceof APIError && typeof error.status === 'number') {
    const apiCode =
      typeof error.code === 'string' ? `_${error.code.replace(/[^a-z0-9_]/gi, '')}` : '';
    const code = `OPENAI_HTTP_${error.status}${apiCode}`.slice(0, 80);
    if (error.status >= 400 && error.status < 500) {
      return new ProviderError(code, 'not_accepted', phase === 'poll' && error.status === 404);
    }
    return new ProviderError(code, 'unknown');
  }
  return new ProviderError('OPENAI_UNEXPECTED', 'unknown');
}

const STATUSES: readonly ProviderStatus[] = [
  'queued',
  'in_progress',
  'completed',
  'incomplete',
  'failed',
  'cancelled',
];

export function mapResponse(response: Response): ProviderSnapshot {
  const status = STATUSES.includes(response.status as ProviderStatus)
    ? (response.status as ProviderStatus)
    : 'failed';
  const textParts: ProviderSnapshot['textParts'] = [];
  const sources: ProviderSnapshot['sources'] = [];
  let webSearchCalls = 0;

  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      for (const content of item.content) {
        if (content.type !== 'output_text') continue;
        textParts.push({
          text: content.text,
          citations: content.annotations.flatMap((annotation) =>
            annotation.type === 'url_citation'
              ? [
                  {
                    startIndex: annotation.start_index,
                    endIndex: annotation.end_index,
                    url: annotation.url,
                    title: annotation.title,
                  },
                ]
              : [],
          ),
        });
      }
    } else if (item.type === 'web_search_call') {
      webSearchCalls += 1;
      const action = item.action as { type?: string; sources?: { url?: string }[] } | undefined;
      for (const source of action?.sources ?? []) {
        if (typeof source.url === 'string') sources.push({ url: source.url });
      }
    }
  }

  const echoed = response as Response & { max_tool_calls?: number | null };
  const usage = response.usage;
  return {
    id: response.id,
    status,
    model: response.model ?? null,
    textParts,
    webSearchCalls,
    sources,
    usage: usage
      ? {
          inputTokens: usage.input_tokens ?? null,
          outputTokens: usage.output_tokens ?? null,
          reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? null,
          cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? null,
          totalTokens: usage.total_tokens ?? null,
        }
      : null,
    incompleteReason: response.incomplete_details?.reason ?? null,
    errorCode: response.error?.code ?? null,
    bounds: {
      maxOutputTokens: response.max_output_tokens ?? null,
      maxToolCalls: typeof echoed.max_tool_calls === 'number' ? echoed.max_tool_calls : null,
      toolChoice: typeof response.tool_choice === 'string' ? response.tool_choice : null,
      webSearchTool: (response.tools ?? []).some((tool) => tool.type.startsWith('web_search')),
    },
    simulated: false,
  };
}
