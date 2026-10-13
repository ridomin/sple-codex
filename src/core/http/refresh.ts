import type { StoredToken } from '../config/token-store.js'
import { isRecord, assertStoredToken } from '../config/token-store.js'
import { ProviderError } from '../provider/errors.js'

/** Merge a validated OAuth response, preserving absent refresh-token and scope fields. */
export function mergeTokenResponse (previous: StoredToken, response: unknown, now = Date.now()): StoredToken {
  if (!isRecord(response) || typeof response.access_token !== 'string' || !(response.access_token.trim() !== '')) throw new ProviderError('Invalid token response: access_token')
  const next = { ...previous, accessToken: response.access_token }
  for (const [field, target] of [['expires_in', 'expiresAt'], ['refresh_token_expires_in', 'refreshTokenExpiresAt']] as const) {
    const value = response[field]
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isFinite(new Date(now + value * 1000).getTime())) throw new ProviderError(`Invalid token response: ${field}`)
      next[target] = new Date(now + value * 1000).toISOString()
    }
  }
  if (response.refresh_token !== undefined) {
    if (typeof response.refresh_token !== 'string') throw new ProviderError('Invalid token response: refresh_token')
    next.refreshToken = response.refresh_token
  }
  if (response.scope !== undefined) {
    if (typeof response.scope !== 'string') throw new ProviderError('Invalid token response: scope')
    next.scopes = response.scope.split(/\s+/).filter(Boolean)
  }
  assertStoredToken(next); return next
}
