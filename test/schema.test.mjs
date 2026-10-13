import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schema = JSON.parse(await readFile(new URL('../schemas/canonical-playlist.v1.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const sample = {
  schemaVersion: 1, exportedAt: '2026-10-13T00:00:00Z', generator: { name: 'sple', version: '0.1.0' },
  source: { provider: 'fake', kind: 'playlist' }, playlist: { name: 'Sample', trackCount: 1 },
  tracks: [{ position: 1, title: 'Song', artists: ['Artist'], refs: { fake: 'fake:track:1' }, durationMs: 1000, isrc: null }], unsupportedItems: [],
};
test('published v1 schema compiles in strict mode and accepts canonical/forward-provider files', () => {
  assert.equal(validate(sample), true, JSON.stringify(validate.errors));
  const liked = structuredClone(sample); liked.source = { provider: 'future-service', kind: 'liked' }; liked.playlist.name = 'Liked Songs';
  assert.equal(validate(liked), true);
  const unsupported = structuredClone(sample); unsupported.tracks = []; unsupported.unsupportedItems = [{ position: 1, kind: 'local', name: 'Local' }]; assert.equal(validate(unsupported), true);
});
test('v1 schema rejects unknown fields, malformed tracks, timestamps and liked names', () => {
  for (const alter of [v => { v.schemaVersion = 2; }, v => { v.source.provider = 'INVALID'; }, v => { v.tracks[0].refs = {}; }, v => { v.tracks[0].artists = []; }, v => { v.tracks[0].durationMs = -1; }, v => { v.exportedAt = 'bad'; }, v => { v.extra = true; }, v => { v.tracks[0].extra = true; }, v => { v.source.kind = 'liked'; }]) {
    const invalid = structuredClone(sample); alter(invalid); assert.equal(validate(invalid), false);
  }
});
