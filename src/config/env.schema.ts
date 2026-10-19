import { z } from 'zod';

/**
 * Environment contract (docs/ARCHITECTURE.md §8).
 *
 * Only DATABASE_URL is always required. Telegram and research features are
 * off unless TELEGRAM_MODE / RESEARCH_MODE enable them; enabling a feature
 * makes its variables required (cross-field checks below). Live (paid)
 * research is never the default. Validation messages name variables only and
 * never echo values.
 */

/**
 * OpenAI background responses created with store=false are retained for about
 * ten minutes for polling (docs/VALIDATION.md, TRB-020). The run deadline must
 * stay inside that window so a recovering worker can still resume polling.
 */
export const MAX_RUN_DEADLINE_SECONDS = 540;

/** Minimum value the Responses API accepts for max_output_tokens. */
export const MIN_OUTPUT_TOKEN_LIMIT = 16;

const MICRO_USD_PER_USD = 1_000_000n;

/** Treats empty strings (common in .env templates) as "not set". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const positiveInt = z
  .string()
  .regex(/^[1-9]\d*$/, 'must be a positive integer')
  .transform(Number)
  .refine(Number.isSafeInteger, 'is too large');

const positiveIntWithDefault = (fallback: number) =>
  z
    .preprocess((value) => (value === '' ? undefined : value), positiveInt.optional())
    .default(fallback);

/** Decimal USD amount with at most 6 fraction digits, converted to integer micro-USD. */
const usdAmount = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'must be a non-negative USD amount with at most 6 decimal places')
  .transform((value) => {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole) * MICRO_USD_PER_USD + BigInt(fraction.padEnd(6, '0'));
  });

/** Comma-separated Telegram user IDs; kept as strings (bigint-compatible, SPEC §2). */
const telegramIdList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  )
  .refine(
    (ids) => ids.every((id) => /^[1-9]\d{0,18}$/.test(id)),
    'must be a comma-separated list of numeric Telegram user IDs',
  );

const postgresUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  } catch {
    return false;
  }
}, 'must be a postgres:// or postgresql:// connection URL');

const secret = z.string().min(1);

const ianaTimeZone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone.includes('/') || zone === 'UTC';
  } catch {
    return false;
  }
}, 'must be an IANA time zone such as Europe/Kyiv');

/** Treats empty strings as unset so that the schema's own default applies. */
const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z
      .preprocess((value) => (value === '' ? undefined : value), positiveInt.optional())
      .default(3000)
      .refine((port) => port <= 65_535, 'must be a valid TCP port'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'log', 'debug', 'verbose']).default('log'),
    DATABASE_URL: postgresUrl,
    // Bounds for every database operation (connection, pool acquisition, statements, shutdown drain).
    DATABASE_CONNECT_TIMEOUT_MS: positiveIntWithDefault(5_000),
    DATABASE_STATEMENT_TIMEOUT_MS: positiveIntWithDefault(30_000),
    DATABASE_SHUTDOWN_TIMEOUT_MS: positiveIntWithDefault(5_000),

    // Telegram. disabled: no ingress and no outbound messages. webhook: production.
    // polling: development only. Never run webhook and polling for the same token.
    TELEGRAM_MODE: z.preprocess(
      emptyAsUnset,
      z.enum(['disabled', 'webhook', 'polling']).default('disabled'),
    ),
    TELEGRAM_BOT_TOKEN: optional(secret),
    TELEGRAM_WEBHOOK_SECRET: optional(
      z
        .string()
        .regex(
          /^[A-Za-z0-9_-]{1,256}$/,
          'must be 1-256 characters of A-Z, a-z, 0-9, "_" or "-" (Telegram secret_token rules)',
        ),
    ),
    PUBLIC_BASE_URL: optional(z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' })),
    ADMIN_TELEGRAM_IDS: optional(telegramIdList),
    // Optional bot username (without "@") for t.me invitation links; without it the
    // invitation shows a "/start <token>" command instead.
    TELEGRAM_BOT_USERNAME: optional(
      z.string().regex(/^[A-Za-z0-9_]{5,32}$/, 'must be a Telegram bot username without "@"'),
    ),

    // Invitations (TRB-030). The secret derives invitation tokens at send time so that
    // neither the database nor stored messages contain them. Without it, /admin invite
    // is refused. Rotating it invalidates invitations whose message is not yet sent.
    INVITATION_TOKEN_SECRET: optional(z.string().min(32, 'must be at least 32 characters')),
    INVITATION_TTL_HOURS: positiveIntWithDefault(168).refine(
      (hours) => hours <= 720,
      'must be at most 720 (30 days)',
    ),

    // Research. disabled (default): /research is refused. fake: simulated results,
    // clearly labelled, no OpenAI call. live: paid OpenAI research; operator opt-in.
    RESEARCH_MODE: z.preprocess(
      emptyAsUnset,
      z.enum(['disabled', 'fake', 'live']).default('disabled'),
    ),
    // Tasks (TRB-040; proposed SPEC §3 defaults). Paused tasks count as saved, not active.
    TASK_ACTIVE_LIMIT: positiveIntWithDefault(5),
    TASK_SAVED_LIMIT: positiveIntWithDefault(20),
    RESEARCH_TIME_ZONE: z.preprocess(emptyAsUnset, ianaTimeZone.default('Europe/Kyiv')),
    RESEARCH_PROMPT_MAX_CHARS: positiveIntWithDefault(8_000),
    // Maximum QUEUED + RUNNING research runs; further requests are rejected.
    RESEARCH_QUEUE_LIMIT: positiveIntWithDefault(3),
    // In-process database-backed workers. Tests disable them and drive ticks directly.
    BACKGROUND_WORKERS: z.preprocess(emptyAsUnset, z.enum(['on', 'off']).default('on')),
    WORKER_POLL_INTERVAL_MS: positiveIntWithDefault(2_000),
    OPENAI_POLL_INTERVAL_MS: positiveIntWithDefault(3_000),

    // OpenAI (required when RESEARCH_MODE=live). No default model: the operator must choose one.
    OPENAI_API_KEY: optional(secret),
    OPENAI_MODEL: optional(z.string().min(1)),
    // Optional; only sent when set. "minimal" is rejected: web search does not support it.
    OPENAI_REASONING_EFFORT: optional(z.enum(['none', 'low', 'medium', 'high', 'xhigh'])),
    // Timeout of each HTTP call to OpenAI (create/retrieve/cancel), not the run deadline.
    OPENAI_HTTP_TIMEOUT_MS: positiveIntWithDefault(30_000),

    // Budgets and run bounds. TRB-020 enforces RUN_DEADLINE_SECONDS, OUTPUT_TOKEN_LIMIT and
    // TOOL_CALL_LIMIT. Dollar amounts are parsed but NOT enforced before TRB-050.
    USER_MONTHLY_BUDGET_USD: optional(usdAmount),
    GLOBAL_MONTHLY_BUDGET_USD: optional(usdAmount),
    RUN_MAX_ESTIMATED_COST_USD: optional(usdAmount),
    RESEARCH_CONCURRENCY: optional(positiveInt),
    RUN_DEADLINE_SECONDS: optional(positiveInt),
    OUTPUT_TOKEN_LIMIT: optional(positiveInt),
    TOOL_CALL_LIMIT: optional(positiveInt),
  })
  .superRefine((env, ctx) => {
    const problem = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    const requireFor = (condition: string, names: readonly (keyof typeof env)[]) => {
      for (const name of names) {
        if (env[name] === undefined) problem(name, `is required when ${condition}`);
      }
    };

    if (env.NODE_ENV === 'production' && env.PUBLIC_BASE_URL?.startsWith('http://')) {
      problem('PUBLIC_BASE_URL', 'must use https in production (Telegram webhooks require HTTPS)');
    }

    if (env.TELEGRAM_MODE !== 'disabled') {
      requireFor(`TELEGRAM_MODE=${env.TELEGRAM_MODE}`, [
        'TELEGRAM_BOT_TOKEN',
        'ADMIN_TELEGRAM_IDS',
      ]);
      if (env.ADMIN_TELEGRAM_IDS?.length === 0) {
        problem('ADMIN_TELEGRAM_IDS', 'must list at least one administrator');
      }
    }
    if (env.TELEGRAM_MODE === 'webhook') {
      requireFor('TELEGRAM_MODE=webhook', ['TELEGRAM_WEBHOOK_SECRET']);
    }
    if (env.TELEGRAM_MODE === 'polling' && env.NODE_ENV === 'production') {
      problem('TELEGRAM_MODE', 'polling is for development only; use webhook in production');
    }

    if (env.RESEARCH_CONCURRENCY !== undefined && env.RESEARCH_CONCURRENCY !== 1) {
      problem(
        'RESEARCH_CONCURRENCY',
        'must be 1 (the TRB-020 prototype runs one request globally)',
      );
    }

    if (env.RESEARCH_MODE === 'live') {
      requireFor('RESEARCH_MODE=live', [
        'OPENAI_API_KEY',
        'OPENAI_MODEL',
        'OUTPUT_TOKEN_LIMIT',
        'TOOL_CALL_LIMIT',
        'RUN_DEADLINE_SECONDS',
      ]);
      if (env.OUTPUT_TOKEN_LIMIT !== undefined && env.OUTPUT_TOKEN_LIMIT < MIN_OUTPUT_TOKEN_LIMIT) {
        problem('OUTPUT_TOKEN_LIMIT', `must be at least ${MIN_OUTPUT_TOKEN_LIMIT}`);
      }
      if (
        env.RUN_DEADLINE_SECONDS !== undefined &&
        env.RUN_DEADLINE_SECONDS > MAX_RUN_DEADLINE_SECONDS
      ) {
        problem(
          'RUN_DEADLINE_SECONDS',
          `must be at most ${MAX_RUN_DEADLINE_SECONDS} (provider background retention window)`,
        );
      }
    }
  });

export type Env = z.output<typeof envSchema>;

export class ConfigValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

/** Parses and validates the environment. Throws ConfigValidationError listing every problem. */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (result.success) {
    return result.data;
  }
  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    // Environment values are strings, so a type mismatch means the variable is missing.
    const message = issue.code === 'invalid_type' ? 'is required' : issue.message;
    return `${name} ${message}`;
  });
  throw new ConfigValidationError(problems);
}
