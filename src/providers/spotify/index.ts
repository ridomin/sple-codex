import type { ProviderCapabilities } from '../../core/provider/capabilities.js';
import type { CanonicalTrack, Page, PageRequest, PlaylistSummary, Provider, SearchItem, SearchType, TrackQuery } from '../../core/provider/provider.js';
import { AccessRestrictedError, AuthRequiredError, NotFoundError, ProviderError, RateLimitError, UsageError, isFatalProviderError } from '../../core/provider/errors.js';
import { TokenStore, isRecord } from '../../core/config/token-store.js';
import type { StoredToken } from '../../core/config/token-store.js';
import { tokenStatus } from '../../core/auth/status.js';
import { authorize } from '../../core/auth/oauth.js';
import { HttpClient, retryAfter } from '../../core/http/client.js';
import type { HttpClientOptions } from '../../core/http/client.js';
import { mergeTokenResponse } from '../../core/http/refresh.js';
import { collectPages } from '../../core/provider/pagination.js';

export const spotifyScopes = ['playlist-read-private', 'playlist-read-collaborative', 'user-library-read', 'playlist-modify-public', 'playlist-modify-private'];
export const spotifyCapabilities: ProviderCapabilities = {
  official: true, requiresRiskAcknowledgement: false, userSuppliedClientId: true, requiresClientSecret: false,
  supportsRefreshToken: true, supportsRevocation: false, paginationModel: 'offset', maxSearchPageSize: 10,
  readPageSize: { playlists: 50, playlistItems: 100, liked: 50 }, playlistItemsAccess: 'owned-or-collaborator',
  likedSongs: { read: 'exact', write: false }, isrcSearchMode: 'filter', searchReturnsDuration: true, musicAwareSearch: true,
  canDeletePlaylist: false, supportsCollaborative: true, maxTracksPerRequest: 100, maxPlaylistSize: 10_000, quotaModel: { kind: 'rate-limited' },
};
function object(value: unknown, field: string): Record<string, unknown> { if (!isRecord(value)) throw new ProviderError(`Invalid Spotify response: ${field}`); return value; }
function string(value: unknown, field: string): string { if (typeof value !== 'string' || !value) throw new ProviderError(`Invalid Spotify response: ${field}`); return value; }
function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function count(value: unknown): number | undefined { return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined; }
function url(value: Record<string, unknown>): string | undefined { return isRecord(value.external_urls) ? text(value.external_urls.spotify) : undefined; }
export function parseSpotifyRef(input: string, kind: 'playlist' | 'track'): string | null {
  const plain = /^[A-Za-z0-9]{22}$/;
  if (plain.test(input)) return input;
  const uri = new RegExp(`^spotify:${kind}:([A-Za-z0-9]{22})$`).exec(input); if (uri) return uri[1]!;
  try {
    const parsed = new URL(input);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.hostname !== 'open.spotify.com' || parsed.username || parsed.password || parsed.port) return null;
    return new RegExp(`^/(?:intl-[a-z]{2}/)?${kind}/([A-Za-z0-9]{22})/?$`).exec(parsed.pathname)?.[1] ?? null;
  } catch { return null; }
}
export function mapSpotifyTrack(value: unknown, addedAt?: string): CanonicalTrack | null {
  if (value === null) return null;
  const track = object(value, 'track');
  if (track.is_local === true || track.type === 'episode' || track.is_playable === false) return null;
  if (track.type !== undefined && track.type !== 'track') return null;
  const id = string(track.id, 'track.id'); if (!parseSpotifyRef(id, 'track')) throw new ProviderError('Invalid Spotify response: track.id');
  if (track.artists !== undefined && !Array.isArray(track.artists)) throw new ProviderError('Invalid Spotify response: track.artists');
  const artists = (track.artists as unknown[] | undefined ?? []).map(a => text(object(a, 'artist').name)).filter((s): s is string => !!s);
  const result: CanonicalTrack = { title: text(track.name) || '(untitled)', artists: artists.length ? artists : ['Unknown Artist'], refs: { spotify: `spotify:track:${id}` }, isrc: isRecord(track.external_ids) ? text(track.external_ids.isrc) ?? null : null };
  if (isRecord(track.album) && text(track.album.name) !== undefined) result.album = text(track.album.name)!;
  if (track.duration_ms !== undefined && count(track.duration_ms) === undefined) throw new ProviderError('Invalid Spotify response: duration_ms');
  if (count(track.duration_ms) !== undefined) result.durationMs = count(track.duration_ms)!;
  if (addedAt) { if (!Number.isFinite(Date.parse(addedAt))) throw new ProviderError('Invalid Spotify response: added_at'); result.addedAt = new Date(addedAt).toISOString(); }
  return result;
}
export interface SpotifyOptions { clientId?: string; tokenStore: TokenStore; fetch?: typeof fetch; now?: () => number; sleep?: HttpClientOptions['sleep']; log?: HttpClientOptions['log'] }
export class SpotifyProvider implements Provider {
  readonly id = 'spotify'; readonly displayName = 'Spotify'; readonly capabilities = structuredClone(spotifyCapabilities);
  readonly auth: Provider['auth']; private readonly http: HttpClient; private readonly send: typeof fetch; private readonly now: () => number;
  constructor(private readonly options: SpotifyOptions) {
    this.send = options.fetch ?? fetch; this.now = options.now ?? Date.now;
    this.http = new HttpClient({ provider: 'spotify', baseUrl: 'https://api.spotify.com/v1/', tokenStore: options.tokenStore, fetch: this.send, now: this.now,
      ...(options.sleep ? { sleep: options.sleep } : {}), ...(options.log ? { log: options.log } : {}),
      refresh: token => this.refresh(token), mapError: response => this.mapError(response) });
    this.auth = {
      status: async () => tokenStatus(await options.tokenStore.loadTokens('spotify')),
      logout: async () => { await options.tokenStore.deleteTokens('spotify'); return { revoked: false, deletedData: ['spotify tokens'], notice: 'Revoke Spotify access manually at https://www.spotify.com/account/apps/' }; },
      login: async opts => {
        const clientId = this.clientId(); if (!opts.interaction) throw new UsageError('OAuth interaction is required');
        const grant = await authorize({ endpoint: 'https://accounts.spotify.com/authorize', clientId, scopes: opts.scopes.length ? opts.scopes : spotifyScopes, mode: opts.mode, interaction: opts.interaction });
        const response = await this.tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', code: grant.code, redirect_uri: grant.redirectUri, client_id: clientId, code_verifier: grant.verifier }));
        const access = string(object(response, 'token').access_token, 'access_token');
        const identity = await this.http.json('me', v => object(v, 'user'), { authenticated: false, headers: { Authorization: `Bearer ${access}` } });
        const requestedScopes = opts.scopes.length ? opts.scopes : spotifyScopes;
        const base: StoredToken = { accessToken: access, userId: string(identity.id, 'user.id'), scopes: requestedScopes, grantedAt: new Date(this.now()).toISOString(), ...(text(identity.display_name) ? { displayName: text(identity.display_name)! } : {}) };
        const token = mergeTokenResponse(base, response, this.now()); await options.tokenStore.saveTokens('spotify', token); return tokenStatus(token);
      },
    };
  }
  private clientId(): string { if (!this.options.clientId?.trim()) throw new UsageError('Missing Spotify client ID. Set SPLE_SPOTIFY_CLIENT_ID in your environment or .env file.'); return this.options.clientId; }
  private async requireScopes(scopes: string[]): Promise<StoredToken> {
    this.clientId(); const token = await this.options.tokenStore.loadTokens('spotify'); if (!token) throw new AuthRequiredError('no-token');
    for (const scope of scopes) if (!token.scopes.includes(scope)) throw new AuthRequiredError('missing-scope', 'Missing Spotify scope', scope);
    return token;
  }
  private async tokenRequest(form: URLSearchParams): Promise<unknown> {
    const start = this.now(); let response: Response;
    try { response = await this.send('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form }); }
    catch { this.options.log?.({ method: 'POST', path: 'accounts.spotify.com/api/token', status: 'ERR NETWORK', durationMs: this.now() - start, retries: 0 }); throw new ProviderError('Spotify token request failed (network error)'); }
    this.options.log?.({ method: 'POST', path: 'accounts.spotify.com/api/token', status: response.status, durationMs: this.now() - start, retries: 0 });
    let value: unknown;
    try { value = await response.json(); } catch { if (response.ok) throw new ProviderError('Invalid JSON from Spotify token endpoint'); value = undefined; }
    if (response.ok) return value;
    const code = isRecord(value) && typeof value.error === 'string' && /^[a-z_]{1,64}$/.test(value.error) ? value.error : undefined;
    if (code === 'invalid_grant') {
      if (form.get('grant_type') === 'refresh_token') throw new AuthRequiredError('revoked', 'Spotify authorization expired or was revoked; run "sple auth login --provider spotify"');
      throw new ProviderError('Spotify rejected the authorization code; run "sple auth login" again');
    }
    if (response.status === 401 || code === 'invalid_client' || code === 'unauthorized_client') throw new ProviderError('Spotify rejected SPLE_SPOTIFY_CLIENT_ID; check your app client ID and redirect URIs');
    if (response.status === 429) throw new RateLimitError(retryAfter(response.headers.get('Retry-After'), this.now()));
    throw new ProviderError(response.status >= 500 ? 'Spotify token endpoint unavailable' : `Spotify token request failed (HTTP ${response.status}${code ? `, ${code}` : ''})`);
  }
  private async refresh(token: StoredToken): Promise<StoredToken> { return mergeTokenResponse(token, await this.tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refreshToken!, client_id: this.clientId() })), this.now()); }
  private async mapError(response: Response): Promise<Error> {
    let body: unknown; try { body = await response.json(); } catch { body = undefined; }
    if (response.status === 401) return new AuthRequiredError('token-expired');
    if (response.status === 403) {
      const premium = isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' && /premium/i.test(body.error.message);
      return new AccessRestrictedError(premium ? 'premium-required' : 'other', premium ? 'Spotify Premium is required for the app owner. See docs/user/setup.md.' : 'Spotify denied access');
    }
    if (response.status === 404) return new NotFoundError('other', 'Spotify resource');
    return new ProviderError(`Spotify API request failed (HTTP ${response.status})`);
  }
  parsePlaylistRef(input: string): string | null { return parseSpotifyRef(input, 'playlist'); }
  parseTrackRef(input: string): string | null { const ref = parseSpotifyRef(input, 'track'); return ref ? `spotify:track:${ref}` : null; }
  private page<T>(value: unknown, request: PageRequest, mapper: (v: unknown) => T | null): Page<T> {
    const data = object(value, 'page'); if (!Array.isArray(data.items)) throw new ProviderError('Invalid Spotify response: page.items');
    const items = data.items.map(mapper).filter((v): v is T => v !== null); const page: Page<T> = { items };
    if (data.total !== undefined && count(data.total) === undefined) throw new ProviderError('Invalid Spotify response: page.total');
    if (count(data.total) !== undefined) page.total = count(data.total)!;
    if (typeof data.next === 'string') { const next = Number(new URL(data.next).searchParams.get('offset')); if (!Number.isInteger(next) || next <= (request.offset ?? 0)) throw new ProviderError('Invalid Spotify response: next.offset'); page.next = { offset: next }; }
    else if (data.next === undefined && page.total !== undefined && (request.offset ?? 0) + data.items.length < page.total && data.items.length) page.next = { offset: (request.offset ?? 0) + data.items.length };
    return page;
  }
  private summary(value: unknown, userId: string): PlaylistSummary {
    const p = object(value, 'playlist'), owner = object(p.owner, 'playlist.owner');
    const ownerId = string(owner.id, 'playlist.owner.id'), id = string(p.id, 'playlist.id');
    if (!this.parsePlaylistRef(id)) throw new ProviderError('Invalid Spotify response: playlist.id');
    const summary: PlaylistSummary = { id, ref: id, name: string(p.name, 'playlist.name'), owner: { id: ownerId, ...(text(owner.display_name) ? { displayName: text(owner.display_name)! } : {}) }, owned: ownerId === userId, itemsReadable: ownerId === userId || isRecord(p.items) };
    if (text(p.description) !== undefined) summary.description = text(p.description)!;
    if (typeof p.public === 'boolean') summary.public = p.public;
    if (typeof p.collaborative === 'boolean') summary.collaborative = p.collaborative;
    if (isRecord(p.items) && count(p.items.total) !== undefined) summary.trackCount = count(p.items.total)!;
    if (url(p)) summary.url = url(p)!;
    return summary;
  }
  async search(query: { text: string; type: SearchType }, request: PageRequest): Promise<Page<SearchItem>> {
    await this.requireScopes([]); if (request.limit > 10 || (request.offset ?? 0) + request.limit > 1000) throw new UsageError('Spotify search pages require limit ≤10 and offset + limit ≤1000');
    const params = new URLSearchParams({ q: query.text, type: query.type, limit: String(request.limit), offset: String(request.offset ?? 0) });
    return this.http.json(`search?${params}`, value => this.page(object(value, 'search')[`${query.type}s`], request, v => {
      if (v === null) return null;
      const item = object(v, 'search.item'), id = string(item.id, 'search.id'), name = text(item.name) || '(untitled)';
      const base = { id, ref: text(item.uri) ?? `spotify:${query.type}:${id}`, name, ...(url(item) ? { url: url(item)! } : {}) };
      if (query.type === 'track') { const track = mapSpotifyTrack(item); return track ? { ...base, type: 'track', track } : null; }
      if (query.type === 'artist') return { ...base, type: 'artist' };
      if (query.type === 'album') return { ...base, type: 'album', artists: Array.isArray(item.artists) ? item.artists.map(a => text(object(a, 'artist').name) ?? 'Unknown Artist') : ['Unknown Artist'], ...(text(item.release_date) ? { releaseDate: text(item.release_date)! } : {}), ...(count(item.total_tracks) !== undefined ? { trackCount: count(item.total_tracks)! } : {}) };
      const owner = object(item.owner, 'playlist.owner'); return { ...base, type: 'playlist', owner: { id: string(owner.id, 'owner.id') }, ...(isRecord(item.items) && count(item.items.total) !== undefined ? { trackCount: count(item.items.total)! } : {}) };
    }));
  }
  async listPlaylists(request: PageRequest, filter?: 'owned' | 'followed'): Promise<Page<PlaylistSummary>> {
    const token = await this.requireScopes(['playlist-read-private', 'playlist-read-collaborative']);
    const page = await this.http.json(`me/playlists?limit=${request.limit}&offset=${request.offset ?? 0}`, v => this.page(v, request, p => p === null ? null : this.summary(p, token.userId)));
    if (filter) { page.items = page.items.filter(p => p.owned === (filter === 'owned')); delete page.total; } return page;
  }
  async getPlaylist(ref: string): Promise<PlaylistSummary> {
    const token = await this.requireScopes(['playlist-read-private']);
    try { return await this.http.json(`playlists/${encodeURIComponent(ref)}`, v => this.summary(v, token.userId)); }
    catch (e) { if (e instanceof NotFoundError) throw new NotFoundError('playlist', ref); throw e; }
  }
  async getPlaylistTracks(ref: string, request: PageRequest): Promise<Page<CanonicalTrack>> {
    await this.requireScopes(['playlist-read-private']);
    try { return await this.readTracks(`playlists/${encodeURIComponent(ref)}/items`, request, 'item'); }
    catch (e) { if ((e instanceof AccessRestrictedError && e.reason === 'other') || e instanceof NotFoundError) throw new AccessRestrictedError('not-owned', 'Spotify only returns tracks for playlists you own or collaborate on'); throw e; }
  }
  private async readTracks(path: string, request: PageRequest, field: 'item' | 'track'): Promise<Page<CanonicalTrack>> {
    return this.http.json(`${path}?limit=${request.limit}&offset=${request.offset ?? 0}`, v => this.page(v, request, entry => { const item = object(entry, 'playlist.item'); return item.is_local === true || item[field] === null ? null : mapSpotifyTrack(item[field], text(item.added_at)); }));
  }
  async getLikedTracks(request: PageRequest): Promise<Page<CanonicalTrack>> { await this.requireScopes(['user-library-read']); return this.readTracks('me/tracks', request, 'track'); }
  async createPlaylist(input: { name: string; description?: string; public: boolean; collaborative?: boolean }): Promise<PlaylistSummary> {
    if (input.public && input.collaborative) throw new UsageError('Collaborative playlists must be private');
    const token = await this.requireScopes(input.collaborative ? ['playlist-modify-public', 'playlist-modify-private'] : [input.public ? 'playlist-modify-public' : 'playlist-modify-private']);
    return this.http.json('me/playlists', v => this.summary(v, token.userId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  }
  async removePlaylist(ref: string): Promise<{ action: 'unfollowed' }> {
    await this.requireScopes(['playlist-modify-public', 'playlist-modify-private']); await this.http.request(`me/library?${new URLSearchParams({ uris: `spotify:playlist:${ref}` })}`, { method: 'DELETE' }); return { action: 'unfollowed' };
  }
  async updatePlaylist(ref: string, patch: { name?: string; description?: string; public?: boolean }): Promise<PlaylistSummary> {
    if (!Object.keys(patch).length || (patch.name !== undefined && !patch.name.trim())) throw new UsageError('Playlist edits require a non-empty patch and name');
    await this.requireScopes(['playlist-modify-public', 'playlist-modify-private']);
    const current = await this.getPlaylist(ref);
    if (!current.owned) throw new AccessRestrictedError('other', 'Spotify playlist editing requires ownership');
    if (current.collaborative && patch.public) throw new UsageError('Collaborative playlists must remain private');
    await this.http.request(`playlists/${encodeURIComponent(ref)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch), retrySafe: true });
    // The endpoint returns no object; reflect the acknowledged patch over validated metadata.
    return { ...current, ...patch };
  }
  async searchTracks(query: TrackQuery, options: { limit: number }): Promise<{ ref: string; track: CanonicalTrack }[]> {
    const page = await this.search({ text: query.kind === 'isrc' ? `isrc:${query.isrc}` : `${query.title} ${query.artists[0] ?? ''}`.trim(), type: 'track' }, { limit: Math.min(10, options.limit) });
    return page.items.flatMap(item => item.type === 'track' ? [{ ref: item.ref, track: item.track }] : []);
  }
  async populatePlaylist(ref: string, refs: string[], options: { skipExisting: boolean }): Promise<{ added: string[]; failed: { ref: string; error: string }[] }> {
    await this.requireScopes(['playlist-modify-public', 'playlist-modify-private']);
    const added: string[] = [], failed: { ref: string; error: string }[] = [];
    const existing = options.skipExisting ? new Set((await collectPages(p => this.getPlaylistTracks(ref, p), 100)).items.map(t => t.refs.spotify)) : new Set<string>();
    const valid = refs.filter(r => { if (!/^spotify:track:[A-Za-z0-9]{22}$/.test(r)) { failed.push({ ref: r, error: 'Not a Spotify track URI' }); return false; } return !existing.has(r); });
    for (let i = 0; i < valid.length; i += 100) {
      const batch = valid.slice(i, i + 100);
      try { await this.http.json(`playlists/${encodeURIComponent(ref)}/items`, v => string(object(v, 'snapshot').snapshot_id, 'snapshot_id'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uris: batch }) }); added.push(...batch); }
      catch (e) { if (isFatalProviderError(e)) throw e; failed.push(...batch.map(ref => ({ ref, error: e instanceof Error ? e.message : 'Provider error' }))); }
    }
    return { added, failed };
  }
}
