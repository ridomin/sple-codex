export class ProviderError extends Error {
  constructor (message: string) { super(message); this.name = new.target.name }
}
export class UsageError extends ProviderError {}
export class AuthRequiredError extends ProviderError {
  constructor (public readonly reason: 'no-token' | 'token-expired' | 'missing-scope' | 'revoked', message = 'Authentication required', public readonly scope?: string) { super(message) }
}
export class NotFoundError extends ProviderError {
  constructor (public readonly resourceType: 'playlist' | 'track' | 'user' | 'other', message: string) { super(message) }
}
export class QuotaExhaustedError extends ProviderError {
  constructor (public readonly bucket: string, public readonly resetAt?: string) { super(`Quota exhausted: ${bucket}`) }
}
export class RateLimitError extends ProviderError {
  constructor (public readonly retryAfterMs?: number) { super('Rate limited') }
}
export class AccessRestrictedError extends ProviderError {
  constructor (public readonly reason: 'not-owned' | 'premium-required' | 'region-restricted' | 'other', message: string) { super(message) }
}

export function isFatalProviderError (error: unknown): boolean {
  return error instanceof AuthRequiredError || error instanceof QuotaExhaustedError || error instanceof RateLimitError
}
