import type { AuthStatus } from '../provider/provider.js'
import type { StoredToken } from '../config/token-store.js'

export function tokenStatus (token: StoredToken | null): AuthStatus {
  if (token == null) return { loggedIn: false, scopes: [] }
  return {
    loggedIn: true,
    user: { id: token.userId, ...(token.displayName !== undefined ? { displayName: token.displayName } : {}) },
    scopes: [...token.scopes],
    ...((token.expiresAt != null && token.expiresAt !== '') ? { expiresAt: token.expiresAt } : {}),
    ...((token.refreshTokenExpiresAt != null && token.refreshTokenExpiresAt !== '') ? { refreshTokenExpiresAt: token.refreshTokenExpiresAt } : {})
  }
}
