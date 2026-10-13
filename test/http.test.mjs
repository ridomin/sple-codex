import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, retryAfter } from '../dist/core/http/client.js';
import { ProviderError, AuthRequiredError, QuotaExhaustedError } from '../dist/core/provider/errors.js';

const stored = { accessToken: 'old', refreshToken: 'refresh', userId: 'me', scopes: [], grantedAt: '2026-10-01T00:00:00Z' };
function setup(responses, extra = {}) {
  let token = structuredClone(stored), calls = 0, saves = 0;
  const waits = [], logs = [], sent = [];
  const client = new HttpClient({
    provider: 'spotify', baseUrl: 'https://api.test/v1/',
    tokenStore: { loadTokens: async () => token, saveTokens: async (_, value) => { token = value; saves++; } },
    fetch: async (url, init) => {
      sent.push({ url: String(url), init }); const item = responses[Math.min(calls++, responses.length - 1)];
      if (item instanceof Error) throw item;
      if (typeof item === 'function') return item(url, init);
      return new Response(item.body ?? '{}', { status: item.status, headers: item.headers });
    },
    sleep: async ms => { waits.push(ms); }, random: () => 0.5, now: () => 0,
    log: entry => logs.push(entry), ...extra,
  });
  return { client, waits, logs, sent, calls: () => calls, saves: () => saves, setToken: value => { token = value; } };
}
test('bounded transient retries honor delta/date Retry-After and jitter fallback', async () => {
  const s = setup([{ status: 500 }, { status: 429, headers: { 'Retry-After': '2' } }, { status: 503, headers: { 'Retry-After': '99999' } }, { status: 200 }]);
  assert.equal((await s.client.request('tracks?q=a-long-query-with-many-characters&uris=spotify:track:long-reference')).status, 200);
  assert.deepEqual(s.waits, [100, 2000, 120000]); assert.equal(s.calls(), 4); assert.equal(s.logs.length, 4);
  assert.equal(s.logs[3].retries, 3); assert.ok(s.logs[0].path.includes('...')); assert.equal(s.sent[0].init.headers.get('Authorization'), 'Bearer old');
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:00:03 GMT', 0), 3000); assert.equal(retryAfter('Thu, 01 Jan 1970 00:00:00 GMT', 1000), 0);
  assert.equal(retryAfter('garbage', 0), undefined); assert.equal(retryAfter('', 0), undefined); assert.equal(retryAfter('1.5', 0), 1500);
  const network = setup([new Error('private response body')]); await assert.rejects(network.client.request('tracks'), /after 3 retries/); assert.deepEqual(network.waits, [100, 200, 400]);
  const exhausted = setup([{ status: 500 }]); await assert.rejects(exhausted.client.request('tracks'), /after 3 retries/); assert.equal(exhausted.calls(), 4);
});
test('rate limits fail fast above maxWait and stop after the retry budget', async () => {
  const long = setup([{ status: 429, headers: { 'Retry-After': '121' } }]); await assert.rejects(long.client.request('tracks'), e => e.retryAfterMs === 121000); assert.equal(long.waits.length, 0);
  const repeated = setup([{ status: 429 }]); await assert.rejects(repeated.client.request('tracks'), e => e.name === 'RateLimitError' && e.retryAfterMs === 100); assert.equal(repeated.calls(), 4);
  const mapped = setup([{ status: 403 }], { mapError: async () => new QuotaExhaustedError('search') }); await assert.rejects(mapped.client.request('tracks'), /search/); assert.equal(mapped.calls(), 1);
});
test('uncertain writes are not replayed, while a rejected 429 write can retry', async () => {
  for (const response of [{ status: 500 }, new Error('lost response')]) {
    const s = setup([response]); await assert.rejects(s.client.request('playlists', { method: 'POST', body: '{}' }), /not retried/); assert.equal(s.calls(), 1);
  }
  const safe = setup([{ status: 500 }, { status: 200 }]); await safe.client.request('operation', { method: 'POST', retrySafe: true, body: '{}' }); assert.equal(safe.calls(), 2);
  const limited = setup([{ status: 429 }, { status: 201 }]); await limited.client.request('playlists', { method: 'POST' }); assert.equal(limited.calls(), 2);
  const controller = new AbortController(); controller.abort();
  const aborted = setup([new Error('aborted')]); await assert.rejects(aborted.client.request('tracks', { signal: controller.signal }), /aborted/); assert.equal(aborted.calls(), 1);
});
test('401 refresh is single-flight, saved before retry, and has a separate budget', async () => {
  let refreshes = 0;
  const s = setup([(_, init) => new Response('{}', { status: init.headers.get('Authorization') === 'Bearer old' ? 401 : 200 })], {
    refresh: async token => { refreshes++; await new Promise(r => setTimeout(r, 5)); return { ...token, accessToken: 'new' }; },
  });
  await Promise.all([s.client.request('one'), s.client.request('two'), s.client.request('three')]);
  assert.equal(refreshes, 1); assert.equal(s.saves(), 1); assert.equal(s.calls(), 6);
  const twice = setup([{ status: 401 }], { refresh: async token => ({ ...token, accessToken: 'new' }) });
  await assert.rejects(twice.client.request('tracks'), e => e.name === 'AuthRequiredError'); assert.equal(twice.calls(), 2);
  const noRefresh = setup([{ status: 401 }]); await assert.rejects(noRefresh.client.request('tracks'), e => e.reason === 'token-expired');
  let cancelled = false;
  const denied = setup([() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 401 })]);
  await assert.rejects(denied.client.request('tracks'), e => e.reason === 'token-expired'); assert.equal(cancelled, true);
  const rotated = setup([() => { rotated.setToken({ ...stored, accessToken: 'rotated' }); return new Response('{}', { status: 401 }); }, { status: 200 }]);
  await rotated.client.request('tracks'); assert.equal(rotated.sent[1].init.headers.get('Authorization'), 'Bearer rotated');
});
test('proactive refresh, absent tokens, explicit authorization and provider-origin guard', async () => {
  let refreshes = 0;
  const s = setup([{ status: 200 }], { now: () => 1000, refresh: async token => { refreshes++; return { ...token, accessToken: 'new', expiresAt: '2026-10-13T01:00:00Z' }; } });
  s.setToken({ ...stored, expiresAt: '1970-01-01T00:00:10Z' });
  await Promise.all([s.client.request('one'), s.client.request('two')]); assert.equal(refreshes, 1);
  const late = setup([{ status: 200 }], { refresh: async token => ({ ...token, accessToken: 'new' }) });
  late.setToken({ ...stored, expiresAt: '1970-01-01T00:00:10Z' }); await late.client.request('first');
  late.setToken({ ...stored, expiresAt: '1970-01-01T00:00:10Z' }); await late.client.request('second'); assert.equal(late.saves(), 1);
  const missing = setup([{ status: 200 }]); missing.setToken(null);
  await assert.rejects(missing.client.request('tracks'), e => e.reason === 'no-token');
  await missing.client.request('tracks', { authenticated: false });
  await missing.client.request('tracks', { headers: { Authorization: 'Basic custom' } }); assert.equal(missing.sent[1].init.headers.get('Authorization'), 'Basic custom');
  await assert.rejects(missing.client.request('https://other.test/track'), /origin/);
  const failure = setup([{ status: 200 }], { refresh: async () => { throw new AuthRequiredError('revoked', 'Grant revoked'); } });
  failure.setToken({ ...stored, expiresAt: '1970-01-01T00:00:00Z' }); await assert.rejects(failure.client.request('tracks'), /Grant revoked/);
  const noRefreshToken = setup([{ status: 401 }], { refresh: async token => token }); noRefreshToken.setToken({ ...stored, refreshToken: undefined }); await assert.rejects(noRefreshToken.client.request('tracks'), e => e.reason === 'token-expired');
});
test('error mapping and JSON validation keep provider bodies out of errors', async () => {
  for (const [status, name] of [[403, 'AccessRestrictedError'], [404, 'NotFoundError'], [400, 'ProviderError']]) {
    const s = setup([{ status, body: 'SECRET' }]); await assert.rejects(s.client.request('tracks'), e => e.name === name && !e.message.includes('SECRET'));
  }
  const invalid = setup([{ status: 200, body: 'SECRET' }]); await assert.rejects(invalid.client.json('tracks', value => value), /Invalid JSON/);
  const s = setup([{ status: 200, body: '{"id":42}' }]);
  assert.deepEqual(await s.client.json('tracks', value => value), { id: 42 });
  await assert.rejects(s.client.json('tracks', value => { if (typeof value.id !== 'string') throw new ProviderError('Invalid id'); return value; }), /Invalid id/);
  let debits = 0; const limited = setup([{ status: 503 }, { status: 200 }], { beforeRequest: async () => { debits++; } }); await limited.client.request('tracks'); assert.equal(debits, 2);
});
