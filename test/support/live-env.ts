/**
 * Live-mode configuration for tests: a scripted provider stands in for OpenAI
 * (no network). Prices are synthetic, chosen for easy arithmetic, and are not
 * OpenAI prices. Reservation with these values:
 *   100 000 input tokens x $2/MTok      = $0.200000
 *   3 000 output tokens x $8/MTok       = $0.024000
 *   6 web search calls x $0.01          = $0.060000
 *                                         $0.284000 (284 000 micro-USD)
 */
export const LIVE_TEST_ENV = {
  RESEARCH_MODE: 'live',
  OPENAI_API_KEY: 'sk-test-not-a-real-key',
  OPENAI_MODEL: 'operator-selected-model',
  OUTPUT_TOKEN_LIMIT: '3000',
  TOOL_CALL_LIMIT: '3',
  RUN_DEADLINE_SECONDS: '300',
  USER_MONTHLY_BUDGET_USD: '10',
  GLOBAL_MONTHLY_BUDGET_USD: '50',
  RUN_MAX_ESTIMATED_COST_USD: '1',
  PRICING_VERSION: 'synthetic-test-1',
  PRICING_MODEL: 'operator-selected-model',
  PRICING_RETURNED_MODELS: 'operator-selected-model-*,test-model',
  OPENAI_PRICE_INPUT_PER_MTOK_USD: '2',
  OPENAI_PRICE_CACHED_INPUT_PER_MTOK_USD: '0.5',
  OPENAI_PRICE_OUTPUT_PER_MTOK_USD: '8',
  OPENAI_PRICE_WEB_SEARCH_CALL_USD: '0.01',
  RESERVATION_INPUT_TOKENS: '100000',
  RESERVATION_WEB_SEARCH_CALLS: '6',
} as const;

/** Reservation of one run under LIVE_TEST_ENV, in micro-USD. */
export const TEST_RESERVATION_MICROS = 284_000n;
