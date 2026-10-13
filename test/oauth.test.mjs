import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { authorize, authorizationUrl, createOAuthSecrets, parseRedirect } from '../dist/core/auth/oauth.js'

test('PKCE and state use the specified randomness and standard parameters override extras', () => {
  const secrets = createOAuthSecrets(); assert.match(secrets.verifier, /^[A-Za-z0-9_-]{43}$/); assert.match(secrets.state, /^[a-f0-9]{64}$/)
  assert.equal(secrets.challenge, createHash('sha256').update(secrets.verifier).digest('base64url')); assert.notEqual(secrets.state, createOAuthSecrets().state)
  const url = new URL(authorizationUrl('https://auth.test/authorize', 'client', ['read', 'write'], 'http://127.0.0.1/callback', secrets, { client_id: 'bad', access_type: 'offline' }))
  assert.equal(url.searchParams.get('client_id'), 'client'); assert.equal(url.searchParams.get('scope'), 'read write'); assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(parseRedirect(' http://127.0.0.1/callback?state=expected&code=ok ', 'expected'), 'ok')
  for (const [line, expected] of [['not a url', /Invalid/], ['http://a/?code=x', /State/], ['http://a/?state=expected&error=access_denied', /access_denied/], ['http://a/?state=expected&error=TOKEN%0Asecret', /authorization_failed/], ['http://a/?state=expected', /Missing/]]) assert.throws(() => parseRedirect(line, 'expected'), expected)
})
test('manual login has no listener and returns verifier plus byte-identical redirect', async () => {
  let auth
  const result = await authorize({
    endpoint: 'https://auth.test/',
    clientId: 'client',
    scopes: [],
    mode: 'manual',
    interaction: {
      showAuthorizationUrl: url => { auth = new URL(url) }, promptForRedirectUrl: async () => `http://127.0.0.1/callback?state=${auth.searchParams.get('state')}&code=manual`
    }
  })
  assert.equal(result.code, 'manual'); assert.equal(result.redirectUri, auth.searchParams.get('redirect_uri')); assert.equal(result.verifier.length, 43)
  await assert.rejects(authorize({ endpoint: 'https://auth.test/', clientId: 'c', scopes: [], mode: 'manual', interaction: { showAuthorizationUrl () {}, promptForRedirectUrl: async () => '' } }), /stdin closed/)
})
function callback (url, path, host, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(url, { path, headers: { Host: host }, method, agent: false }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) }); req.on('error', reject); req.end()
  })
}
test('loopback guard rejects unrelated traffic then accepts state-checked callback and closes', async () => {
  let redirect
  const result = await authorize({
    endpoint: 'https://auth.test/',
    clientId: 'client',
    scopes: [],
    mode: 'no-browser',
    interaction: {
      promptForRedirectUrl: async () => { throw new Error('should not prompt') },
      showAuthorizationUrl: async url => {
        const auth = new URL(url); redirect = new URL(auth.searchParams.get('redirect_uri'))
        assert.equal(await callback(redirect, '/favicon.ico', redirect.host), 400)
        assert.equal(await callback(redirect, '/callback', redirect.host), 400)
        assert.equal(await callback(redirect, '/callback?state=x&code=x', 'attacker.test'), 400)
        assert.equal(await callback(redirect, '/callback?state=x&code=x', redirect.host, 'POST'), 400)
        assert.equal(await callback(redirect, `/callback?state=${auth.searchParams.get('state')}&code=valid`, redirect.host), 200)
      }
    }
  })
  assert.equal(result.code, 'valid'); assert.equal(result.redirectUri, redirect.toString())
  await assert.rejects(callback(redirect, '/callback', redirect.host))
})
test('loopback state mismatch, OAuth failure, timeout and interaction failure clean up', async () => {
  for (const query of ['state=wrong&code=x', 'state=STATE&error=access_denied', 'state=STATE']) {
    await assert.rejects(authorize({
      endpoint: 'https://auth.test/',
      clientId: 'client',
      scopes: [],
      mode: 'loopback',
      interaction: {
        promptForRedirectUrl: async () => '',
        showAuthorizationUrl: async url => {
          const auth = new URL(url); const redirect = new URL(auth.searchParams.get('redirect_uri'))
          assert.equal(await callback(redirect, `/callback?${query.replace('STATE', auth.searchParams.get('state'))}`, redirect.host), 400)
        }
      }
    }), /State validation|access_denied|Missing/)
  }
  await assert.rejects(authorize({ endpoint: 'https://auth.test/', clientId: 'c', scopes: [], mode: 'loopback', timeoutMs: 10, interaction: { showAuthorizationUrl () {}, promptForRedirectUrl: async () => '' } }), /timeout/)
  await assert.rejects(authorize({ endpoint: 'https://auth.test/', clientId: 'c', scopes: [], mode: 'loopback', interaction: { showAuthorizationUrl () { throw new Error('interaction failed') }, promptForRedirectUrl: async () => '' } }), /interaction failed/)
})
