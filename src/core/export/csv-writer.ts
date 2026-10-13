import type { CanonicalPlaylistFile } from './format.js';
import { assertPlaylistFile } from './format.js';

export function csvCell(value: unknown): string { const text = value === undefined || value === null ? '' : String(value); return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
export function writeCSV(file: CanonicalPlaylistFile): string {
  assertPlaylistFile(file);
  const records = [['position', 'title', 'artists', 'album', 'duration_ms', 'added_at', 'isrc', 'ref'], ...[...file.tracks].sort((a, b) => a.position - b.position).map(t => [t.position, t.title, t.artists.join('; '), t.album, t.durationMs, t.addedAt, t.isrc, t.refs[file.source.provider]])];
  return records.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
