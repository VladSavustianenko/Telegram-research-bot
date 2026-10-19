/**
 * Provider-neutral research contract. The OpenAI adapter and the fake provider
 * both map to these types; the worker never sees SDK objects.
 */

export type ProviderKind = 'openai' | 'fake';

export type ProviderStatus =
  'queued' | 'in_progress' | 'completed' | 'incomplete' | 'failed' | 'cancelled';

export const NON_TERMINAL_STATUSES: ReadonlySet<ProviderStatus> = new Set([
  'queued',
  'in_progress',
]);

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

/** Fully built request. Persisted verbatim in the run snapshot before submission. */
export interface ResearchRequest {
  model: string;
  instructions: string;
  input: string;
  maxOutputTokens: number;
  maxToolCalls: number;
  reasoningEffort?: ReasoningEffort;
  /** Correlation only; contains no user content. */
  runId: string;
}

/** A url_citation annotation as returned by the provider, relative to its text part. */
export interface ProviderCitation {
  startIndex: number;
  endIndex: number;
  url: string;
  title: string;
}

export interface ProviderTextPart {
  text: string;
  citations: ProviderCitation[];
}

export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
}

/** Request bounds as echoed back by the provider; used to verify they were applied. */
export interface EchoedBounds {
  maxOutputTokens: number | null;
  maxToolCalls: number | null;
  toolChoice: string | null;
  webSearchTool: boolean;
}

/**
 * Diagnostic metadata of one built-in tool output item, as observed in one
 * snapshot. Values are reported as-is: unknown statuses or action types are
 * kept verbatim and missing ones are null (never assumed "completed"/"search").
 * No queries, URLs or page content are kept here.
 */
export interface ObservedToolItem {
  /** Provider item ID; null when the provider omitted it. */
  itemId: string | null;
  /** Position in the snapshot's output list (identifies items without an ID). */
  position: number;
  /** Output item type, e.g. "web_search_call". */
  type: string;
  status: string | null;
  actionType: string | null;
}

export interface ProviderSnapshot {
  id: string;
  status: ProviderStatus;
  model: string | null;
  textParts: ProviderTextPart[];
  /**
   * Number of web_search_call output items in this snapshot. An observation,
   * not a count of executed or billable searches.
   */
  webSearchCalls: number;
  /** Per-item diagnostics for the web_search_call items in this snapshot. */
  toolItems: ObservedToolItem[];
  sources: { url: string; title?: string }[];
  usage: ProviderUsage | null;
  incompleteReason: string | null;
  errorCode: string | null;
  bounds: EchoedBounds;
  /** True for the fake provider; results must be labelled as simulated. */
  simulated: boolean;
}

/**
 * `not_accepted`: the provider definitely did not start (and did not bill) the
 * request. `unknown`: it may have; never resubmit automatically.
 */
export type ProviderErrorCertainty = 'not_accepted' | 'unknown';

export class ProviderError extends Error {
  constructor(
    readonly code: string,
    readonly certainty: ProviderErrorCertainty,
    /** Provider resource definitely no longer exists (e.g. HTTP 404 on retrieve). */
    readonly gone = false,
  ) {
    super(`Research provider error: ${code}`);
    this.name = 'ProviderError';
  }
}

export interface ResearchProvider {
  readonly kind: ProviderKind;
  submit(request: ResearchRequest): Promise<ProviderSnapshot>;
  retrieve(responseId: string): Promise<ProviderSnapshot>;
  cancel(responseId: string): Promise<ProviderSnapshot>;
}

export const RESEARCH_PROVIDER = Symbol('RESEARCH_PROVIDER');

/** Problems when the provider did not confirm the requested bounds. Empty means confirmed. */
export function unconfirmedBounds(request: ResearchRequest, bounds: EchoedBounds): string[] {
  const problems: string[] = [];
  if (bounds.maxOutputTokens !== request.maxOutputTokens) problems.push('max_output_tokens');
  if (bounds.maxToolCalls !== request.maxToolCalls) problems.push('max_tool_calls');
  if (bounds.toolChoice !== 'required') problems.push('tool_choice');
  if (!bounds.webSearchTool) problems.push('web_search_tool');
  return problems;
}
