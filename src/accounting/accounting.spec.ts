import { describe, expect, it } from 'vitest';
import { parseEnv } from '../config/env.schema';
import {
  estimateRun,
  formatUsd,
  livePolicy,
  modelPriced,
  periodsOf,
  tokenCostMicros,
  type ReservationPolicy,
} from './pricing';

/** Synthetic prices (not OpenAI's): input $2, cached $0.5, output $8 per MTok, $0.01 per search. */
const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5434/db',
  RESEARCH_MODE: 'live',
  OPENAI_API_KEY: 'sk-test',
  OPENAI_MODEL: 'm',
  OUTPUT_TOKEN_LIMIT: '3000',
  TOOL_CALL_LIMIT: '3',
  RUN_DEADLINE_SECONDS: '300',
  USER_MONTHLY_BUDGET_USD: '10',
  GLOBAL_MONTHLY_BUDGET_USD: '50',
  RUN_MAX_ESTIMATED_COST_USD: '1',
  PRICING_VERSION: 'v1',
  PRICING_MODEL: 'm',
  PRICING_RETURNED_MODELS: 'm-2026-*, m-exact',
  OPENAI_PRICE_INPUT_PER_MTOK_USD: '2',
  OPENAI_PRICE_CACHED_INPUT_PER_MTOK_USD: '0.5',
  OPENAI_PRICE_OUTPUT_PER_MTOK_USD: '8',
  OPENAI_PRICE_WEB_SEARCH_CALL_USD: '0.01',
  RESERVATION_INPUT_TOKENS: '100000',
  RESERVATION_WEB_SEARCH_CALLS: '6',
};
const policyOf = (overrides: Record<string, string> = {}): ReservationPolicy => {
  const result = livePolicy(parseEnv({ ...base, ...overrides }));
  if (!result.ok) throw new Error(result.problem);
  return result.policy;
};

describe('reservation policy', () => {
  it('reserves input allowance, output limit and search allowance in exact micro-USD', () => {
    const policy = policyOf();
    expect(policy.components).toEqual({
      inputMicros: '200000',
      outputMicros: '24000',
      webSearchMicros: '60000',
    });
    expect(policy.reservedMicros).toBe('284000');
    expect(policy.pricing).toMatchObject({
      inputPerMTokMicros: '2000000',
      webSearchCallMicros: '10000',
    });
  });

  it('rounds every cost up, never in the user’s favour', () => {
    expect(tokenCostMicros(1, 2_000_000n)).toBe(2n);
    expect(tokenCostMicros(1, 1n)).toBe(1n);
    expect(tokenCostMicros(0, 9n)).toBe(0n);
    expect(tokenCostMicros(999_999, 1n)).toBe(1n);
    expect(tokenCostMicros(1_000_001, 1n)).toBe(2n);
  });

  it.each([
    [{ USER_MONTHLY_BUDGET_USD: '' }, 'BUDGETS_NOT_CONFIGURED'],
    [{ GLOBAL_MONTHLY_BUDGET_USD: '' }, 'BUDGETS_NOT_CONFIGURED'],
    [{ RUN_MAX_ESTIMATED_COST_USD: '' }, 'BUDGETS_NOT_CONFIGURED'],
    [{ PRICING_VERSION: '' }, 'PRICING_NOT_CONFIGURED'],
    [{ OPENAI_PRICE_WEB_SEARCH_CALL_USD: '' }, 'PRICING_NOT_CONFIGURED'],
    [{ PRICING_RETURNED_MODELS: '' }, 'PRICING_NOT_CONFIGURED'],
    [{ RESERVATION_INPUT_TOKENS: '' }, 'RESERVATION_NOT_CONFIGURED'],
    [{ PRICING_MODEL: 'other' }, 'MODEL_NOT_PRICED'],
    // The echoed max_tool_calls is not a proven cap: the allowance must exceed it.
    [{ RESERVATION_WEB_SEARCH_CALLS: '3' }, 'SEARCH_ALLOWANCE_TOO_LOW'],
    [{ RUN_MAX_ESTIMATED_COST_USD: '0.283999' }, 'RESERVATION_ABOVE_RUN_MAXIMUM'],
  ])('refuses live admission configuration %j', (overrides, problem) => {
    expect(livePolicy(parseEnv({ ...base, ...overrides }))).toEqual({ ok: false, problem });
  });

  it('maps returned model identifiers explicitly', () => {
    const { pricing } = policyOf();
    expect(modelPriced(pricing, 'm')).toBe(true);
    expect(modelPriced(pricing, 'm-2026-04-23')).toBe(true);
    expect(modelPriced(pricing, 'm-exact')).toBe(true);
    expect(modelPriced(pricing, 'm-exact-2')).toBe(false);
    expect(modelPriced(pricing, 'm-2025-01-01')).toBe(false);
    expect(modelPriced(pricing, null)).toBe(false);
  });
});

describe('usage estimates', () => {
  const policy = policyOf();
  const usage = {
    inputTokens: 23_806,
    outputTokens: 1_245,
    reasoningTokens: 519,
    cachedInputTokens: 0,
    totalTokens: 25_051,
  };

  it('estimates tokens and observed searches and keeps the unverified search allowance', () => {
    const estimate = estimateRun(policy, {
      usage,
      returnedModel: 'm-2026-04-23',
      observedSearchItems: 4,
    });
    // 23 806 x 2 = 47 612; 1 245 x 8 = 9 960; 4 x 10 000 searches.
    expect(estimate).toMatchObject({
      kind: 'estimate',
      estimatedMicros: 97_572n,
      uncertainMicros: 20_000n,
    });
  });

  it('prices cached input separately and treats unreported cache as uncached', () => {
    const cached = estimateRun(policy, {
      usage: { ...usage, cachedInputTokens: 10_000 },
      returnedModel: 'm',
      observedSearchItems: 0,
    });
    // 13 806 x 2 + 10 000 x 0.5 + 9 960 = 42 572
    expect(cached).toMatchObject({ estimatedMicros: 42_572n, uncertainMicros: 60_000n });
    const unreported = estimateRun(policy, {
      usage: { ...usage, cachedInputTokens: null },
      returnedModel: 'm',
      observedSearchItems: 0,
    });
    expect(unreported).toMatchObject({ estimatedMicros: 57_572n });
  });

  it('records observed searches beyond the allowance in full (overrun)', () => {
    expect(
      estimateRun(policy, { usage, returnedModel: 'm', observedSearchItems: 9 }),
    ).toMatchObject({ estimatedMicros: 57_572n + 90_000n, uncertainMicros: 0n });
  });

  it('never treats missing or partial usage or an unmapped model as zero', () => {
    expect(
      estimateRun(policy, { usage: null, returnedModel: 'm', observedSearchItems: 1 }),
    ).toMatchObject({
      kind: 'unknown',
      reason: 'USAGE_MISSING',
    });
    expect(
      estimateRun(policy, {
        usage: { ...usage, outputTokens: null },
        returnedModel: 'm',
        observedSearchItems: 1,
      }),
    ).toMatchObject({ kind: 'partial', unknownComponents: ['output'] });
    expect(
      estimateRun(policy, { usage, returnedModel: 'other', observedSearchItems: 1 }),
    ).toMatchObject({
      kind: 'unknown',
      reason: 'MODEL_NOT_PRICED',
    });
  });
});

describe('partial usage (component policy)', () => {
  const policy = policyOf(); // allowances: input $0.20, output $0.024, searches 6 x $0.01
  const partial = (usage: Partial<Record<string, number | null>>, observedSearchItems = 0) =>
    estimateRun(policy, {
      usage: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cachedInputTokens: null,
        totalTokens: null,
        ...usage,
      },
      returnedModel: 'm',
      observedSearchItems,
    });

  it('keeps a known input cost above the reservation and holds the output allowance', () => {
    // 1 000 000 x $2 = $2.00 known; output unknown: its $0.024 allowance stays held,
    // and the search allowance (0 observed) stays held: $0.06.
    expect(partial({ inputTokens: 1_000_000, cachedInputTokens: 0 })).toMatchObject({
      kind: 'partial',
      knownMicros: 2_000_000n,
      heldMicros: 24_000n + 60_000n,
      unknownComponents: ['output'],
    });
  });

  it('keeps a known output cost above the reservation and holds the input allowance', () => {
    // 50 000 x $8 = $0.40 known; input unknown: its $0.20 allowance stays held.
    expect(partial({ outputTokens: 50_000 })).toMatchObject({
      kind: 'partial',
      knownMicros: 400_000n,
      heldMicros: 200_000n + 60_000n,
      unknownComponents: ['input'],
    });
  });

  it('includes observed searches as known and keeps the uncovered search allowance', () => {
    expect(partial({ inputTokens: 1_200 }, 2)).toMatchObject({
      // 1 200 x $2 (cache unreported: full rate) + 2 observed searches
      knownMicros: 2_400n + 20_000n,
      // output allowance + 4 uncovered searches
      heldMicros: 24_000n + 40_000n,
    });
  });

  it('holds every allowance when no token count is reported', () => {
    expect(partial({}, 0)).toMatchObject({
      kind: 'partial',
      knownMicros: 0n,
      heldMicros: 284_000n,
      unknownComponents: ['input', 'output'],
    });
  });

  it('does not price an unmapped model even when usage is partial', () => {
    expect(
      estimateRun(policy, {
        usage: {
          inputTokens: 1_000_000,
          outputTokens: null,
          reasoningTokens: null,
          cachedInputTokens: 0,
          totalTokens: null,
        },
        returnedModel: 'other',
        observedSearchItems: 0,
      }),
    ).toMatchObject({ kind: 'unknown', reason: 'MODEL_NOT_PRICED' });
  });
});

describe('periods and formatting', () => {
  it('uses UTC days and months regardless of any local zone', () => {
    expect(periodsOf(new Date('2026-10-31T23:59:59.999Z'))).toEqual({
      day: '2026-10-31',
      month: '2026-10',
    });
    expect(periodsOf(new Date('2026-11-01T00:00:00.000Z'))).toEqual({
      day: '2026-11-01',
      month: '2026-11',
    });
    // 01:30 in Kyiv on 1 November is still 31 October in UTC.
    expect(periodsOf(new Date('2026-10-31T23:30:00Z')).month).toBe('2026-10');
  });

  it('formats micro-USD exactly', () => {
    expect(formatUsd(284_000n)).toBe('$0.284');
    expect(formatUsd(1_500_000n)).toBe('$1.50');
    expect(formatUsd(1_234_567n)).toBe('$1.234567');
    expect(formatUsd(0n)).toBe('$0.00');
    expect(formatUsd(-10n)).toBe('-$0.00001');
  });
});
