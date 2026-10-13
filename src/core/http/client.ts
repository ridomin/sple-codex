import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderId } from '../provider/capabilities.js';
import { AccessRestrictedError, AuthRequiredError, NotFoundError, ProviderError, RateLimitError } from '../provider/errors.js';
import type { StoredToken, TokenStore } from '../config/token-store.js';

export interface HttpLogEntry { method: string; path: string; status: number | string; durationMs: number; retries: number }
export interface HttpClientOptions {
  provider: ProviderId;
  baseUrl: string;
  tokenStore: Pick<TokenStore, 'loadTokens' | 'saveTokens'>;
  refresh?: (token: StoredToken) => Promise<StoredToken>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  log?: (entry: HttpLogEntry) => void;
  mapError?: (response: Response) => Promise<Error | undefined>;
  beforeRequest?: () => Promise<void>;
}
export interface RequestOptions extends RequestInit { authenticated?: boolean; retrySafe?: boolean }
export function retryAfter(value: string | null, now: number): number | undefined {
  if (!value?.trim()) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
export class HttpClient {
  private flight: Promise<StoredToken> | undefined;
  private lastRefresh: { previous: string; token: StoredToken } | undefined;
  private readonly send: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  constructor(private readonly options: HttpClientOptions) {
    this.send = options.fetch ?? fetch;
    this.sleep = options.sleep ?? (async ms => { await delay(ms); });
    this.now = options.now ?? Date.now;
  }
  private backoff(attempt: number): number { return Math.min(100 * 2 ** attempt * (0.8 + (this.options.random ?? Math.random)() * 0.4), 10_000); }
  private async refresh(token: StoredToken): Promise<StoredToken> {
    if (this.flight) return this.flight;
    if (this.lastRefresh?.previous === token.accessToken) return this.lastRefresh.token;
    if (!this.options.refresh || !token.refreshToken) throw new AuthRequiredError('token-expired');
    const refresh = this.options.refresh;
    this.flight = (async () => {
      const next = await refresh(token);
      await this.options.tokenStore.saveTokens(this.options.provider, next);
      this.lastRefresh = { previous: token.accessToken, token: next };
      return next;
    })();
    try { return await this.flight; } finally { this.flight = undefined; }
  }
  async request(path: string, init: RequestOptions = {}): Promise<Response> {
    const { authenticated = true, retrySafe, ...request } = init;
    const method = (request.method ?? 'GET').toUpperCase();
    const safe = retrySafe ?? ['GET', 'HEAD', 'OPTIONS'].includes(method);
    const url = new URL(path, this.options.baseUrl);
    // Absolute paths must not send a bearer token outside this provider's API origin.
    if (authenticated && url.origin !== new URL(this.options.baseUrl).origin) throw new ProviderError('Authenticated request cannot leave the provider API origin');
    const headers = new Headers(request.headers);
    const managedAuth = authenticated && !headers.has('Authorization');
    let token: StoredToken | null = null;
    if (managedAuth) {
      token = await this.options.tokenStore.loadTokens(this.options.provider);
      if (!token) throw new AuthRequiredError('no-token');
      if (token.expiresAt && Date.parse(token.expiresAt) < this.now() + 60_000 && this.options.refresh) token = await this.refresh(token);
    }
    let attempt = 0, retriedAuth = false;
    while (true) {
      if (token) headers.set('Authorization', `Bearer ${token.accessToken}`);
      await this.options.beforeRequest?.();
      const start = this.now();
      let response: Response;
      try { response = await this.send(url, { ...request, method, headers }); }
      catch (error) {
        this.log(url, method, 'ERR NETWORK', start, attempt);
        if (request.signal?.aborted) throw error;
        if (!safe) throw new ProviderError(`Outcome of ${method} request is unknown; it was not retried`);
        if (attempt >= 3) throw new ProviderError('Network request failed after 3 retries');
        await this.sleep(this.backoff(attempt++)); continue;
      }
      this.log(url, method, response.status, start, attempt);
      if (response.ok) return response;
      if (response.status === 401 && managedAuth && !retriedAuth && token) {
        retriedAuth = true;
        await response.body?.cancel();
        const current = await this.options.tokenStore.loadTokens(this.options.provider);
        token = current && current.accessToken !== token.accessToken ? current : await this.refresh(token);
        continue;
      }
      if (response.status === 429) {
        const wait = retryAfter(response.headers.get('Retry-After'), this.now()) ?? this.backoff(0);
        await response.body?.cancel();
        if (wait > 120_000 || attempt >= 3) throw new RateLimitError(wait);
        await this.sleep(wait); attempt++; continue;
      }
      if (response.status >= 500 && safe && attempt < 3) {
        const wait = retryAfter(response.headers.get('Retry-After'), this.now());
        await response.body?.cancel();
        await this.sleep(wait === undefined ? this.backoff(attempt) : Math.min(wait, 120_000)); attempt++; continue;
      }
      const mapped = await this.options.mapError?.(response);
      if (!response.bodyUsed) await response.body?.cancel();
      if (mapped) throw mapped;
      if (response.status === 401) throw new AuthRequiredError('token-expired');
      if (response.status === 404) throw new NotFoundError('other', path);
      if (response.status === 403) throw new AccessRestrictedError('other', 'Provider denied access');
      throw new ProviderError(response.status >= 500 ? `Service unavailable (HTTP ${response.status})${safe ? ' after 3 retries' : '; write was not retried'}` : `HTTP request failed (HTTP ${response.status})`);
    }
  }
  async json<T>(path: string, validate: (value: unknown) => T, init: RequestOptions = {}): Promise<T> {
    const response = await this.request(path, init);
    let value: unknown;
    try { value = await response.json(); } catch { throw new ProviderError(`Invalid JSON in response to ${init.method ?? 'GET'} ${new URL(path, this.options.baseUrl).pathname}`); }
    // Validators must report field names, never raw payloads.
    return validate(value);
  }
  private log(url: URL, method: string, status: number | string, start: number, retries: number): void {
    const copy = new URL(url);
    for (const key of ['q', 'uris']) { const value = copy.searchParams.get(key); if (value && value.length > 20) copy.searchParams.set(key, `${value.slice(0, 20)}...`); }
    this.options.log?.({ method, path: `${copy.pathname}${copy.search}`, status, durationMs: this.now() - start, retries });
  }
}
