import type { CanonicalTrack, PlaylistSummary, SearchItem, AuthStatus } from '../../core/provider/provider.js';
import type { ProviderId } from '../../core/provider/capabilities.js';
export interface ErrorInfo { type: string; message: string; exitCode: number }
export interface PageInfo { next?: { offset?: number; cursor?: string }; total?: number }
export interface SearchOutput extends PageInfo { items: SearchItem[] }
export interface PlaylistListOutput extends PageInfo { playlists: PlaylistSummary[] }
export interface PlaylistShowOutput { playlist: PlaylistSummary; tracks: Array<CanonicalTrack & { position: number }>; unsupportedItems: [] }
export type PlaylistCreateOutput = { dryRun: true; name: string; description?: string; public: boolean; collaborative: boolean } | { dryRun: false; id: string; ref: string; name: string; description?: string; url?: string; owner: PlaylistSummary['owner']; public: boolean; collaborative: boolean };
export interface PlaylistRemoveOutput { dryRun: boolean; action: 'unfollowed' | 'deleted'; playlist: { id: string; ref: string; name: string } }
export interface ExportOutput { files: Array<{ path: string; format: 'json' | 'csv'; source: { kind: 'playlist' | 'liked'; id?: string; name: string }; trackCount: number; unsupportedCount: number }>; skipped: Array<{ input: string; error: ErrorInfo }>; indexPath?: string }
export interface AuthStatusOutput { providers: Array<AuthStatus & { id: ProviderId }> }
export interface PlaylistEditOutput { dryRun: boolean; playlist: PlaylistSummary; changes: { name?: string; description?: string; public?: boolean } }
export interface ExportIndex {
  schemaVersion: 1; exportedAt: string; provider: ProviderId;
  entries: Array<{ input: string; name?: string; id?: string; kind: 'playlist' | 'liked'; status: 'exported' | 'skipped'; path?: string; trackCount?: number; reason?: 'not-owned' | 'error'; error?: ErrorInfo }>;
}
