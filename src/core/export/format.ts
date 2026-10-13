import type { ProviderId } from '../provider/capabilities.js';
import type { CanonicalTrack, PlaylistSummary } from '../provider/provider.js';
import { ProviderError } from '../provider/errors.js';
export interface CanonicalPlaylistFile {
  schemaVersion: 1
  exportedAt: string                                   // ISO 8601 UTC
  generator: { name: 'sple'; version: string }
  source: { provider: ProviderId; kind: 'playlist' | 'liked'; userId?: string }
  playlist: {
    ref?: string; id?: string; name: string; description?: string
    owner?: { id: string; displayName?: string }
    public?: boolean; collaborative?: boolean; url?: string
    trackCount: number
  }
  tracks: Array<CanonicalTrack & { position: number }>
  unsupportedItems: Array<{
    position: number
    kind: 'local' | 'episode' | 'unavailable'
    name?: string; ref?: string
  }>
}

export class ExportFormatError extends ProviderError {}
export function assertPlaylistFile(file: CanonicalPlaylistFile): void {
  const fail = (field: string): never => { throw new ExportFormatError(`Invalid canonical playlist: ${field}`); };
  const date = (value: string): boolean => /^\d{4}-\d\d-\d\dT/.test(value) && value.endsWith('Z') && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
  if (file.schemaVersion !== 1) fail('schemaVersion');
  if (!date(file.exportedAt)) fail('exportedAt');
  if (file.generator.name !== 'sple' || !file.generator.version) fail('generator');
  if (!/^[a-z][a-z0-9-]*$/.test(file.source.provider) || !['playlist', 'liked'].includes(file.source.kind)) fail('source');
  if (file.source.kind === 'liked' && file.playlist.name !== 'Liked Songs') fail('playlist.name');
  if (!Number.isInteger(file.playlist.trackCount) || file.playlist.trackCount !== file.tracks.length + file.unsupportedItems.length) fail('trackCount');
  const positions = new Set<number>();
  for (const item of [...file.tracks, ...file.unsupportedItems]) {
    if (!Number.isInteger(item.position) || item.position < 1 || item.position > file.playlist.trackCount || positions.has(item.position)) fail('positions');
    positions.add(item.position);
  }
  for (const track of file.tracks) {
    if (typeof track.title !== 'string' || !track.artists.length || track.artists.some(a => typeof a !== 'string')) fail('track title/artists');
    if (!Object.keys(track.refs).length || Object.entries(track.refs).some(([provider, ref]) => !/^[a-z][a-z0-9-]*$/.test(provider) || typeof ref !== 'string' || !ref)) fail('track refs');
    if (track.durationMs !== undefined && (!Number.isInteger(track.durationMs) || track.durationMs < 0)) fail('durationMs');
    if (track.isrc !== undefined && track.isrc !== null && typeof track.isrc !== 'string') fail('isrc');
    if (track.addedAt !== undefined && !date(track.addedAt)) fail('addedAt');
  }
  if (file.unsupportedItems.some(i => !['local', 'episode', 'unavailable'].includes(i.kind))) fail('unsupportedItems.kind');
}
export function createPlaylistFile(input: { provider: ProviderId; version: string; tracks: CanonicalTrack[]; playlist?: PlaylistSummary; userId?: string; now?: string }): CanonicalPlaylistFile {
  const playlist = input.playlist;
  return {
    schemaVersion: 1, exportedAt: input.now ?? new Date().toISOString(), generator: { name: 'sple', version: input.version },
    source: { provider: input.provider, kind: playlist ? 'playlist' : 'liked', ...(input.userId ? { userId: input.userId } : {}) },
    playlist: { ...(playlist ? { ref: playlist.ref, id: playlist.id, name: playlist.name, ...(playlist.description !== undefined ? { description: playlist.description } : {}), owner: playlist.owner, ...(playlist.public !== undefined ? { public: playlist.public } : {}), ...(playlist.collaborative !== undefined ? { collaborative: playlist.collaborative } : {}), ...(playlist.url ? { url: playlist.url } : {}) } : { name: 'Liked Songs' }), trackCount: input.tracks.length },
    tracks: input.tracks.map((track, i) => ({ ...track, position: i + 1 })), unsupportedItems: [],
  };
}
