import type { CanonicalPlaylistFile } from './format.js';
import { assertPlaylistFile } from './format.js';

function pick<T extends object>(value: T, keys: string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
export function writeJSON(file: CanonicalPlaylistFile): string {
  assertPlaylistFile(file);
  return `${JSON.stringify({ schemaVersion: 1, exportedAt: file.exportedAt, generator: pick(file.generator, ['name', 'version']), source: pick(file.source, ['provider', 'kind', 'userId']),
    playlist: { ...pick(file.playlist, ['ref', 'id', 'name', 'description', 'public', 'collaborative', 'url', 'trackCount']), ...(file.playlist.owner ? { owner: pick(file.playlist.owner, ['id', 'displayName']) } : {}) },
    tracks: [...file.tracks].sort((a, b) => a.position - b.position).map(t => ({ ...pick(t, ['position', 'title', 'artists', 'album', 'durationMs', 'isrc', 'addedAt']), refs: { ...t.refs } })),
    unsupportedItems: [...file.unsupportedItems].sort((a, b) => a.position - b.position).map(t => pick(t, ['position', 'kind', 'name', 'ref'])),
  }, null, 2)}\n`;
}
