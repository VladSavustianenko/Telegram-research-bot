import { createHash } from 'node:crypto';
import type { Env } from '../config/env.schema';
import type { ProviderUsage } from '../research/provider/provider.types';

/**
 * Reservation policy (TRB-050, docs/ACCOUNTING.md). All amounts are integer
 * micro-USD (BigInt); every division rounds up, so reservations and estimates
 * never round in the user's favour.
 *
 * reservation = input allowance x input rate (uncached)
 *             + OUTPUT_TOKEN_LIMIT x output rate (max_output_tokens includes reasoning)
 *             + web search call allowance x per-call rate
 *
 * The web search allowance must exceed TOOL_CALL_LIMIT: a TRB-020 live run was
 * metered with 4 web search requests although max_tool_calls was 3, so the
 * echoed limit is not treated as a cap on billable searches. The input
 * allowance is an assumption (no API input limit exists); it is not a bound.
 */
export const RESERVATION_POLICY_VERSION = 'reservation-policy-2026-10-19.1';

const MICROS_PER_MTOK_DIVISOR = 1_000_000n;

export interface PricingContent {
  model: string;
  returnedModels: string[];
  inputPerMTokMicros: string;
  cachedInputPerMTokMicros: string;
  outputPerMTokMicros: string;
  webSearchCallMicros: string;
}

export interface ReservationPolicy {
  policyVersion: string;
  pricingVersion: string;
  pricing: PricingContent;
  inputTokenAllowance: number;
  outputTokenLimit: number;
  toolCallLimit: number;
  webSearchCallAllowance: number;
  components: { inputMicros: string; outputMicros: string; webSearchMicros: string };
  reservedMicros: string;
}

export type PolicyProblem =
  | 'BUDGETS_NOT_CONFIGURED'
  | 'PRICING_NOT_CONFIGURED'
  | 'RESERVATION_NOT_CONFIGURED'
  | 'MODEL_NOT_PRICED'
  | 'SEARCH_ALLOWANCE_TOO_LOW'
  | 'RESERVATION_ABOVE_RUN_MAXIMUM';

/** Cost of `tokens` at `ratePerMTokMicros`, rounded up. */
export function tokenCostMicros(tokens: number | bigint, ratePerMTokMicros: bigint): bigint {
  const product = BigInt(tokens) * ratePerMTokMicros;
  return (product + MICROS_PER_MTOK_DIVISOR - 1n) / MICROS_PER_MTOK_DIVISOR;
}

export function pricingHash(content: PricingContent): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * The live reservation policy for the current configuration, or the first
 * reason it cannot be used. Live admission is refused for any problem.
 */
export function livePolicy(
  config: Env,
): { ok: true; policy: ReservationPolicy } | { ok: false; problem: PolicyProblem } {
  if (
    config.USER_MONTHLY_BUDGET_USD === undefined ||
    config.GLOBAL_MONTHLY_BUDGET_USD === undefined ||
    config.RUN_MAX_ESTIMATED_COST_USD === undefined
  ) {
    return { ok: false, problem: 'BUDGETS_NOT_CONFIGURED' };
  }
  const rates = [
    config.OPENAI_PRICE_INPUT_PER_MTOK_USD,
    config.OPENAI_PRICE_CACHED_INPUT_PER_MTOK_USD,
    config.OPENAI_PRICE_OUTPUT_PER_MTOK_USD,
    config.OPENAI_PRICE_WEB_SEARCH_CALL_USD,
  ];
  if (
    !config.PRICING_VERSION ||
    !config.PRICING_MODEL ||
    !config.PRICING_RETURNED_MODELS ||
    rates.some((rate) => rate === undefined)
  ) {
    return { ok: false, problem: 'PRICING_NOT_CONFIGURED' };
  }
  const outputTokenLimit = config.OUTPUT_TOKEN_LIMIT;
  const toolCallLimit = config.TOOL_CALL_LIMIT;
  if (
    config.RESERVATION_INPUT_TOKENS === undefined ||
    config.RESERVATION_WEB_SEARCH_CALLS === undefined ||
    outputTokenLimit === undefined ||
    toolCallLimit === undefined
  ) {
    return { ok: false, problem: 'RESERVATION_NOT_CONFIGURED' };
  }
  // Rates are known for one model only; anything else is unmapped.
  if (config.PRICING_MODEL !== config.OPENAI_MODEL)
    return { ok: false, problem: 'MODEL_NOT_PRICED' };
  if (config.RESERVATION_WEB_SEARCH_CALLS <= toolCallLimit) {
    return { ok: false, problem: 'SEARCH_ALLOWANCE_TOO_LOW' };
  }
  const [input, cached, output, search] = rates as [bigint, bigint, bigint, bigint];
  const inputMicros = tokenCostMicros(config.RESERVATION_INPUT_TOKENS, input);
  const outputMicros = tokenCostMicros(outputTokenLimit, output);
  const webSearchMicros = BigInt(config.RESERVATION_WEB_SEARCH_CALLS) * search;
  const reserved = inputMicros + outputMicros + webSearchMicros;
  if (reserved > config.RUN_MAX_ESTIMATED_COST_USD || reserved <= 0n) {
    return { ok: false, problem: 'RESERVATION_ABOVE_RUN_MAXIMUM' };
  }
  return {
    ok: true,
    policy: {
      policyVersion: RESERVATION_POLICY_VERSION,
      pricingVersion: config.PRICING_VERSION,
      pricing: {
        model: config.PRICING_MODEL,
        returnedModels: config.PRICING_RETURNED_MODELS,
        inputPerMTokMicros: input.toString(),
        cachedInputPerMTokMicros: cached.toString(),
        outputPerMTokMicros: output.toString(),
        webSearchCallMicros: search.toString(),
      },
      inputTokenAllowance: config.RESERVATION_INPUT_TOKENS,
      outputTokenLimit,
      toolCallLimit,
      webSearchCallAllowance: config.RESERVATION_WEB_SEARCH_CALLS,
      components: {
        inputMicros: inputMicros.toString(),
        outputMicros: outputMicros.toString(),
        webSearchMicros: webSearchMicros.toString(),
      },
      reservedMicros: reserved.toString(),
    },
  };
}

/** Whether a model identifier returned by the provider is covered by the pricing. */
export function modelPriced(pricing: PricingContent, returned: string | null): boolean {
  if (!returned) return false;
  if (returned === pricing.model) return true;
  return pricing.returnedModels.some((entry) =>
    entry.endsWith('*') ? returned.startsWith(entry.slice(0, -1)) : returned === entry,
  );
}

type Basis = Record<string, string | number | boolean | null>;

export type Estimate =
  | {
      /** Every component reported. */
      kind: 'estimate';
      /** Token cost from reported usage plus observed web search items x rate. */
      estimatedMicros: bigint;
      /** Search allowance not covered by observed items: kept because billing is unverified. */
      uncertainMicros: bigint;
      basis: Basis;
    }
  | {
      /**
       * Some token counts missing. Reported components are priced; each missing
       * one keeps its own reservation allowance (component policy).
       */
      kind: 'partial';
      /** Cost of the reported components plus observed searches. */
      knownMicros: bigint;
      /** Allowances of the unreported components plus the uncovered search allowance. */
      heldMicros: bigint;
      unknownComponents: ('input' | 'output')[];
      basis: Basis;
    }
  | {
      /** Nothing can be priced: no usage at all, or a model the pricing does not cover. */
      kind: 'unknown';
      reason: 'USAGE_MISSING' | 'MODEL_NOT_PRICED';
      basis: Basis;
    };

/**
 * Local estimate from provider usage, using the run's own policy snapshot
 * (never today's configuration). Components are priced independently:
 * - input: (input - cached) x input rate + cached x cached rate; unreported
 *   cached tokens are charged at the full input rate;
 * - output: output tokens x output rate (includes reasoning);
 * - searches: observed web_search_call items x rate are known; the allowance
 *   they do not cover is held, because billable searches are not verified.
 * A missing input or output count is unknown, never zero: that component keeps
 * its own allowance from the reservation (so an overrun of a known component
 * never consumes the allowance of an unknown one). No usage at all, or an
 * unmapped returned model, prices nothing.
 */
export function estimateRun(
  policy: ReservationPolicy,
  evidence: {
    usage: ProviderUsage | null;
    returnedModel: string | null;
    observedSearchItems: number;
  },
): Estimate {
  const basis: Basis = {
    returnedModel: evidence.returnedModel,
    inputTokens: evidence.usage?.inputTokens ?? null,
    cachedInputTokens: evidence.usage?.cachedInputTokens ?? null,
    outputTokens: evidence.usage?.outputTokens ?? null,
    reasoningTokens: evidence.usage?.reasoningTokens ?? null,
    observedSearchItems: evidence.observedSearchItems,
    webSearchCallAllowance: policy.webSearchCallAllowance,
    pricingVersion: policy.pricingVersion,
    policyVersion: policy.policyVersion,
  };
  if (!evidence.usage) return { kind: 'unknown', reason: 'USAGE_MISSING', basis };
  if (!modelPriced(policy.pricing, evidence.returnedModel)) {
    return { kind: 'unknown', reason: 'MODEL_NOT_PRICED', basis };
  }
  const rates = policy.pricing;
  const { inputTokens, outputTokens } = evidence.usage;

  const inputMicros =
    inputTokens === null
      ? null
      : (() => {
          const cached = Math.min(Math.max(evidence.usage.cachedInputTokens ?? 0, 0), inputTokens);
          return (
            tokenCostMicros(inputTokens - cached, BigInt(rates.inputPerMTokMicros)) +
            tokenCostMicros(cached, BigInt(rates.cachedInputPerMTokMicros))
          );
        })();
  const outputMicros =
    outputTokens === null ? null : tokenCostMicros(outputTokens, BigInt(rates.outputPerMTokMicros));

  const searchRate = BigInt(rates.webSearchCallMicros);
  const observed = BigInt(Math.max(0, evidence.observedSearchItems));
  const allowance = BigInt(policy.webSearchCallAllowance);
  const searchKnown = observed * searchRate;
  const searchHeld = (allowance > observed ? allowance - observed : 0n) * searchRate;

  if (inputMicros !== null && outputMicros !== null) {
    const tokens = inputMicros + outputMicros;
    return {
      kind: 'estimate',
      estimatedMicros: tokens + searchKnown,
      uncertainMicros: searchHeld,
      basis: {
        ...basis,
        tokenMicros: tokens.toString(),
        searchRateMicros: rates.webSearchCallMicros,
      },
    };
  }
  const unknownComponents: ('input' | 'output')[] = [];
  if (inputMicros === null) unknownComponents.push('input');
  if (outputMicros === null) unknownComponents.push('output');
  const known = (inputMicros ?? 0n) + (outputMicros ?? 0n) + searchKnown;
  const held =
    (inputMicros === null ? BigInt(policy.components.inputMicros) : 0n) +
    (outputMicros === null ? BigInt(policy.components.outputMicros) : 0n) +
    searchHeld;
  return {
    kind: 'partial',
    knownMicros: known,
    heldMicros: held,
    unknownComponents,
    basis: {
      ...basis,
      inputMicros: inputMicros === null ? null : inputMicros.toString(),
      outputMicros: outputMicros === null ? null : outputMicros.toString(),
      searchKnownMicros: searchKnown.toString(),
      searchHeldMicros: searchHeld.toString(),
      unknownComponents: unknownComponents.join(','),
    },
  };
}

/** UTC accounting periods of an instant. */
export function periodsOf(instant: Date): { day: string; month: string } {
  const iso = instant.toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

/** "12.345678" style USD for display; never rounded down silently (6 decimals). */
export function formatUsd(micros: bigint): string {
  const negative = micros < 0n;
  const value = negative ? -micros : micros;
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n)
    .toString()
    .padStart(6, '0')
    .replace(/0{1,4}$/, '');
  return `${negative ? '-' : ''}$${whole}.${fraction.padEnd(2, '0')}`;
}
