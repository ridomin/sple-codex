import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { runCli, parseCommand, slug } from '../dist/cli/app.js'
import { ProviderRegistry } from '../dist/core/provider/registry.js'
import { FakeProvider } from '../dist/providers/fake/index.js'
import { TokenStore } from '../dist/core/config/token-store.js'
import { AccessRestrictedError, AuthRequiredError, RateLimitError } from '../dist/core/provider/errors.js'
import { createPlaylistFile, assertPlaylistFile } from '../dist/core/export/format.js'
import { writeJSON } from '../dist/core/export/json-writer.js'
import { writeCSV } from '../dist/core/export/csv-writer.js'
import { render, table, duration, displayDate } from '../dist/cli/output/render.js'
import { Progress } from '../dist/cli/output/progress.js'

const schema = JSON.parse(await readFile(new URL('../schemas/canonical-playlist.v1.schema.json', import.meta.url), 'utf8'))
const ajv = new Ajv2020({ strict: true }); addFormats(ajv); const validate = ajv.compile(schema)
const track = { title: 'Song, "quoted"\nline', artists: ['Artist', 'Second'], album: 'Album', durationMs: 180000, refs: { fake: 'fake:track:1' }, isrc: null, addedAt: '2026-10-01T00:00:00Z' }
function seed (id, name, owner = 'fake-user') { return { summary: { id: String(id), ref: String(id), name, owner: { id: owner }, owned: owner === 'fake-user', itemsReadable: true, public: false, collaborative: false }, tracks: [structuredClone(track)] } }
async function context (t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'sple-m1-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new TokenStore(dir); const registry = new ProviderRegistry()
  const fake = new FakeProvider(store, { tracks: [track], playlists: [seed(1, 'Road'), seed(2, 'road'), seed(3, 'Other', 'other')], ...options })
  registry.register({ id: 'fake', displayName: 'Fake', create: () => fake })
  let stdout = ''; let stderr = ''; let prompts = []; let stdin = ''; let answer = 'yes'
  const ctx = {
    config: { directory: dir, defaultProvider: 'fake', enableFakeProvider: true },
    store,
    registry,
    version: '0.1.0',
    stdout: text => { stdout += text },
    stderr: text => { stderr += text },
    stdinTTY: true,
    stdoutTTY: false,
    stderrTTY: false,
    noColor: true,
    stdin: async () => stdin,
    prompt: async text => { prompts.push(text); return answer }
  }
  return { dir, ctx, fake, setInput: value => { stdin = value; ctx.stdinTTY = false }, setAnswer: value => { answer = value }, output: () => ({ stdout, stderr, prompts }), run: async args => { stdout = ''; stderr = ''; prompts = []; return runCli(args, ctx) } }
}
test('M1 CLI pagination, output modes, grammar and provider capabilities', async t => {
  const s = await context(t, { tracks: Array.from({ length: 27 }, (_, i) => ({ ...track, title: `Song ${i}`, refs: { fake: `fake:track:${i}` } })), capabilities: { maxSearchPageSize: 10 } })
  await s.run(['search', 'Song', '--limit', '25', '--json']); assert.equal(JSON.parse(s.output().stdout).items.length, 25); assert.deepEqual(JSON.parse(s.output().stdout).next, { offset: 25 })
  await s.run(['search', 'Song', '--all', '--max-results', '11', '--quiet']); assert.equal(s.output().stdout.trim().split('\n').length, 11)
  await s.run(['search', 'missing']); assert.equal(s.output().stdout, ''); assert.match(s.output().stderr, /No results/)
  for (const type of ['album', 'artist', 'playlist']) { await s.run(['search', '', '--type', type, '--json']).catch(() => {}); await s.run(['search', type === 'playlist' ? 'Road' : type === 'album' ? 'Album' : 'Artist', '--type', type]); assert.ok(s.output().stdout) }
  await s.run(['playlist', 'list', '--json']); assert.equal(JSON.parse(s.output().stdout).total, 3)
  await s.run(['playlist', 'list', '--followed', '--quiet']); assert.equal(s.output().stdout, '3\n')
  await s.run(['playlist', 'list', '--owned']); assert.equal(s.output().stdout.trim().split('\n').length, 2)
  s.ctx.stdoutTTY = true; await s.run(['playlist', 'list']); assert.match(s.output().stdout, /owned/); assert.match(s.output().stdout, /yes/)
  for (const args of [['search'], ['search', 'q', '--type', 'bad'], ['search', 'q', '--limit', '0'], ['search', 'q', '--limit', '1.2'], ['search', 'q', '--all', '--limit', '1'], ['search', 'q', '--max-results', '2'], ['search', 'q', '--limit', '2', '--offset', '999'], ['--limit', '1', 'search', 'q'], ['playlist', 'list', '--owned', '--followed'], ['playlist', 'show'], ['export', '--all'], ['playlist', 'list', '--dry-run'], ['import', 'file']]) await assert.rejects(s.run(args), e => e.name === 'UsageError', args.join(' '))
  await s.run(['search', '--help']); assert.match(s.output().stdout, /Usage: sple search/)
  await s.run(['--help', 'search']); assert.match(s.output().stdout, /Commands:/)
  assert.throws(() => parseCommand(['--unknown']), /Unknown option/)
  const cursor = await context(t, { capabilities: { paginationModel: 'cursor-forward', maxSearchPageSize: 1 } })
  await assert.rejects(cursor.run(['search', 'q', '--offset', '1']), /cursor/)
})
test('show keeps positions and metadata, supports stdin, and explains access restrictions', async t => {
  const s = await context(t)
  await s.run(['playlist', 'show', 'Road', '--json']); const shown = JSON.parse(s.output().stdout); assert.equal(shown.tracks[0].position, 1); assert.deepEqual(shown.unsupportedItems, [])
  await s.run(['playlist', 'show', '1', '--quiet']); assert.equal(s.output().stdout, 'fake:track:1\n')
  s.setInput(' # comment\r\n1\r\n'); await s.run(['playlist', 'show', '-', '--json']); assert.equal(JSON.parse(s.output().stdout).playlist.id, '1')
  s.setInput('1\n2'); await assert.rejects(s.run(['playlist', 'show', '-']), /Usage/)
  s.setInput(''); await assert.rejects(s.run(['playlist', 'show', '-']), /No playlist/)
  s.ctx.stdinTTY = true; await assert.rejects(s.run(['playlist', 'show', '-']), /piped/)
  const restricted = await context(t, { capabilities: { playlistItemsAccess: 'owned-only' } }); await assert.rejects(restricted.run(['playlist', 'show', '3']), /Workaround/)
  const collaborator = await context(t, { capabilities: { playlistItemsAccess: 'owned-or-collaborator' }, playlists: [{ ...seed(3, 'Shared', 'other'), summary: { ...seed(3, 'Shared', 'other').summary, collaborative: true } }] })
  await collaborator.run(['playlist', 'show', '3']); assert.match(collaborator.output().stderr, /collaborator access/)
  const unsupported = await context(t); unsupported.fake.getPlaylistTracks = async () => ({ items: [], total: 2 })
  await unsupported.run(['playlist', 'show', '1']); assert.match(unsupported.output().stderr, /not supported/); assert.match(unsupported.output().stderr, /has no tracks/)
  unsupported.fake.getPlaylistTracks = async () => { throw new AccessRestrictedError('not-owned', 'denied') }; await assert.rejects(unsupported.run(['playlist', 'show', '1']), /Workaround/)
})
test('create/remove dry runs never write or prompt; destructive confirmation is enforced', async t => {
  const s = await context(t)
  await s.run(['playlist', 'create', 'New', '--dry-run', '--json']); assert.deepEqual(JSON.parse(s.output().stdout), { dryRun: true, name: 'New', public: false, collaborative: false })
  await s.run(['playlist', 'create', 'New', '--dry-run']); assert.match(s.output().stderr, /Would create/)
  await s.run(['playlist', 'create', 'New', '--dry-run', '--quiet']); assert.equal(s.output().stdout, '')
  await s.run(['playlist', 'create', 'New', '--collaborative', '--description', 'desc', '--json']); const created = JSON.parse(s.output().stdout); assert.equal(created.collaborative, true); assert.equal(created.public, false)
  for (const args of [['playlist', 'create', 'bad', '--public', '--private'], ['playlist', 'create', 'bad', '--public', '--collaborative']]) await assert.rejects(s.run(args), /visibility/)
  const incapable = await context(t, { capabilities: { supportsCollaborative: false } }); await assert.rejects(incapable.run(['playlist', 'create', 'bad', '--collaborative']), /support/)
  s.setAnswer('no'); assert.equal(await s.run(['playlist', 'remove', created.id]), 1); assert.equal(s.output().prompts.length, 1); assert.ok(await s.fake.getPlaylist(created.id))
  await s.run(['playlist', 'remove', created.id, '--dry-run', '--json']); assert.equal(JSON.parse(s.output().stdout).dryRun, true); assert.equal(s.output().prompts.length, 0)
  s.ctx.stdinTTY = false; await assert.rejects(s.run(['playlist', 'remove', created.id]), /--yes/)
  await s.run(['playlist', 'remove', created.id, '--yes', '--quiet']); assert.equal(s.output().stdout, created.id + '\n'); await assert.rejects(s.fake.getPlaylist(created.id))
  const unfollow = await context(t, { capabilities: { canDeletePlaylist: false } }); await unfollow.run(['playlist', 'remove', '1', '--dry-run']); assert.match(unfollow.output().stderr, /unfollows/)
  s.ctx.stdoutTTY = true; await s.run(['playlist', 'create', 'Public', '--public']); assert.match(s.output().stdout, /Created public playlist/)
})
test('export canonical/CSV stdout, file naming, preflight and overwrite behavior', async t => {
  const s = await context(t)
  await s.run(['export', '1']); const file = JSON.parse(s.output().stdout); assert.equal(validate(file), true, JSON.stringify(validate.errors)); assert.equal(file.tracks[0].isrc, null)
  await s.run(['export', '--liked', '--format', 'csv']); assert.match(s.output().stdout, /"Song, ""quoted""\nline"/); assert.ok(s.output().stdout.endsWith('\r\n'))
  const dir = join(s.dir, 'out'); await s.run(['export', '1', '2', '-o', dir, '--json']); const files = JSON.parse(s.output().stdout).files; assert.equal(files.length, 2); assert.equal(files[0].path, join(dir, 'road-1.json'))
  await assert.rejects(s.run(['export', '1', '2', '-o', dir]), /File exists/)
  assert.equal(JSON.parse(await readFile(files[0].path, 'utf8')).playlist.name, 'Road')
  await s.run(['export', '1', '-o', files[0].path, '--force', '--quiet']); assert.equal(s.output().stdout, files[0].path + '\n')
  await assert.rejects(s.run(['export', '1', '-o', join(s.dir, 'missing-parent', 'file.json')]), e => e.name === 'UsageError')
  const locked = join(s.dir, 'locked.json'); await writeFile(locked, 'keep')
  await assert.rejects(s.run(['export', '1', '2', '-o', locked]), /directory/); assert.equal(await readFile(locked, 'utf8'), 'keep')
  for (const args of [['export'], ['export', '1', '2'], ['export', '1', '--json'], ['export', '1', '--format', 'bad'], ['export', '-', '1']]) await assert.rejects(s.run(args), e => e.name === 'UsageError')
  await s.run(['export', '1', '1', '-o', join(s.dir, 'dedup'), '--json']); assert.equal(JSON.parse(s.output().stdout).files.length, 1); assert.match(s.output().stderr, /duplicate/)
  s.setInput('1\n2'); await s.run(['export', '-', '-o', join(s.dir, 'stdin'), '--quiet']); assert.equal(s.output().stdout.trim().split('\n').length, 2)
  assert.equal(slug('Beyoncé & friends'), 'beyonce-friends'); assert.equal(slug('!!!'), 'playlist')
})
test('batch export reports failures with priority, keeps successful files and stops fatal errors', async t => {
  const s = await context(t, { capabilities: { playlistItemsAccess: 'owned-only' } })
  const result = await s.run(['export', '1', '3', 'missing', '-o', join(s.dir, 'partial'), '--json']); assert.equal(result, 4)
  const output = JSON.parse(s.output().stdout); assert.equal(output.files.length, 1); assert.equal(output.skipped.length, 2); assert.equal(JSON.parse(s.output().stderr.trim().split('\n').at(-1)).error.type, 'PartialFailure')
  await assert.rejects(s.run(['export', 'ROAD', '1', '-o', join(s.dir, 'ambiguous')]), /Ambiguous/)
  s.fake.getPlaylistTracks = async ref => { if (ref === '1') throw new AuthRequiredError('no-token'); throw new Error('must not process later items') }
  assert.equal(await s.run(['export', '1', '2', '-o', join(s.dir, 'fatal'), '--json']), 3); assert.equal(JSON.parse(s.output().stdout).skipped.length, 2)
  s.fake.getPlaylist = async () => { throw new RateLimitError(999000) }; await assert.rejects(s.run(['export', '1', '-o', join(s.dir, 'nothing')]), e => e.name === 'RateLimitError')
})
test('canonical writers reject bad invariants and strip extraneous runtime properties', () => {
  const file = createPlaylistFile({ provider: 'fake', version: 'v', tracks: [track], userId: 'u', now: '2026-10-13T00:00:00Z' })
  file.tracks[0].secret = 'SECRET'; file.generator.secret = 'SECRET'
  const json = writeJSON(file); assert.equal(validate(JSON.parse(json)), true); assert.doesNotMatch(json, /SECRET/); assert.match(writeCSV(file), /position,title,artists/)
  for (const alter of [f => { f.schemaVersion = 2 }, f => { f.exportedAt = 'bad' }, f => { f.generator.version = '' }, f => { f.source.provider = 'INVALID' }, f => { f.playlist.name = 'wrong' }, f => { f.playlist.trackCount = 2 }, f => { f.tracks[0].position = 0 }, f => { f.tracks[0].artists = [] }, f => { f.tracks[0].refs = {} }, f => { f.tracks[0].durationMs = -1 }, f => { f.tracks[0].isrc = 1 }, f => { f.tracks[0].addedAt = 'bad' }]) { const invalid = structuredClone(file); alter(invalid); assert.throws(() => assertPlaylistFile(invalid), /Invalid canonical/) }
  const future = structuredClone(file); future.tracks = []; future.unsupportedItems = [{ position: 1, kind: 'episode' }]; assert.equal(validate(JSON.parse(writeJSON(future))), true); future.unsupportedItems[0].kind = 'bad'; assert.throws(() => writeJSON(future), /kind/)
})
test('TTY/TSV renderers preserve IDs, clean controls, handle durations and throttle progress', () => {
  assert.equal(duration(undefined), ''); assert.equal(duration(3600000), '1:00:00'); assert.equal(duration(61000), '1:01')
  assert.match(displayDate('2026-10-01T00:00:00Z', true), /^2026-\d\d-\d\d$/); assert.equal(displayDate(undefined, false), '')
  const formatted = table(['name', 'id'], [['long name here', 'ABCDEFGHIJ']], { tty: true, width: 16, noColor: true }); assert.match(formatted, /ABCDEFGHIJ/); assert.match(formatted, /…/)
  assert.equal(table(['name'], [['tab\tnewline\n']], { tty: false }), 'tab newline \n')
  // eslint-disable-next-line no-control-regex -- verify the ANSI escape sequence in colored output
  assert.match(table(['name'], [['value']], { tty: true }), /\u001b\[1m/)
  assert.equal(render({}, [], [], [], { json: true }), '{}\n'); assert.equal(render({}, [], [], [], { quiet: true }), '')
  assert.equal(render({}, [], [], [], { tty: true }), ''); assert.equal(render({}, [], [], [], { tty: true }, 'Sentence'), 'Sentence\n')
  const lines = []; let now = 0; const progress = new Progress(true, s => lines.push(s), () => now); progress.update('Read', 1, 2); progress.update('Read', 2, 2); assert.equal(lines.length, 1); now += 100; progress.update('Read', 2); progress.clear(); progress.clear(); assert.equal(lines.length, 3); new Progress(false, () => assert.fail()).update('Read', 1)
})
