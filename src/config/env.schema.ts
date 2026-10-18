import { z } from 'zod';

/**
 * Environment contract (docs/ARCHITECTURE.md §8).
 *
 * TRB-010 requires only the variables the foundation itself uses. Variables for
 * Telegram, OpenAI and budgets are validated for format when present; the
 * backlog items that introduce those features make them required and fail
 * closed when they are missing. Validation messages name variables only and
 * never echo values.
 */

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

    // Telegram (required from TRB-020).
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

    // OpenAI (required from TRB-020). No default model: the operator must choose one.
    OPENAI_API_KEY: optional(secret),
    OPENAI_MODEL: optional(z.string().min(1)),

    // Budgets and run bounds (required for paid research from TRB-020/050).
    USER_MONTHLY_BUDGET_USD: optional(usdAmount),
    GLOBAL_MONTHLY_BUDGET_USD: optional(usdAmount),
    RUN_MAX_ESTIMATED_COST_USD: optional(usdAmount),
    RESEARCH_CONCURRENCY: optional(positiveInt),
    RUN_DEADLINE_SECONDS: optional(positiveInt),
    OUTPUT_TOKEN_LIMIT: optional(positiveInt),
    TOOL_CALL_LIMIT: optional(positiveInt),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.PUBLIC_BASE_URL?.startsWith('http://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_BASE_URL'],
        message: 'must use https in production (Telegram webhooks require HTTPS)',
      });
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
