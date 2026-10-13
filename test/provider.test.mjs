import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FakeProvider } from '../dist/providers/fake/index.js'
import { ProviderRegistry } from '../dist/core/provider/registry.js'
import { collectPages, PlaylistResolver } from '../dist/core/provider/pagination.js'
import { isFatalProviderError, AuthRequiredError, RateLimitError, QuotaExhaustedError, ProviderError } from '../dist/core/provider/errors.js'
import { QuotaLimiter } from '../dist/core/quota/limiter.js'

function memoryStore () { const tokens = new Map(); return { loadTokens: async id => tokens.get(id) ?? null, saveTokens: async (id, value) => { tokens.set(id, value) }, deleteTokens: async id => { tokens.delete(id) } } }
const tracks = [1, 2, 3].map(id => ({ title: `Song ${id}`, artists: ['Artist'], album: 'Album', isrc: `ISRC${id}`, refs: { fake: `fake:track:${id}` } }))
function seed (id, name, owner = 'fake-user', collaborative = false) { return { summary: { id: String(id), ref: String(id), name, owner: { id: owner }, owned: owner === 'fake-user', itemsReadable: true, collaborative }, tracks: structuredClone(tracks) } }
test('fake provider covers auth, canonical refs, catalog variants and CRUD without HTTP', async () => {
  const fake = new FakeProvider(memoryStore(), { tracks, playlists: [seed(4, 'First')] })
  assert.equal((await fake.auth.status()).loggedIn, false); assert.equal((await fake.auth.login({ scopes: ['read'] })).loggedIn, true)
  assert.deepEqual(await fake.auth.logout(), { revoked: false, deletedData: ['fake tokens'] })
  assert.equal(fake.parsePlaylistRef('fake:playlist:4'), '4'); assert.equal(fake.parsePlaylistRef('name'), null)
  assert.equal(fake.parseTrackRef('2'), 'fake:track:2'); assert.equal(fake.parseTrackRef('spotify:track:2'), null)
  for (const type of ['track', 'album', 'artist', 'playlist']) assert.ok((await fake.search({ text: '', type }, { limit: 10 })).items.length)
  assert.equal((await fake.search({ text: 'Song', type: 'track' }, { limit: 1 })).next.offset, 1)
  assert.equal((await fake.getLikedTracks({ limit: 10 })).total, 3)
  assert.equal((await fake.searchTracks({ kind: 'isrc', isrc: 'ISRC2' }, { limit: 5 }))[0].ref, 'fake:track:2')
  assert.equal((await fake.searchTracks({ kind: 'metadata', title: 'Song' }, { limit: 2 })).length, 2)
  const playlist = await fake.createPlaylist({ name: 'New', public: false }); assert.equal(playlist.id, '5')
  await fake.updatePlaylist('5', { name: 'Updated', description: 'desc' }); assert.equal((await fake.getPlaylist('5')).name, 'Updated')
  const result = await fake.populatePlaylist('5', ['fake:track:1', 'fake:track:1', 'bad'], { skipExisting: false })
  assert.equal(result.added.length, 2); assert.equal(result.failed.length, 1)
  assert.equal((await fake.populatePlaylist('5', ['fake:track:1', 'fake:track:2', 'fake:track:2'], { skipExisting: true })).added.length, 2)
  const returned = await fake.getPlaylistTracks('5', { limit: 10 }); returned.items[0].title = 'changed'; assert.equal((await fake.getPlaylistTracks('5', { limit: 1 })).items[0].title, 'Song 1')
  assert.deepEqual(await fake.removePlaylist('5'), { action: 'deleted' }); await assert.rejects(fake.getPlaylist('5'), /5/)
  await assert.rejects(fake.createPlaylist({ name: 'bad', public: true, collaborative: true }), /Collaborative/)
  await assert.rejects(fake.getLikedTracks({ limit: 0 }), /page size/); await assert.rejects(fake.getLikedTracks({ limit: 1, offset: -1 }), /page position/)
  const defaults = new FakeProvider(memoryStore()); assert.equal((await defaults.getLikedTracks({ limit: 10 })).items.length, 1)
  const capped = new FakeProvider(memoryStore(), { tracks, capabilities: { maxPlaylistSize: 1, canDeletePlaylist: false, supportsCollaborative: false } })
  await assert.rejects(capped.createPlaylist({ name: 'bad', public: false, collaborative: true }), /Collaborative/)
  const cappedPlaylist = await capped.createPlaylist({ name: 'cap', public: false }); assert.equal((await capped.populatePlaylist(cappedPlaylist.ref, ['fake:track:1', 'fake:track:2'], { skipExisting: false })).failed.length, 1)
  assert.equal((await capped.removePlaylist(cappedPlaylist.ref)).action, 'unfollowed')
})
test('readability and filters follow capabilities; cursor pages remain forward-only', async () => {
  const fake = new FakeProvider(memoryStore(), { playlists: [seed(1, 'Owned'), seed(2, 'Collaborative', 'other', true), seed(3, 'Followed', 'other')], capabilities: { playlistItemsAccess: 'owned-or-collaborator', paginationModel: 'cursor-forward' } })
  assert.equal((await fake.getPlaylist('2')).itemsReadable, true); assert.equal((await fake.getPlaylist('3')).itemsReadable, false)
  await assert.rejects(fake.getPlaylistTracks('3', { limit: 1 }), /not readable/)
  assert.equal((await fake.listPlaylists({ limit: 3 }, 'owned')).items.length, 1); assert.equal((await fake.listPlaylists({ limit: 3 }, 'followed')).items.length, 2)
  const page = await fake.listPlaylists({ limit: 1 }); assert.deepEqual(page.next, { cursor: '1' })
  assert.equal((await fake.listPlaylists({ limit: 1, cursor: '1' })).items[0].name, 'Collaborative')
  const onlyOwned = new FakeProvider(memoryStore(), { playlists: [seed(1, 'other', 'other', true)], capabilities: { playlistItemsAccess: 'owned-only' } })
  assert.equal((await onlyOwned.getPlaylist('1')).itemsReadable, false)
})
test('pagination bounds concurrency, retains page order and follows empty filtered pages', async () => {
  let active = 0; let maximum = 0
  const result = await collectPages(async ({ offset = 0 }) => {
    active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 8 - offset)); active--
    return { items: [offset], total: 8, ...(offset < 7 ? { next: { offset: offset + 1 } } : {}) }
  }, 1, { offsetTotal: true, concurrency: 4 })
  assert.deepEqual(result.items, [0, 1, 2, 3, 4, 5, 6, 7]); assert.equal(maximum, 4)
  const cursor = await collectPages(async ({ cursor }) => cursor ? { items: [42] } : { items: [], next: { cursor: 'next' } }, 1)
  assert.deepEqual(cursor, { items: [42] })
  await assert.rejects(collectPages(async () => ({ items: [], next: { offset: 0 } }), 1), /repeated/)
  await assert.rejects(collectPages(async () => ({ items: [] }), 0), /positive/)
  const capped = await collectPages(async ({ offset = 0 }) => ({ items: [offset, offset + 1], total: 6, ...(offset < 4 ? { next: { offset: offset + 2 } } : {}) }), 4, { offsetTotal: true })
  assert.deepEqual(capped.items, [0, 1, 2, 3, 4, 5])
})
test('playlist resolution supports ID fallback, exact-first lookup and ambiguity', async () => {
  const fake = new FakeProvider(memoryStore(), { playlists: [seed(1, 'Road'), seed(2, 'road'), seed(3, '999'), seed(4, 'Duplicate'), seed(5, 'Duplicate', 'other')] })
  const resolver = new PlaylistResolver()
  assert.equal((await resolver.resolve(fake, '1')).id, '1'); assert.equal((await resolver.resolve(fake, '999')).id, '3')
  assert.equal((await resolver.resolve(fake, 'Road')).id, '1'); assert.equal((await resolver.resolve(fake, 'road')).id, '2')
  await assert.rejects(resolver.resolve(fake, 'ROAD'), /Ambiguous/); await assert.rejects(resolver.resolve(fake, 'Duplicate'), /owner:/)
  await assert.rejects(resolver.resolve(fake, 'missing'), /missing/); await assert.rejects(resolver.resolve(fake, 'fake:playlist:999'), /999/)
})
test('registry rejects duplicate/unknown providers, and fatal error classification is closed', () => {
  const registry = new ProviderRegistry(); registry.register({ id: 'fake', displayName: 'Fake', create: () => new FakeProvider(memoryStore()) })
  assert.equal(registry.get('fake').create().id, 'fake'); assert.equal(registry.list().length, 1)
  assert.throws(() => registry.get('spotify'), /Valid providers: fake/); assert.throws(() => registry.register(registry.get('fake')), /already/)
  for (const error of [new AuthRequiredError('no-token'), new RateLimitError(), new QuotaExhaustedError('units')]) assert.equal(isFatalProviderError(error), true)
  assert.equal(isFatalProviderError(new ProviderError('error')), false)
})
test('quota buckets debit atomically and reset at the provider calendar day', () => {
  let now = Date.parse('2026-10-13T06:59:59Z')
  const limiter = new QuotaLimiter({ kind: 'daily-buckets', buckets: [{ id: 'units', dailyLimit: 2, resetTimeZone: 'America/Los_Angeles' }, { id: 'search', dailyLimit: 1, resetTimeZone: 'America/Los_Angeles' }], costs: {} }, () => now)
  limiter.consume([{ bucket: 'units', amount: 1 }, { bucket: 'search', amount: 1 }])
  assert.throws(() => limiter.consume([{ bucket: 'units', amount: 1 }, { bucket: 'search', amount: 1 }]), /search/)
  limiter.consume([{ bucket: 'units', amount: 1 }]); assert.throws(() => limiter.consume([{ bucket: 'units', amount: 1 }]), /units/)
  now += 1000; limiter.consume([{ bucket: 'units', amount: 2 }])
  assert.throws(() => limiter.consume([{ bucket: 'missing', amount: 1 }]), /Unknown/); assert.throws(() => limiter.consume([{ bucket: 'units', amount: -1 }]), /non-negative/)
  new QuotaLimiter({ kind: 'rate-limited' }).consume([])
})
