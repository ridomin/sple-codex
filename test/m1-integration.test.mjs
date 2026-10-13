import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpotifyProvider, spotifyScopes } from '../dist/providers/spotify/index.js';
import { TokenStore } from '../dist/core/config/token-store.js';
import { ProviderRegistry } from '../dist/core/provider/registry.js';
import { runCli } from '../dist/cli/app.js';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/spotify.json', import.meta.url), 'utf8'));
test('1,000-track Spotify export uses ordered bounded pagination and produces one canonical document', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sple-integration-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TokenStore(dir); await store.saveTokens('spotify', { accessToken: 'synthetic', userId: 'me', scopes: spotifyScopes, grantedAt: '2026-10-01T00:00:00Z' });
  let active = 0, maximum = 0, reads = 0, stdout = '', stderr = '';
  const provider = new SpotifyProvider({ clientId: 'client', tokenStore: store, fetch: async input => {
    const url = new URL(input);
    if (!url.pathname.endsWith('/items')) return new Response(JSON.stringify({ ...fixtures.playlist, items: { total: 1000 } }));
    reads++; active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 2)); active--;
    const offset = Number(url.searchParams.get('offset'));
    return new Response(JSON.stringify({ items: Array.from({ length: 100 }, (_, i) => ({ item: { ...fixtures.track, name: `Song ${offset + i}` }, added_at: '2026-10-01T00:00:00Z' })), total: 1000, next: offset < 900 ? `https://api.spotify.com/v1/playlists/${fixtures.playlist.id}/items?offset=${offset + 100}` : null }));
  } });
  const registry = new ProviderRegistry(); registry.register({ id: 'spotify', displayName: 'Spotify', create: () => provider });
  const start = performance.now();
  const code = await runCli(['export', fixtures.playlist.id], { config: { directory: dir, defaultProvider: 'spotify', enableFakeProvider: false }, store, registry, version: '0.1.0', stdout: s => { stdout += s; }, stderr: s => { stderr += s; }, stdoutTTY: false, stderrTTY: false, stdinTTY: false, stdin: async () => '', prompt: async () => assert.fail('unexpected prompt') });
  assert.equal(code, 0); assert.equal(reads, 10); assert.equal(maximum, 4);
  const file = JSON.parse(stdout); assert.equal(file.tracks.length, 1000); assert.equal(file.playlist.trackCount, 1000);
  assert.equal(file.tracks[500].title, 'Song 500'); assert.equal(file.tracks[999].position, 1000); assert.equal(file.source.userId, 'me'); assert.doesNotMatch(stderr, /synthetic/);
  assert.ok(performance.now() - start < 15000, 'mocked export exceeded the regression budget');
});
