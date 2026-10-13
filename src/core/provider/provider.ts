import type { ProviderCapabilities, ProviderId } from './capabilities.js';
import type { OAuthInteraction } from '../auth/oauth.js';
export interface PageRequest { limit: number; offset?: number; cursor?: string }
export interface Page<T> { items: T[]; next?: { offset?: number; cursor?: string }; total?: number }

export interface PlaylistSummary {
  ref: string;                 // opaque provider ref accepted by getPlaylist etc. (Spotify: the 22-char playlist ID)
  id: string; name: string; description?: string;
  owner: { id: string; displayName?: string };
  owned: boolean;              // FR-PL-1
  itemsReadable: boolean;      // false when not owned and playlistItemsAccess = 'owned-only', or when the non-owned playlist is not readable (Amendment 1)
  trackCount?: number;
  public?: boolean; collaborative?: boolean; url?: string;
}

export interface CanonicalTrack {
  title: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  isrc?: string | null;        // optional; null when the source supplies none
  refs: Record<string, string>;// providerId -> track ref
  addedAt?: string;            // ISO 8601
}

export type SearchType = 'track' | 'album' | 'artist' | 'playlist';

export interface SearchItemBase { id: string; ref: string; url?: string; name: string }
export type SearchItem =                                          // FR-SEARCH-4 (Amendment 1)
  | (SearchItemBase & { type: 'track'; track: CanonicalTrack })
  | (SearchItemBase & { type: 'album'; artists: string[]; releaseDate?: string; trackCount?: number })
  | (SearchItemBase & { type: 'artist' })
  | (SearchItemBase & { type: 'playlist'; owner: { id: string; displayName?: string }; trackCount?: number });

/** Input to searchTracks (Amendment 2). The adapter turns it into its own query syntax; core never builds provider query strings. */
export type TrackQuery =
  | { kind: 'isrc'; isrc: string }                                   // only sent when isrcSearchMode !== 'none'
  | { kind: 'metadata'; title: string; artists: string[]; album?: string; durationMs?: number };

/** One searchTracks result. `ref` is a canonical track ref for this provider (§3.1). */
export interface TrackHit { ref: string; track: CanonicalTrack }

/** The single candidate type, used by the matching engine and the match report (ADR 0009). */
export interface MatchCandidate { ref: string; track: CanonicalTrack; confidence: number; strategy: 'known-ref' | 'isrc' | 'metadata' }

export interface AuthStatus { loggedIn: boolean; user?: { id: string; displayName?: string }; scopes: string[]; expiresAt?: string; refreshTokenExpiresAt?: string }

export interface ProviderAuth {
  login(opts: { mode: 'loopback' | 'no-browser' | 'manual'; scopes: string[]; interaction?: OAuthInteraction }): Promise<AuthStatus>;
  status(): Promise<AuthStatus>;
  logout(): Promise<{ revoked: boolean; deletedData: string[]; notice?: string }>; // FR-AUTH-4
}

export interface Provider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  readonly auth: ProviderAuth;

  search(q: { text: string; type: SearchType }, page: PageRequest): Promise<Page<SearchItem>>;
  /** Returns a provider ref if `input` is an ID, URI, or URL for this provider; otherwise null (caller falls back to name lookup). Pure, no I/O. */
  parsePlaylistRef(input: string): string | null;
  /** Returns the canonical track ref (§3.1) if `input` is a track ID, URI, or URL for this provider; otherwise null. Pure, no I/O (Amendment 2). */
  parseTrackRef(input: string): string | null;
  /** `filter` is applied on PlaylistSummary.owned; a filtered page may hold fewer than `limit` items and omits `total`. */
  listPlaylists(page: PageRequest, filter?: 'owned' | 'followed'): Promise<Page<PlaylistSummary>>;
  getPlaylist(ref: string): Promise<PlaylistSummary>;                                // returns metadata even when !itemsReadable
  getPlaylistTracks(ref: string, page: PageRequest): Promise<Page<CanonicalTrack>>; // throws AccessRestrictedError if !itemsReadable; drops unsupported items, `total` counts all items
  getLikedTracks(page: PageRequest): Promise<Page<CanonicalTrack>>;
  createPlaylist(input: { name: string; description?: string; public: boolean; collaborative?: boolean }): Promise<PlaylistSummary>;
  updatePlaylist?(ref: string, patch: { name?: string; description?: string; public?: boolean }): Promise<PlaylistSummary>; // FR-PL-5 (S)
  removePlaylist(ref: string): Promise<{ action: 'deleted' | 'unfollowed' }>;
  /** Catalog track search for matching (ADR 0009). Returns at most `limit` hits in the provider's relevance order. Durations are filled in when the provider has them (searchReturnsDuration=false => the adapter fetches details). */
  searchTracks(query: TrackQuery, opts: { limit: number }): Promise<TrackHit[]>;

  /** Internal: used only by import/migrate (scope note §4.3). Never exposed as a command. Adds in the given order, in batches of maxTracksPerRequest. */
  populatePlaylist(ref: string, trackRefs: string[], opts: { skipExisting: boolean }): Promise<{ added: string[]; failed: { ref: string; error: string }[] }>;
}
