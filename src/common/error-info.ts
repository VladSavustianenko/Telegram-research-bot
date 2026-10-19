/**
 * Loggable description of an error: class name and a short code only. Error
 * messages are deliberately excluded because driver and HTTP errors can embed
 * connection strings, URLs with tokens, or request content.
 */
export function errorInfo(error: unknown): { errorName: string; code?: string } {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const code = (error as { code?: unknown }).code;
  return {
    errorName: error.name,
    ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
  };
}
