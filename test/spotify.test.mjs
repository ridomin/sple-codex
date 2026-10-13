import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpotifyProvider, spotifyScopes, parseSpotifyRef, mapSpotifyTrack } from '../dist/providers/spotify/index.js';
import { TokenStore } from '../dist/core/config/token-store.js';
const fixtures = JSON.parse(await readFile(new URL('./fixtures/spotify.json', import.meta.url), 'utf8'));
const id = fixtures.playlist.id, trackId = fixtures.track.id;
async function setup(t, handler, tokenPatch = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sple-spotify-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TokenStore(dir), calls = [], logs = [];
  await store.saveTokens('spotify', { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', userId: 'me', scopes: spotifyScopes, grantedAt: '2026-10-01T00:00:00Z', ...tokenPatch });
  const fetch = async (input, init) => { const url = new URL(input); calls.push({ url, init }); const result = await handler(url, init); return new Response(result.status === 204 ? null : typeof result.body === 'string' ? result.body : JSON.stringify(result.body), { status: result.status ?? 200, headers: result.headers }); };
  const provider = new SpotifyProvider({ clientId: 'client', tokenStore: store, fetch, sleep: async () => {}, now: () => Date.parse('2026-10-13T00:00:00Z'), log: entry => logs.push(entry) });
  return { provider, store, calls, logs, fetch };
}
test('Spotify refs are strict and mapping preserves optional metadata with safe fallbacks', () => {
  for (const input of [id, `spotify:playlist:${id}`, `https://open.spotify.com/intl-fr/playlist/${id}/?x=1#fragment`, `http://open.spotify.com/playlist/${id}`]) assert.equal(parseSpotifyRef(input, 'playlist'), id);
  for (const input of ['name', `https://evil.test/playlist/${id}`, `https://user@open.spotify.com/playlist/${id}`, `https://open.spotify.com:8888/playlist/${id}`, `ftp://open.spotify.com/playlist/${id}`, `spotify:track:${id}`, `https://open.spotify.com/playlist/${id}/extra`]) assert.equal(parseSpotifyRef(input, 'playlist'), null);
  const mapped = mapSpotifyTrack(fixtures.track, '2026-10-01T00:00:00Z'); assert.equal(mapped.isrc, 'USAAA2600001'); assert.equal(mapped.addedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(mapSpotifyTrack(null), null); assert.equal(mapSpotifyTrack({ is_local: true }), null); assert.equal(mapSpotifyTrack({ type: 'episode' }), null); assert.equal(mapSpotifyTrack({ type: 'future' }), null); assert.equal(mapSpotifyTrack({ is_playable: false }), null);
  assert.deepEqual(mapSpotifyTrack({ id: trackId, artists: [] }), { title: '(untitled)', artists: ['Unknown Artist'], refs: { spotify: `spotify:track:${trackId}` }, isrc: null });
  for (const value of [{ id: 'bad' }, { id: trackId, artists: 'bad' }, { id: trackId, duration_ms: -1 }, []]) assert.throws(() => mapSpotifyTrack(value), /Invalid Spotify response/);
  assert.throws(() => mapSpotifyTrack(fixtures.track, 'bad'), /added_at/);
});
test('adapter searches every type, paginates, and owns matching query syntax', async t => {
  const s = await setup(t, url => {
    const type = url.searchParams.get('type');
    const item = type === 'track' ? fixtures.track : type === 'playlist' ? fixtures.playlist : type === 'album' ? { id: trackId, name: 'Album', artists: [{ name: 'Artist' }], release_date: '2026', total_tracks: 1 } : { id: trackId, name: 'Artist' };
    return { body: { [`${type}s`]: { items: [null, item], total: 3, next: 'https://api.spotify.com/v1/search?offset=2' } } };
  });
  for (const type of ['track', 'album', 'artist', 'playlist']) { const page = await s.provider.search({ text: 'query', type }, { limit: 2 }); assert.equal(page.items.length, 1); assert.deepEqual(page.next, { offset: 2 }); }
  assert.equal((await s.provider.searchTracks({ kind: 'isrc', isrc: 'USAAA' }, { limit: 5 }))[0].ref, fixtures.track.uri); assert.equal(s.calls.at(-1).url.searchParams.get('q'), 'isrc:USAAA');
  await s.provider.searchTracks({ kind: 'metadata', title: 'Song', artists: ['Artist', 'Other'] }, { limit: 10 }); assert.equal(s.calls.at(-1).url.searchParams.get('q'), 'Song Artist');
  await assert.rejects(s.provider.search({ text: 'q', type: 'track' }, { limit: 11 }), /limit/);
  assert.equal(s.provider.parseTrackRef(trackId), fixtures.track.uri); assert.equal(s.provider.parseTrackRef('bad'), null);
});
test('playlist reads use item, liked reads use track; access/unsupported/filter semantics hold', async t => {
  const s = await setup(t, url => {
    if (url.pathname === '/v1/me/playlists') return { body: { items: [fixtures.playlist, { ...fixtures.playlist, id: trackId, owner: { id: 'other' }, items: undefined }], total: 2, next: null } };
    if (url.pathname.endsWith('/items') || url.pathname === '/v1/me/tracks') return { body: { items: [{ added_at: '2026-10-01T00:00:00Z', [url.pathname.endsWith('/items') ? 'item' : 'track']: fixtures.track }, { item: null, track: null }, { is_local: true }, { item: { type: 'episode' }, track: { type: 'episode' } }], total: 4, next: null } };
    return { body: fixtures.playlist };
  });
  const all = await s.provider.listPlaylists({ limit: 50 }); assert.equal(all.items[1].itemsReadable, false);
  assert.equal((await s.provider.listPlaylists({ limit: 50 }, 'owned')).items.length, 1); assert.equal((await s.provider.listPlaylists({ limit: 50 }, 'followed')).total, undefined);
  assert.equal((await s.provider.getPlaylist(id)).owned, true);
  assert.equal((await s.provider.getPlaylistTracks(id, { limit: 100 })).items.length, 1);
  assert.equal((await s.provider.getLikedTracks({ limit: 50 })).items[0].isrc, 'USAAA2600001');
  const blocked = await setup(t, () => ({ status: 403, body: { error: { message: 'denied' } } })); await assert.rejects(blocked.provider.getPlaylistTracks(id, { limit: 100 }), e => e.reason === 'not-owned');
  const absent = await setup(t, () => ({ status: 404, body: {} })); await assert.rejects(absent.provider.getPlaylist(id), e => e.resourceType === 'playlist'); await assert.rejects(absent.provider.getPlaylistTracks(id, { limit: 100 }), e => e.reason === 'not-owned');
});
test('writes use current endpoints, preserve duplicate tracks, and batch failures are reported', async t => {
  const s = await setup(t, (url, init) => ({ status: init.method === 'DELETE' ? 204 : 201, body: url.pathname === '/v1/me/playlists' ? fixtures.playlist : { snapshot_id: 'snapshot' } }));
  assert.equal((await s.provider.createPlaylist({ name: 'Road Trip', public: false })).id, id);
  assert.equal(s.calls[0].url.pathname, '/v1/me/playlists'); assert.deepEqual(JSON.parse(s.calls[0].init.body), { name: 'Road Trip', public: false });
  await assert.rejects(s.provider.createPlaylist({ name: 'bad', public: true, collaborative: true }), /private/);
  await s.provider.removePlaylist(id); assert.equal(s.calls.at(-1).url.pathname, '/v1/me/library'); assert.equal(s.calls.at(-1).url.searchParams.get('uris'), `spotify:playlist:${id}`);
  const result = await s.provider.populatePlaylist(id, [...Array(101).fill(fixtures.track.uri), 'bad'], { skipExisting: false }); assert.equal(result.added.length, 101); assert.equal(result.failed.length, 1);
  assert.equal(JSON.parse(s.calls.at(-2).init.body).uris.length, 100); assert.equal(JSON.parse(s.calls.at(-1).init.body).uris.length, 1);
  const failed = await setup(t, () => ({ status: 400, body: { error: { message: 'secret' } } })); assert.equal((await failed.provider.populatePlaylist(id, [fixtures.track.uri], { skipExisting: false })).failed.length, 1);
  const limited = await setup(t, () => ({ status: 429, body: {}, headers: { 'Retry-After': '999' } })); await assert.rejects(limited.provider.populatePlaylist(id, [fixtures.track.uri], { skipExisting: false }), e => e.name === 'RateLimitError');
  const existing = await setup(t, () => ({ body: { items: [{ item: fixtures.track }], total: 1, next: null } })); assert.deepEqual(await existing.provider.populatePlaylist(id, [fixtures.track.uri], { skipExisting: true }), { added: [], failed: [] });
});
test('scopes and missing configuration fail before HTTP; status/logout remain offline', async t => {
  const s = await setup(t, () => { throw new Error('must not call'); }, { scopes: [] });
  await assert.rejects(s.provider.getLikedTracks({ limit: 50 }), e => e.scope === 'user-library-read'); assert.equal(s.calls.length, 0);
  await s.store.deleteTokens('spotify'); await assert.rejects(s.provider.search({ text: 'q', type: 'track' }, { limit: 1 }), e => e.reason === 'no-token');
  const missing = new SpotifyProvider({ tokenStore: s.store }); assert.equal((await missing.auth.status()).loggedIn, false); await missing.auth.logout();
  await assert.rejects(missing.auth.login({ scopes: [], mode: 'manual' }), /Missing Spotify client ID/);
  await assert.rejects(s.provider.auth.login({ scopes: [], mode: 'manual' }), /interaction/);
});
const interaction = () => { let url; return { showAuthorizationUrl: value => { url = new URL(value); }, promptForRedirectUrl: async () => `http://127.0.0.1/callback?state=${url.searchParams.get('state')}&code=synthetic-code` }; };
test('PKCE login validates identity before saving; refresh rotates and persists credentials', async t => {
  const s = await setup(t, url => ({ body: url.hostname === 'accounts.spotify.com' ? fixtures.token : fixtures.user }));
  await s.store.deleteTokens('spotify'); const status = await s.provider.auth.login({ scopes: [], mode: 'manual', interaction: interaction() }); assert.equal(status.user.displayName, 'Listener');
  const form = s.calls[0].init.body; assert.equal(form.get('redirect_uri'), 'http://127.0.0.1/callback'); assert.equal(form.get('client_secret'), null); assert.equal(form.get('code_verifier').length, 43); assert.equal((await s.store.loadTokens('spotify')).refreshToken, 'synthetic-refresh');
  assert.ok(s.logs[0].path.includes('accounts.spotify.com')); assert.equal(JSON.stringify(s.logs).includes('synthetic-code'), false);
  const refreshed = await setup(t, url => ({ body: url.hostname === 'accounts.spotify.com' ? { access_token: 'rotated', refresh_token: 'rotated-refresh', expires_in: 3600 } : { tracks: { items: [fixtures.track], total: 1, next: null } } }), { expiresAt: '2000-01-01T00:00:00Z' });
  await refreshed.provider.search({ text: 'q', type: 'track' }, { limit: 1 }); assert.equal((await refreshed.store.loadTokens('spotify')).accessToken, 'rotated'); assert.equal(refreshed.calls[0].init.body.get('grant_type'), 'refresh_token');
  const premium = await setup(t, url => url.hostname === 'accounts.spotify.com' ? { body: fixtures.token } : { status: 403, body: { error: { message: 'Premium required' } } });
  await premium.store.deleteTokens('spotify'); await assert.rejects(premium.provider.auth.login({ scopes: [], mode: 'manual', interaction: interaction() }), e => e.reason === 'premium-required'); assert.equal(await premium.store.loadTokens('spotify'), null);
});
test('token errors and invalid API payloads map to bounded messages, never raw bodies', async t => {
  for (const [status, body, expected] of [[400, { error: 'invalid_grant' }, /authorization code/], [401, {}, /SPLE_SPOTIFY/], [429, '<html>throttled</html>', /Rate limited/], [503, {}, /unavailable/], [400, { error: 'bad_request', error_description: 'SECRET' }, /HTTP 400/], [200, 'not json', /Invalid JSON/]]) {
    const s = await setup(t, () => ({ status, body })); await assert.rejects(s.provider.auth.login({ scopes: [], mode: 'manual', interaction: interaction() }), e => expected.test(e.message) && !e.message.includes('SECRET'));
  }
  const revoked = await setup(t, () => ({ status: 400, body: { error: 'invalid_grant' } }), { expiresAt: '2000-01-01T00:00:00Z' }); await assert.rejects(revoked.provider.search({ text: 'q', type: 'track' }, { limit: 1 }), e => e.reason === 'revoked');
  for (const body of [{ tracks: { items: 'bad' } }, { tracks: { items: [], total: -1 } }, { tracks: { items: [], next: 'https://api.spotify.com/v1/search?offset=0' } }]) { const s = await setup(t, () => ({ body })); await assert.rejects(s.provider.search({ text: 'q', type: 'track' }, { limit: 1 }), /Invalid Spotify response/); }
});
