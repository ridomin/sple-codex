import type { ProviderCapabilities } from '../../core/provider/capabilities.js'
import type { AuthStatus, CanonicalTrack, Page, PageRequest, PlaylistSummary, Provider, SearchItem, SearchType, TrackHit, TrackQuery } from '../../core/provider/provider.js'
import { AccessRestrictedError, NotFoundError, UsageError } from '../../core/provider/errors.js'
import { tokenStatus } from '../../core/auth/status.js'
import type { TokenStore } from '../../core/config/token-store.js'

export const fakeCapabilities: ProviderCapabilities = {
  official: true,
  requiresRiskAcknowledgement: false,
  userSuppliedClientId: false,
  requiresClientSecret: false,
  supportsRefreshToken: true,
  supportsRevocation: false,
  paginationModel: 'offset',
  maxSearchPageSize: 50,
  readPageSize: { playlists: 50, playlistItems: 100, liked: 50 },
  playlistItemsAccess: 'all',
  likedSongs: { read: 'exact', write: false },
  isrcSearchMode: 'none',
  searchReturnsDuration: true,
  musicAwareSearch: true,
  canDeletePlaylist: true,
  supportsCollaborative: true,
  maxTracksPerRequest: 100,
  quotaModel: { kind: 'rate-limited' }
}
export interface FakePlaylist { summary: PlaylistSummary, tracks: CanonicalTrack[] }
export interface FakeOptions { capabilities?: Partial<ProviderCapabilities>, playlists?: FakePlaylist[], tracks?: CanonicalTrack[], liked?: CanonicalTrack[], userId?: string }
export class FakeProvider implements Provider {
  readonly id = 'fake'
  readonly displayName = 'Fake'
  readonly capabilities: ProviderCapabilities
  readonly auth: Provider['auth']
  private readonly playlists = new Map<string, FakePlaylist>()
  private readonly catalog: CanonicalTrack[]
  private readonly liked: CanonicalTrack[]
  private nextId = 1
  constructor (store: TokenStore, private readonly options: FakeOptions = {}) {
    this.capabilities = structuredClone({ ...fakeCapabilities, ...options.capabilities })
    this.catalog = structuredClone(options.tracks ?? [{ title: 'Example Song', artists: ['Example Artist'], durationMs: 180_000, refs: { fake: 'fake:track:1' } }])
    this.liked = structuredClone(options.liked ?? this.catalog)
    for (const playlist of options.playlists ?? []) { this.playlists.set(playlist.summary.ref, structuredClone(playlist)); this.nextId = Math.max(this.nextId, Number(playlist.summary.id) + 1) }
    this.auth = {
      login: async ({ scopes }): Promise<AuthStatus> => {
        await store.saveTokens('fake', { accessToken: 'fake-access', refreshToken: 'fake-refresh', scopes, userId: this.userId, displayName: 'Fake User', grantedAt: new Date().toISOString() })
        return await this.auth.status()
      },
      status: async () => tokenStatus(await store.loadTokens('fake')),
      logout: async () => { await store.deleteTokens('fake'); return { revoked: false, deletedData: ['fake tokens'] } }
    }
  }

  private get userId (): string { return this.options.userId ?? 'fake-user' }
  parsePlaylistRef (input: string): string | null { const match = /^(?:fake:playlist:)?([0-9]+)$/.exec(input); return match?.[1] ?? null }
  parseTrackRef (input: string): string | null { const match = /^(?:fake:track:)?([0-9]+)$/.exec(input); return (match != null) ? `fake:track:${String(match[1])}` : null }
  private page<T>(items: T[], request: PageRequest, filtered = false): Page<T> {
    if (!Number.isInteger(request.limit) || request.limit < 1) throw new UsageError('Invalid fake page size')
    const offset = this.capabilities.paginationModel === 'cursor-forward' ? Number(request.cursor ?? 0) : request.offset ?? 0
    if (!Number.isInteger(offset) || offset < 0) throw new UsageError('Invalid fake page position')
    const result: Page<T> = { items: structuredClone(items.slice(offset, offset + request.limit)) }
    if (!filtered) result.total = items.length
    if (offset + request.limit < items.length) result.next = this.capabilities.paginationModel === 'offset' ? { offset: offset + request.limit } : { cursor: String(offset + request.limit) }
    return result
  }

  async search (query: { text: string, type: SearchType }, page: PageRequest): Promise<Page<SearchItem>> {
    const text = query.text.toLowerCase()
    let items: SearchItem[]
    if (query.type === 'playlist') items = [...this.playlists.values()].map(({ summary: p }) => ({ id: p.id, ref: p.ref, name: p.name, type: 'playlist', owner: p.owner, ...(p.trackCount !== undefined ? { trackCount: p.trackCount } : {}) }))
    else if (query.type === 'artist') items = [...new Set(this.catalog.flatMap(t => t.artists))].map((name, i) => ({ id: String(i + 1), ref: String(i + 1), name, type: 'artist' }))
    else if (query.type === 'album') items = this.catalog.filter(t => t.album).map((t, i) => ({ id: String(i + 1), ref: String(i + 1), name: (t.album as string), artists: t.artists, type: 'album' }))
    else items = this.catalog.map(t => ({ id: (t.refs.fake as string).split(':').at(-1) as string, ref: (t.refs.fake as string), name: t.title, type: 'track', track: t }))
    return this.page(items.filter(i => `${i.name} ${i.type === 'track' ? i.track.artists.join(' ') : ''}`.toLowerCase().includes(text)), page)
  }

  async listPlaylists (page: PageRequest, filter?: 'owned' | 'followed'): Promise<Page<PlaylistSummary>> {
    const result = this.page([...this.playlists.values()].map(p => this.summary(p)), page, filter !== undefined)
    if (filter !== undefined) result.items = result.items.filter(p => p.owned === (filter === 'owned'))
    return result
  }

  private summary (playlist: FakePlaylist): PlaylistSummary {
    const p = playlist.summary
    const owned = p.owner.id === this.userId
    const itemsReadable = this.capabilities.playlistItemsAccess === 'all' || owned || (this.capabilities.playlistItemsAccess === 'owned-or-collaborator' && p.collaborative === true)
    return structuredClone({ ...p, owned, itemsReadable, trackCount: playlist.tracks.length })
  }

  private find (ref: string): FakePlaylist { const playlist = this.playlists.get(ref); if (playlist == null) throw new NotFoundError('playlist', ref); return playlist }
  async getPlaylist (ref: string): Promise<PlaylistSummary> { return this.summary(this.find(ref)) }
  async getPlaylistTracks (ref: string, page: PageRequest): Promise<Page<CanonicalTrack>> {
    const playlist = this.find(ref)
    if (!this.summary(playlist).itemsReadable) throw new AccessRestrictedError('not-owned', 'Playlist items are not readable')
    return this.page(playlist.tracks, page)
  }

  async getLikedTracks (page: PageRequest): Promise<Page<CanonicalTrack>> { return this.page(this.liked, page) }
  async createPlaylist (input: { name: string, description?: string, public: boolean, collaborative?: boolean }): Promise<PlaylistSummary> {
    if ((input.collaborative ?? false) && (input.public || !this.capabilities.supportsCollaborative)) throw new UsageError('Collaborative playlists must be private and supported')
    const id = String(this.nextId++)
    const summary: PlaylistSummary = { ...input, id, ref: id, owner: { id: this.userId }, owned: true, itemsReadable: true, collaborative: input.collaborative ?? false, trackCount: 0 }
    this.playlists.set(id, { summary, tracks: [] }); return structuredClone(summary)
  }

  async updatePlaylist (ref: string, patch: { name?: string, description?: string, public?: boolean }): Promise<PlaylistSummary> { const playlist = this.find(ref); Object.assign(playlist.summary, patch); return this.summary(playlist) }
  async removePlaylist (ref: string): Promise<{ action: 'deleted' | 'unfollowed' }> { this.find(ref); this.playlists.delete(ref); return { action: this.capabilities.canDeletePlaylist ? 'deleted' : 'unfollowed' } }
  async searchTracks (query: TrackQuery, options: { limit: number }): Promise<TrackHit[]> {
    const hits = this.catalog.filter(t => query.kind === 'isrc' ? t.isrc === query.isrc : t.title.toLowerCase().includes(query.title.toLowerCase()))
    return structuredClone(hits.slice(0, options.limit).map(track => ({ ref: (track.refs.fake as string), track })))
  }

  async populatePlaylist (ref: string, trackRefs: string[], options: { skipExisting: boolean }): Promise<{ added: string[], failed: Array<{ ref: string, error: string }> }> {
    const playlist = this.find(ref); const added: string[] = []; const failed: Array<{ ref: string, error: string }> = []
    const existing = new Set(playlist.tracks.map(t => t.refs.fake))
    for (const ref of trackRefs) {
      if (options.skipExisting && existing.has(ref)) continue
      const track = this.catalog.find(t => t.refs.fake === ref)
      if (track == null) { failed.push({ ref, error: 'Track not found' }); continue }
      if (this.capabilities.maxPlaylistSize !== undefined && playlist.tracks.length >= this.capabilities.maxPlaylistSize) { failed.push({ ref, error: 'Playlist size limit reached' }); continue }
      playlist.tracks.push(structuredClone(track)); added.push(ref)
      // Keep duplicates requested by the source; skipExisting refers to the initial target.
    }
    return { added, failed }
  }
}
