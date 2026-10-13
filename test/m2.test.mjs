import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakeProvider } from '../dist/providers/fake/index.js';
import { SpotifyProvider, spotifyScopes } from '../dist/providers/spotify/index.js';
import { TokenStore } from '../dist/core/config/token-store.js';
import { ProviderRegistry } from '../dist/core/provider/registry.js';
import { nameFilter } from '../dist/core/provider/name-filter.js';
import { AuthRequiredError, AccessRestrictedError } from '../dist/core/provider/errors.js';
import { runCli } from '../dist/cli/app.js';
const track = { title: 'Song', artists: ['Artist'], refs: { fake: 'fake:track:1' } };
const playlist = (id, name, owner = 'fake-user') => ({ summary: { id: String(id), ref: String(id), name, owner: { id: owner }, owned: owner === 'fake-user', itemsReadable: true, public: false, collaborative: false }, tracks: [track] });
async function setup(t, opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sple-m2-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new TokenStore(dir), registry = new ProviderRegistry();
  const fake = new FakeProvider(store, { tracks: [track], playlists: [playlist(1, 'Road Trip'), playlist(2, 'Chill'), playlist(3, 'Followed', 'other')], capabilities: { playlistItemsAccess: 'owned-only', readPageSize: { playlists: 1, playlistItems: 1, liked: 1 } }, ...opts });
  registry.register({ id: 'fake', displayName: 'Fake', create: () => fake });
  let stdout = '', stderr = ''; const ctx = { config: { directory: dir, defaultProvider: 'fake', enableFakeProvider: true }, store, registry, version: '0.1.0', stdout: text => { stdout += text; }, stderr: text => { stderr += text; }, stdoutTTY: false, stderrTTY: false, stdinTTY: false, noColor: true, stdin: async () => '1\n', prompt: async () => assert.fail('M2 must not prompt') };
  return { dir, fake, store, ctx, output: () => ({ stdout, stderr }), run: async args => { stdout = ''; stderr = ''; return runCli(args, ctx); } };
}
test('name filters support case-insensitive literal substrings and explicit regex without stateful flags', async t => {
  assert.equal(nameFilter(undefined)('anything'), true); assert.equal(nameFilter('ROAD')('Road Trip'), true); assert.equal(nameFilter('.*')('Road Trip'), false);
  assert.equal(nameFilter('/^road/i')('Road Trip'), true); assert.equal(nameFilter('/^road/i')('Chill'), false);
  for (const input of ['/unterminated', '/[/i', '/name/g', '/name/ii']) assert.throws(() => nameFilter(input), e => e.name === 'UsageError');
  const s = await setup(t); await s.run(['playlist', 'list', '--owned', '--filter', 'road', '--json']); assert.equal(JSON.parse(s.output().stdout).total, 1);
  await s.run(['playlist', 'list', '--filter', '/^(Road|Chill)/', '--quiet']); assert.equal(s.output().stdout, '1\n2\n');
  let calls = 0; s.fake.listPlaylists = async () => { calls++; throw new Error('must not call'); }; await assert.rejects(s.run(['playlist', 'list', '--filter', '/[/']), /regular expression/); assert.equal(calls, 0);
});
test('playlist edit validates changes, emits proposed metadata on dry run and handles stdin', async t => {
  const s = await setup(t);
  await s.run(['playlist', 'edit', 'Road Trip', '--name', 'Renamed', '--public', '--dry-run', '--json']);
  assert.equal(JSON.parse(s.output().stdout).playlist.name, 'Renamed'); assert.equal((await s.fake.getPlaylist('1')).name, 'Road Trip');
  await s.run(['playlist', 'edit', '-', '--name', 'Renamed', '--description', '', '--private', '--json']); const output = JSON.parse(s.output().stdout); assert.equal(output.dryRun, false); assert.equal(output.playlist.description, ''); assert.equal(output.playlist.public, false); assert.equal((await s.fake.getPlaylist('1')).name, 'Renamed');
  await s.run(['playlist', 'edit', '1', '--description', 'updated', '--dry-run']); assert.match(s.output().stderr, /Would edit/);
  await s.run(['playlist', 'edit', '1', '--description', 'updated', '--quiet']); assert.equal(s.output().stdout, '1\n');
  s.ctx.stdoutTTY = true; await s.run(['playlist', 'edit', '1', '--name', 'New']); assert.match(s.output().stdout, /Updated playlist/);
  for (const args of [['playlist', 'edit', '1'], ['playlist', 'edit', '1', '--name', ''], ['playlist', 'edit', '1', '--public', '--private']]) await assert.rejects(s.run(args), e => e.name === 'UsageError');
  s.fake.updatePlaylist = undefined; await assert.rejects(s.run(['playlist', 'edit', '1', '--name', 'New']), /support/);
});
test('export all includes Liked Songs, writes an atomic index and skips unreadable playlists successfully', async t => {
  const s = await setup(t), out = join(s.dir, 'all');
  assert.equal(await s.run(['export', '--all', '-o', out, '--json']), 0);
  const output = JSON.parse(s.output().stdout); assert.equal(output.files.length, 3); assert.equal(output.indexPath, join(out, 'index.json'));
  const index = JSON.parse(await readFile(output.indexPath, 'utf8')); assert.equal(index.schemaVersion, 1); assert.equal(index.entries.length, 4);
  assert.equal(index.entries.find(e => e.id === '3').reason, 'not-owned'); assert.equal(index.entries.find(e => e.kind === 'liked').status, 'exported');
  assert.match(s.output().stderr, /skipped 1 unreadable/); assert.deepEqual((await readdir(out)).sort(), ['chill-2.json', 'index.json', 'liked-songs.json', 'road-trip-1.json']);
  await assert.rejects(s.run(['export', '--all', '-o', out]), /File exists/);
  await s.run(['export', '--all', '-o', out, '--force', '--format', 'csv', '--quiet']); assert.equal(s.output().stdout.trim().split('\n').length, 3);
  for (const args of [['export', '--all'], ['export', '--all', '1', '-o', out], ['export', '--all', '--liked', '-o', out]]) await assert.rejects(s.run(args), e => e.name === 'UsageError');
  const indexOnly = join(s.dir, 'index-only'); await s.run(['export', '--all', '-o', indexOnly]);
  for (const file of await readdir(indexOnly)) if (file !== 'index.json') await rm(join(indexOnly, file));
  await assert.rejects(s.run(['export', '--all', '-o', indexOnly]), /index.json/); assert.deepEqual(await readdir(indexOnly), ['index.json']);
});
test('export all preserves index evidence on runtime access/fatal failures', async t => {
  const s = await setup(t); const original = s.fake.getPlaylistTracks.bind(s.fake);
  s.fake.getPlaylistTracks = async (ref, page) => { if (ref === '1') throw new AccessRestrictedError('not-owned', 'permission changed'); if (ref === '2') throw new AuthRequiredError('no-token'); return original(ref, page); };
  const out = join(s.dir, 'partial'); assert.equal(await s.run(['export', '--all', '-o', out, '--json']), 3);
  const output = JSON.parse(s.output().stdout), index = JSON.parse(await readFile(output.indexPath, 'utf8'));
  assert.equal(index.entries.find(e => e.id === '1').reason, 'not-owned'); assert.equal(index.entries.find(e => e.kind === 'liked').error.exitCode, 3);
  assert.equal(JSON.parse(s.output().stderr.trim().split('\n').at(-1)).error.type, 'PartialFailure');
  const empty = await setup(t, { playlists: [], capabilities: { ...s.fake.capabilities, likedSongs: { read: 'none', write: false } } });
  await empty.run(['export', '--all', '-o', join(empty.dir, 'empty'), '--json']); assert.equal(JSON.parse(await readFile(JSON.parse(empty.output().stdout).indexPath, 'utf8')).entries.length, 0);
});
test('Spotify edit uses idempotent PUT, validates ownership, and field-search text is preserved', async t => {
  const s = await setup(t); const fixtures = JSON.parse(await readFile(new URL('./fixtures/spotify.json', import.meta.url), 'utf8'));
  await s.store.saveTokens('spotify', { accessToken: 'synthetic', scopes: spotifyScopes, userId: 'me', grantedAt: '2026-10-01T00:00:00Z' });
  const calls = []; let failures = 0, owner = 'me', collaborative = false;
  const provider = new SpotifyProvider({ clientId: 'client', tokenStore: s.store, sleep: async () => {}, fetch: async (input, init) => {
    const url = new URL(input); calls.push({ url, init });
    if (init.method === 'PUT') { if (!failures++) return new Response('{}', { status: 503 }); return new Response(null, { status: 200 }); }
    if (url.pathname === '/v1/search') return new Response(JSON.stringify({ tracks: { items: [fixtures.track], next: null, total: 1 } }));
    return new Response(JSON.stringify({ ...fixtures.playlist, owner: { id: owner }, collaborative }));
  } });
  const updated = await provider.updatePlaylist(fixtures.playlist.id, { name: 'Edited', description: '', public: true }); assert.equal(updated.name, 'Edited'); assert.equal(calls.filter(c => c.init.method === 'PUT').length, 2);
  assert.deepEqual(JSON.parse(calls.find(c => c.init.method === 'PUT').init.body), { name: 'Edited', description: '', public: true });
  await assert.rejects(provider.updatePlaylist(fixtures.playlist.id, {}), /patch/); await assert.rejects(provider.updatePlaylist(fixtures.playlist.id, { name: '' }), /patch/);
  owner = 'other'; await assert.rejects(provider.updatePlaylist(fixtures.playlist.id, { name: 'Edited' }), /ownership/);
  owner = 'me'; collaborative = true; await assert.rejects(provider.updatePlaylist(fixtures.playlist.id, { public: true }), /private/);
  const query = 'artist:"Artist" album:"Album" year:2026 isrc:USAAA2600001'; await provider.search({ text: query, type: 'track' }, { limit: 10 }); assert.equal(calls.at(-1).url.searchParams.get('q'), query);
});
