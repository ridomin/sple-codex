export type ProviderId = 'spotify' | 'youtube-music' | 'fake';

export type ProviderOperation =
  | 'search' | 'searchTracks' | 'getTrackDetails'
  | 'listPlaylists' | 'getPlaylistItems'
  | 'createPlaylist' | 'updatePlaylist' | 'removePlaylist' | 'populatePlaylist'
  | 'readLiked';

export interface QuotaBucket {
  id: string;                  // e.g. 'units', 'search'
  dailyLimit: number;          // default; user-overridable in config
  resetTimeZone: string;       // IANA, e.g. 'America/Los_Angeles'
}

export interface QuotaCost {
  bucket: string;              // QuotaBucket.id
  amount: number;
  per: 'call' | 'page' | 'item';
  pageSize?: number;           // for per: 'page'
}

export type QuotaModel =
  | { kind: 'rate-limited' }                                        // 429 + Retry-After only
  | { kind: 'daily-buckets'; buckets: QuotaBucket[];
      costs: Partial<Record<ProviderOperation, QuotaCost[]>> }      // YouTube Data API
  | { kind: 'undocumented'; minDelayMs: number; maxBatch: number }; // reserved for NFR-7 opt-in providers; unused today

export interface ProviderCapabilities {
  // identity & policy (NFR-7)
  official: boolean;                               // false => opt-in rules apply
  requiresRiskAcknowledgement: boolean;

  // auth (FR-AUTH)
  userSuppliedClientId: boolean;                   // FR-AUTH-2
  requiresClientSecret: boolean;                   // Google Desktop client: true (FR-AUTH-1)
  supportsRefreshToken: boolean;
  supportsRevocation: boolean;                     // FR-AUTH-4

  // reading
  paginationModel: 'offset' | 'cursor-forward';    // drives --offset (FR-SEARCH-2)
  maxSearchPageSize: number;
  readPageSize: { playlists: number; playlistItems: number; liked: number }; // page size for list/items/liked reads (Amendment 2)
  playlistItemsAccess: 'all' | 'owned-only' | 'owned-or-collaborator';       // FR-PL-2, FR-EXP-5
  likedSongs: { read: 'exact' | 'approximate' | 'none'; write: false; readCap?: number };

  // matching (FR-MIG-2)
  isrcSearchMode: 'lookup' | 'filter' | 'none';    // replaces supportsIsrcSearch
  searchReturnsDuration: boolean;                  // false => searchTracks fetches details (getTrackDetails) to fill durationMs
  musicAwareSearch: boolean;

  // writing
  canDeletePlaylist: boolean;                      // false => remove = unfollow (FR-PL-4)
  supportsCollaborative: boolean;
  maxTracksPerRequest: number;                     // populatePlaylist batch size; writes only, never a read page size
  maxPlaylistSize?: number;

  // limits (PRV-4, FR-MIG-5)
  quotaModel: QuotaModel;
}
