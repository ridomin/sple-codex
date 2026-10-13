import { randomBytes, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ProviderError } from '../provider/errors.js'

export interface OAuthInteraction {
  showAuthorizationUrl: (url: string, mode: 'loopback' | 'no-browser' | 'manual') => Promise<void> | void
  promptForRedirectUrl: (prompt: string) => Promise<string>
}
export interface OAuthSecrets { verifier: string, challenge: string, state: string }
export function createOAuthSecrets (): OAuthSecrets {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('hex') }
}
export function authorizationUrl (endpoint: string, clientId: string, scopes: string[], redirectUri: string, secrets: OAuthSecrets, extras: Record<string, string> = {}): string {
  const url = new URL(endpoint)
  for (const [key, value] of Object.entries({ ...extras, client_id: clientId, response_type: 'code', code_challenge: secrets.challenge, code_challenge_method: 'S256', state: secrets.state, scope: scopes.join(' '), redirect_uri: redirectUri })) url.searchParams.set(key, value)
  return url.toString()
}
export function parseRedirect (line: string, state: string): string {
  let url: URL
  try { url = new URL(line.trim()) } catch { throw new ProviderError('Invalid redirect URL') }
  if (url.searchParams.get('state') !== state) throw new ProviderError('State validation failed')
  const error = url.searchParams.get('error')
  // Never echo arbitrary query parameters from an untrusted redirect into the terminal.
  if ((error != null && error !== '')) throw new ProviderError(`OAuth error: ${/^[a-z_]{1,64}$/.test(error) ? error : 'authorization_failed'}`)
  const code = url.searchParams.get('code')
  if (!(code != null && code !== '')) throw new ProviderError('Missing authorization code')
  return code
}
export interface AuthorizationCode { code: string, verifier: string, redirectUri: string }
export async function authorize (options: { endpoint: string, clientId: string, scopes: string[], mode: 'loopback' | 'no-browser' | 'manual', interaction: OAuthInteraction, extras?: Record<string, string>, timeoutMs?: number }): Promise<AuthorizationCode> {
  const secrets = createOAuthSecrets()
  if (options.mode === 'manual') {
    const redirectUri = 'http://127.0.0.1/callback'
    await options.interaction.showAuthorizationUrl(authorizationUrl(options.endpoint, options.clientId, options.scopes, redirectUri, secrets, options.extras), options.mode)
    const line = await options.interaction.promptForRedirectUrl('Paste the redirected URL: ')
    if (!(line !== '')) throw new ProviderError('No redirect URL received (stdin closed)')
    return { code: parseRedirect(line, secrets.state), verifier: secrets.verifier, redirectUri }
  }
  let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void
  const result = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
  // Attach a handler immediately, including while the interaction opens the browser.
  void result.catch(() => {})
  let port = 0
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    if (req.method !== 'GET' || url.pathname !== '/callback' || req.headers.host !== `127.0.0.1:${port}` || !url.searchParams.has('state')) {
      res.writeHead(400); res.end('Invalid callback'); return
    }
    try {
      const code = parseRedirect(url.toString(), secrets.state)
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('Authorization successful. You can close this window.'); resolveCode(code)
    } catch (error) { res.writeHead(400); res.end('Authorization failed'); rejectCode(error as Error) }
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as AddressInfo).port
  const redirectUri = `http://127.0.0.1:${port}/callback`
  const timer = setTimeout(() => rejectCode(new ProviderError('OAuth redirect timeout (10 minutes)')), options.timeoutMs ?? 600_000)
  try {
    await options.interaction.showAuthorizationUrl(authorizationUrl(options.endpoint, options.clientId, options.scopes, redirectUri, secrets, options.extras), options.mode)
    return { code: await result, verifier: secrets.verifier, redirectUri }
  } finally {
    clearTimeout(timer)
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => (error != null) ? reject(error) : resolve()))
  }
}
