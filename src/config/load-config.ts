import { Env, parseEnv } from './env.schema';

/**
 * Loads `.env` into process.env when the file exists (local development only;
 * existing environment variables win), then validates the result.
 */
export function loadConfig(): Env {
  if (process.env['NODE_ENV'] !== 'production') {
    try {
      process.loadEnvFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  return parseEnv(process.env);
}
