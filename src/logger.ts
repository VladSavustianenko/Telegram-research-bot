import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { Env } from './config/env.schema';

const LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

/**
 * Structured JSON logs in production, readable logs locally. Callers must not
 * log prompts, results, tokens or full webhook bodies (CLAUDE.md).
 */
export function createLogger(config: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>): ConsoleLogger {
  const logLevels = LEVELS.slice(0, LEVELS.indexOf(config.LOG_LEVEL) + 1);
  return new ConsoleLogger({ json: config.NODE_ENV === 'production', logLevels });
}
