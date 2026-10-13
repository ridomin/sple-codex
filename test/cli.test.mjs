import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import createDebug from 'debug'
import { configureLogging, logHttp, redact } from '../dist/cli/output/logging.js'
import { getExitCode, formatErrorMessage, writeError } from '../dist/cli/exit-codes.js'
import { browserCommand, createOAuthInteraction } from '../dist/cli/auth-interaction.js'
import { getConfigDir } from '../dist/core/config/paths.js'
import * as errors from '../dist/core/provider/errors.js'

test('error messages and exit codes implement the stable CLI contract', () => {
  const cases = [[new errors.UsageError('wrong'), 2], [new errors.AuthRequiredError('missing-scope', '', 'read'), 3], [new errors.NotFoundError('playlist', 'missing'), 4], [new errors.QuotaExhaustedError('units', '2026-10-14T00:00:00Z'), 5], [new errors.RateLimitError(1001), 5], [new errors.AccessRestrictedError('not-owned', 'restricted'), 1], [new errors.ProviderError('broken'), 1], [new Error('unknown'), 1]]
  for (const [error, code] of cases) { assert.equal(getExitCode(error), code); const lines = []; assert.equal(writeError(error, { json: true, debug: true, write: line => lines.push(line) }), code); assert.equal(JSON.parse(lines.at(-1)).error.exitCode, code) }
  assert.match(formatErrorMessage(new errors.AuthRequiredError('revoked', 'Grant expired')), /Grant expired/)
  assert.match(formatErrorMessage(new errors.AuthRequiredError('no-token')), /Run/)
  assert.match(formatErrorMessage(new errors.RateLimitError(1001)), /2s/); assert.equal(formatErrorMessage('unknown'), 'Unexpected error')
  assert.equal(writeError('unknown', { write () {} }), 1)
})
test('every debug namespace and error output redacts secrets, with namespace exclusions', () => {
  const raw = 'Bearer bearer-secret access_token=access-secret&refresh_token=refresh-secret code=code-secret code_verifier=verifier-secret client_secret=client-secret {"id_token":"id-secret","access_token":"json-secret"}'
  const lines = []
  configureLogging({ debug: true, env: { DEBUG: '-sple:http:retry' }, write: line => lines.push(line) })
  for (const namespace of ['cli', 'auth', 'export', 'resolve', 'import', 'spotify:auth', 'http:error', 'http:retry']) createDebug(`sple:${namespace}`)(raw)
  logHttp({ method: 'GET', path: '/tracks?access_token=access-secret', status: 200, durationMs: 10, retries: 1 })
  writeError(new Error(raw), { json: true, debug: true, write: line => lines.push(line) })
  assert.ok(lines.length > 5); assert.equal(lines.some(line => line.includes('sple:http:retry')), false)
  for (const secret of ['bearer-secret', 'access-secret', 'refresh-secret', 'code-secret', 'verifier-secret', 'client-secret', 'id-secret', 'json-secret']) assert.equal(lines.join('').includes(secret), false)
  assert.match(redact(raw), /REDACTED/)
  configureLogging({ verbose: true, env: {}, write: line => lines.push(line) }); assert.equal(createDebug.enabled('sple:http'), false); assert.equal(createDebug.enabled('sple:auth'), true)
  configureLogging({ env: {}, write () {} }); assert.equal(createDebug.enabled('sple:auth'), false)
})
test('browser interaction always prints the URL, tolerates opener failure, and supports WSL', async () => {
  const url = 'https://auth.test/?state=x&client_id=y'
  assert.deepEqual(browserCommand(url, 'win32', {}, ''), ['rundll32.exe', ['url.dll,FileProtocolHandler', url]])
  assert.equal(browserCommand(url, 'darwin', {}, '')[0], 'open')
  assert.equal(browserCommand(url, 'linux', { WSL_INTEROP: 'yes' }, '')[0], 'explorer.exe')
  assert.equal(browserCommand(url, 'linux', {}, 'Microsoft')[0], 'explorer.exe')
  assert.equal(browserCommand(url, 'linux', {}, '')[0], 'xdg-open')
  const lines = []; const opens = []
  const interaction = createOAuthInteraction({ write: line => lines.push(line), open: async url => { opens.push(url); throw new Error('failed') }, readLine: async () => 'redirect' })
  for (const mode of ['loopback', 'no-browser', 'manual']) await interaction.showAuthorizationUrl(url, mode)
  assert.equal(opens.length, 1); assert.equal(lines.filter(line => line.includes(url)).length, 3); assert.ok(lines.some(line => line.includes('warning')))
  assert.equal(await interaction.promptForRedirectUrl('prompt'), 'redirect')
  const successful = createOAuthInteraction({ write () {}, open: async () => {} }); await successful.showAuthorizationUrl(url, 'loopback')
})
test('CLI isolates config, exposes fake only by opt-in, and supports offline status/logout', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sple-cli-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, APPDATA: dir, XDG_CONFIG_HOME: dir, SPLE_DEFAULT_PROVIDER: 'spotify', SPLE_ENABLE_FAKE_PROVIDER: '', SPLE_SPOTIFY_CLIENT_ID: '', DEBUG: '' }
  const invoke = (args, extra = {}) => spawnSync(process.execPath, [resolve('dist/cli/main.js'), ...args], { env: { ...env, ...extra }, encoding: 'utf8', input: '', timeout: 5000 })
  let result = invoke(['--help']); assert.equal(result.status, 0); assert.doesNotMatch(result.stdout.split('Providers: ')[1].split('\n')[0], /fake/)
  result = invoke(['--version']); assert.equal(result.stdout, 'sple v0.1.0\n')
  result = invoke(['auth', 'status', '--json']); assert.deepEqual(JSON.parse(result.stdout), { providers: [{ id: 'spotify', loggedIn: false, scopes: [] }] })
  assert.equal(invoke(['auth', 'status', '--provider', 'fake']).status, 2)
  const fake = { SPLE_ENABLE_FAKE_PROVIDER: '1' }
  assert.equal(invoke(['auth', 'login', '--provider', 'fake'], fake).status, 0)
  result = invoke(['auth', 'status', '--json', '--provider', 'fake'], fake); assert.equal(JSON.parse(result.stdout).providers[0].loggedIn, true)
  result = invoke(['auth', 'status', '--quiet'], fake); assert.equal(result.stdout, 'fake\n')
  const configDir = getConfigDir(process.platform, env, dir); const path = join(configDir, 'tokens.json')
  await mkdir(configDir, { recursive: true })
  const document = JSON.parse(await readFile(path, 'utf8'))
  document.providers.spotify = { accounts: [{ accessToken: 'SECRET', userId: 'user', displayName: 'Name', scopes: ['read'], grantedAt: '2026-10-01T00:00:00Z', expiresAt: '2000-01-01T00:00:00Z', refreshTokenExpiresAt: '2000-01-02T00:00:00Z' }] }
  await writeFile(path, JSON.stringify(document), { mode: 0o600 })
  result = invoke(['auth', 'status']); assert.match(result.stdout, /Name/); assert.match(result.stderr, /refresh token has expired/); assert.doesNotMatch(result.stdout + result.stderr, /SECRET/)
  assert.equal(invoke(['auth', 'logout', '--all'], fake).status, 0); assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).providers, {})
  for (const args of [['--bad'], ['auth', 'status', '--json', '--quiet'], ['auth', 'status', '--all'], ['auth', 'logout', '--all', '--provider', 'spotify'], ['auth', 'login', '--manual', '--no-browser'], ['auth', 'login', '--json'], ['migrate'], ['unknown'], ['auth', 'status', '--provider']]) {
    result = invoke(args); assert.equal(result.status, 2, `${args}: ${result.stderr}`); assert.equal(result.stdout, '')
  }
  result = invoke(['auth', 'login', '--json']); assert.equal(JSON.parse(result.stderr.trim().split('\n').at(-1)).error.exitCode, 2)
  assert.match(invoke(['auth', 'login']).stderr, /Missing Spotify client ID/)
  assert.equal(invoke(['auth', 'status'], { SPLE_DEFAULT_PROVIDER: 'unknown' }).status, 2)
  assert.equal(invoke(['auth', 'status', '--provider', 'spotify'], { SPLE_DEFAULT_PROVIDER: 'unknown' }).status, 0)
})
