import type { Page, PageRequest, PlaylistSummary, Provider } from './provider.js';
import { NotFoundError, ProviderError, UsageError } from './errors.js';

export async function collectPages<T>(read: (page: PageRequest) => Promise<Page<T>>, limit: number, options: { offset?: number; concurrency?: number; offsetTotal?: boolean } = {}): Promise<{ items: T[]; total?: number }> {
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('Page size must be a positive integer');
  const first = await read({ limit, offset: options.offset ?? 0 });
  const items = [...first.items];
  if (options.offsetTotal && first.total !== undefined && first.next?.offset !== undefined && first.next.offset - (options.offset ?? 0) === limit) {
    const offsets: number[] = [];
    for (let offset = first.next.offset; offset < first.total; offset += limit) offsets.push(offset);
    const pages: Page<T>[] = new Array(offsets.length);
    let index = 0;
    const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 4));
    await Promise.all(Array.from({ length: Math.min(concurrency, offsets.length) }, async () => {
      while (index < offsets.length) { const i = index++; pages[i] = await read({ limit, offset: offsets[i]! }); }
    }));
    for (const page of pages) items.push(...page.items);
  } else {
    let next = first.next;
    const seen = new Set<string>([JSON.stringify({ offset: options.offset ?? 0 })]);
    while (next) {
      const key = JSON.stringify(next);
      if (seen.has(key)) throw new ProviderError('Provider returned a repeated pagination position');
      seen.add(key);
      const page = await read({ limit, ...next });
      items.push(...page.items); next = page.next;
    }
  }
  return first.total === undefined ? { items } : { items, total: first.total };
}

/** Cache name lookups for one command execution; never cache across CLI runs. */
export class PlaylistResolver {
  private readonly lists = new Map<Provider, Promise<PlaylistSummary[]>>();
  async resolve(provider: Provider, input: string): Promise<PlaylistSummary> {
    const ref = provider.parsePlaylistRef(input);
    if (ref !== null) {
      try { return await provider.getPlaylist(ref); }
      catch (error) { if (!(error instanceof NotFoundError) || /[:/]/.test(input)) throw error; }
    }
    let list = this.lists.get(provider);
    if (!list) {
      list = collectPages(p => provider.listPlaylists(p), provider.capabilities.readPageSize.playlists).then(p => p.items);
      this.lists.set(provider, list);
    }
    const playlists = await list;
    let matches = playlists.filter(p => p.name === input);
    if (!matches.length) matches = playlists.filter(p => p.name.toLowerCase() === input.toLowerCase());
    if (matches.length > 1) throw new UsageError(`Ambiguous playlist "${input}":\n${matches.map(p => `• ${p.name} (id: ${p.id}, owner: ${p.owner.displayName ?? p.owner.id}${p.owned ? ' (owned)' : ''})`).join('\n')}`);
    if (!matches[0]) throw new NotFoundError('playlist', input);
    return matches[0];
  }
}
