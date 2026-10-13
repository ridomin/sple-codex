import { AccessRestrictedError, AuthRequiredError, NotFoundError, QuotaExhaustedError, RateLimitError, UsageError } from '../core/provider/errors.js';
import { redact } from './output/logging.js';

export function getExitCode(error: unknown): number {
  if (error instanceof UsageError) return 2;
  if (error instanceof AuthRequiredError) return 3;
  if (error instanceof NotFoundError) return 4;
  if (error instanceof QuotaExhaustedError || error instanceof RateLimitError) return 5;
  return 1;
}
export function formatErrorMessage(error: unknown): string {
  if (error instanceof AuthRequiredError) {
    if (error.scope) return `Missing scope '${error.scope}'. Run "sple auth login" to grant ${error.scope}`;
    return error.reason === 'revoked' ? error.message : 'Authentication required. Run "sple auth login" to log in.';
  }
  if (error instanceof NotFoundError) return `${error.resourceType} not found: ${error.message}`;
  if (error instanceof QuotaExhaustedError) return `Quota exhausted: ${error.bucket}${error.resetAt ? ` (resets at ${error.resetAt})` : ''}`;
  if (error instanceof RateLimitError) return `Rate limited. Please try again later.${error.retryAfterMs !== undefined ? ` Retry after ${Math.ceil(error.retryAfterMs / 1000)}s.` : ''}`;
  if (error instanceof AccessRestrictedError) return `Access restricted: ${error.message}`;
  return error instanceof Error ? error.message : 'Unexpected error';
}
export function writeError(error: unknown, options: { json?: boolean; debug?: boolean; write?: (line: string) => void } = {}): number {
  const write = options.write ?? (line => { process.stderr.write(line); });
  const exitCode = getExitCode(error), message = redact(formatErrorMessage(error));
  write(`sple: ${message}\n`);
  if (options.debug && error instanceof Error && error.stack) write(`${redact(error.stack)}\n`);
  if (options.json) write(`${JSON.stringify({ error: { type: error instanceof Error ? error.name : 'Error', message, exitCode } })}\n`);
  return exitCode;
}
