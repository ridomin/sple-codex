import { readFile, stat, mkdir } from 'node:fs/promises';
import { dirname, resolve, join, sep } from 'node:path';
import { parseArgs } from 'node:util';
import type { Config } from '../core/config/config.js';
import type { TokenStore } from '../core/config/token-store.js';
import { tokenStatus } from '../core/auth/status.js';
import type { ProviderRegistry } from '../core/provider/registry.js';
import type { CanonicalTrack, PlaylistSummary, Provider, SearchItem, SearchType } from '../core/provider/provider.js';
import { AccessRestrictedError, ProviderError, UsageError, isFatalProviderError } from '../core/provider/errors.js';
import { collectPages, PlaylistResolver } from '../core/provider/pagination.js';
import { nameFilter } from '../core/provider/name-filter.js';
import { writeAtomic } from '../core/config/atomic-file.js';
import { createPlaylistFile } from '../core/export/format.js';
import { writeJSON } from '../core/export/json-writer.js';
import { writeCSV } from '../core/export/csv-writer.js';
import { getExitCode, formatErrorMessage } from './exit-codes.js';
import { duration, displayDate, render, outputMode } from './output/render.js';
import type { OutputOptions } from './output/render.js';
import type { SearchOutput, PlaylistCreateOutput, PlaylistRemoveOutput, PlaylistShowOutput, PlaylistListOutput, ExportOutput, AuthStatusOutput, ErrorInfo, PlaylistEditOutput, ExportIndex } from './output/types.js';
import { redact, configureLogging } from './output/logging.js';
import { Progress } from './output/progress.js';
import { createOAuthInteraction } from './auth-interaction.js';
import type { OAuthInteraction } from '../core/auth/oauth.js';

export interface CliContext {
  config: Config; registry: ProviderRegistry; store: TokenStore; version: string;
  stdout: (text: string) => void; stderr: (text: string) => void;
  stdoutTTY: boolean; stdinTTY: boolean; stderrTTY: boolean; width?: number; noColor?: boolean;
  stdin: () => Promise<string>; prompt: (text: string) => Promise<string>;
  interaction?: OAuthInteraction;
}
const globalFlags = ['provider', 'json', 'quiet', 'verbose', 'debug', 'yes', 'help', 'version'];
const definitions = {
  provider: { type: 'string' }, json: { type: 'boolean' }, quiet: { type: 'boolean' }, verbose: { type: 'boolean' }, debug: { type: 'boolean' }, yes: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }, all: { type: 'boolean' }, 'no-browser': { type: 'boolean' }, manual: { type: 'boolean' },
  type: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' }, 'max-results': { type: 'string' },
  owned: { type: 'boolean' }, followed: { type: 'boolean' }, description: { type: 'string' }, public: { type: 'boolean' }, private: { type: 'boolean' }, collaborative: { type: 'boolean' },
  'dry-run': { type: 'boolean' }, liked: { type: 'boolean' }, output: { type: 'string', short: 'o' }, format: { type: 'string' }, force: { type: 'boolean' },
  filter: { type: 'string' }, name: { type: 'string' },
} as const;
export function parseCommand(args: string[]) {
  try { return parseArgs({ args, strict: true, allowPositionals: true, tokens: true, options: definitions }); }
  catch (error) { throw new UsageError(error instanceof Error ? error.message : 'Invalid arguments'); }
}
function integer(value: string | undefined, fallback: number, name: string, min = 0, max = 1000): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new UsageError(`${name} must be an integer from ${min} to ${max}`);
  return Number(value);
}
export function slug(name: string): string { return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '') || 'playlist'; }
function errorInfo(error: unknown): ErrorInfo { return { type: error instanceof Error ? error.name : 'Error', message: redact(formatErrorMessage(error)), exitCode: getExitCode(error) }; }
function partialCode(skipped: ExportOutput['skipped']): number { return [3, 5, 4, 1].find(code => skipped.some(item => item.error.exitCode === code)) ?? (skipped.length ? 1 : 0); }

export async function runCli(args: string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args), { values: flags, positionals: positions, tokens } = parsed;
  const options: OutputOptions = { json: flags.json ?? false, quiet: flags.quiet ?? false, tty: ctx.stdoutTTY, width: ctx.width ?? 80, noColor: ctx.noColor ?? false };
  outputMode(options);
  const progress = new Progress(ctx.stderrTTY && !flags.json && !flags.quiet, ctx.stderr);
  configureLogging({ verbose: flags.verbose ?? false, debug: flags.debug ?? false, write: text => { progress.clear(); ctx.stderr(text); } });
  const say = (text: string): void => { progress.clear(); ctx.stderr(`${redact(text)}\n`); };
  const first = tokens.find(t => t.kind === 'positional');
  const help = tokens.find(t => t.kind === 'option' && t.name === 'help');
  const rootHelp = flags.help && (!first || (help && help.index < first.index));
  const root = `sple — music playlist CLI\n\nUsage: sple <command> [args] [flags]\nProviders: ${ctx.registry.list().map(p => p.id).join(', ')}\n\nCommands: auth login|status|logout, search, playlist list|show|create|edit|remove, export\nGlobal flags: --provider ID, --json, --quiet, --verbose, --debug, --yes, --help/-h, --version/-v\n`;
  if (flags.version) { ctx.stdout(`sple v${ctx.version}\n`); return 0; }
  if (!positions.length || rootHelp) { ctx.stdout(root); return 0; }
  const noun = positions[0]!, verb = positions[1];
  const command = ['auth', 'playlist'].includes(noun) ? `${noun} ${verb ?? ''}` : noun;
  const grammar: Record<string, { flags: string[]; usage: string }> = {
    'auth login': { flags: ['no-browser', 'manual'], usage: 'auth login [--no-browser | --manual]' },
    'auth status': { flags: [], usage: 'auth status [--provider ID] [--json | --quiet]' },
    'auth logout': { flags: ['all'], usage: 'auth logout [--provider ID | --all]' },
    search: { flags: ['type', 'limit', 'offset', 'all', 'max-results'], usage: 'search <query…> [--type track|album|artist|playlist] [--limit N] [--offset N | --all [--max-results N]]' },
    'playlist list': { flags: ['owned', 'followed', 'filter'], usage: 'playlist list [--owned | --followed] [--filter SUBSTRING|/REGEX/FLAGS]' },
    'playlist show': { flags: [], usage: 'playlist show <playlist | ->' },
    'playlist create': { flags: ['description', 'public', 'private', 'collaborative', 'dry-run'], usage: 'playlist create <name> [--description TEXT] [--public | --private] [--collaborative] [--dry-run]' },
    'playlist remove': { flags: ['dry-run'], usage: 'playlist remove <playlist | -> [--yes] [--dry-run]' },
    'playlist edit': { flags: ['name', 'description', 'public', 'private', 'dry-run'], usage: 'playlist edit <playlist | -> [--name TEXT] [--description TEXT] [--public | --private] [--dry-run]' },
    export: { flags: ['liked', 'output', 'format', 'force', 'all'], usage: 'export <playlist… | - | --all> [--liked] [-o FILE|DIR] [--format json|csv] [--force]' },
  };
  if (flags.help && ['auth', 'playlist'].includes(noun) && !verb) { ctx.stdout(root); return 0; }
  if (noun === 'migrate' || noun === 'import') throw new UsageError(`Command '${noun}' is available in a later release`);
  const spec = grammar[command]; if (!spec) throw new UsageError('Unknown command. Run "sple --help"');
  if (flags.help) { ctx.stdout(`Usage: sple ${spec.usage}\n\n${root.split('Global flags:')[1] ? `Global flags:${root.split('Global flags:')[1]}` : ''}`); return 0; }
  for (const token of tokens) if (token.kind === 'option' && (!globalFlags.includes(token.name) && (!spec.flags.includes(token.name) || (first && token.index < first.index)))) throw new UsageError(`Invalid option --${token.name} for ${command}`);
  let inputs = positions.slice(['auth', 'playlist'].includes(noun) ? 2 : 1);
  const exact = (n: number): void => { if (inputs.length !== n || inputs.some(i => !i.trim())) throw new UsageError(`Usage: sple ${spec.usage}`); };
  const registration = ctx.registry.get(flags.provider ?? ctx.config.defaultProvider);
  let provider: Provider | undefined;
  const getProvider = (): Provider => provider ??= registration.create();
  const print = (value: unknown, columns: string[], rows: unknown[][], quiet: string[], sentence?: string): void => ctx.stdout(render(value, columns, rows, quiet, options, sentence));
  const stdinRefs = async (): Promise<void> => {
    if (!inputs.includes('-')) return;
    if (inputs.length !== 1 || ctx.stdinTTY) throw new UsageError('Stdin - must appear once, alone, with piped input');
    inputs = (await ctx.stdin()).split(/\r?\n/).map(s => s.trim()).filter(s => !!s && !s.startsWith('#'));
    if (!inputs.length) throw new UsageError('No playlist refs on stdin');
  };
  const resolver = new PlaylistResolver();
  const read = async (playlist?: PlaylistSummary): Promise<{ tracks: CanonicalTrack[]; unsupported: number }> => {
    const p = getProvider(), name = playlist?.name ?? 'Liked Songs';
    const restriction = (): AccessRestrictedError => new AccessRestrictedError('not-owned', `cannot read the tracks of "${name}" (owned by ${playlist?.owner.displayName ?? playlist?.owner.id}). ${p.displayName} only returns the tracks of playlists you own${p.capabilities.playlistItemsAccess === 'owned-or-collaborator' ? ' or collaborate on' : ''}. Workaround: in the ${p.displayName} app, copy its tracks into a playlist you own, then use that playlist.`);
    if (playlist && !playlist.itemsReadable) throw restriction();
    if (playlist && !playlist.owned && p.capabilities.playlistItemsAccess !== 'all') say(`sple: note: "${name}" is owned by ${playlist.owner.displayName ?? playlist.owner.id}; readable via collaborator access`);
    if (!playlist && p.capabilities.likedSongs.read === 'none') throw new UsageError(`${p.displayName} does not support Liked Songs export`);
    if (!playlist && p.capabilities.likedSongs.read === 'approximate') say(`sple: warning: ${p.displayName} Liked Songs export is approximate`);
    let received = 0;
    try {
      const pages = await collectPages(async page => {
        const result = playlist ? await p.getPlaylistTracks(playlist.ref, page) : await p.getLikedTracks(page);
        received += result.items.length; progress.update(`Reading "${name}"`, received, result.total); return result;
      }, playlist ? p.capabilities.readPageSize.playlistItems : p.capabilities.readPageSize.liked, { offsetTotal: p.capabilities.paginationModel === 'offset' });
      return { tracks: pages.items, unsupported: Math.max(0, (pages.total ?? pages.items.length) - pages.items.length) };
    } catch (error) { if (playlist && error instanceof AccessRestrictedError && error.reason === 'not-owned') throw restriction(); throw error; }
    finally { progress.clear(); }
  };
  try {
    if (noun === 'auth') {
      exact(0);
      if ((flags.json && verb !== 'status') || (flags.all && flags.provider) || (flags.manual && flags['no-browser'])) throw new UsageError('Invalid flags for this auth command');
      if (verb === 'status') {
        const entries = flags.provider ? [registration] : ctx.registry.list();
        const providers = await Promise.all(entries.map(async p => ({ id: p.id, ...tokenStatus(await ctx.store.loadTokens(p.id)) })));
        const result: AuthStatusOutput = { providers };
        if (flags.json) ctx.stdout(`${JSON.stringify(result, null, 2)}\n`);
        else if (flags.quiet) { for (const p of providers) if (p.loggedIn) ctx.stdout(`${p.id}\n`); }
        else for (const p of providers) {
          ctx.stdout(`${ctx.registry.get(p.id).displayName} (${p.id}): ${p.loggedIn ? 'logged in' : 'not logged in'}\n`);
          if (p.loggedIn) ctx.stdout(`  User: ${p.user?.displayName ? `${p.user.displayName} ` : ''}(${p.user?.id})\n  Scopes: ${p.scopes.join(' ') || '(none)'}\n${p.expiresAt ? `  Token expires: ${p.expiresAt}${Date.parse(p.expiresAt) <= Date.now() ? ' (expired)' : ''}\n` : ''}${p.refreshTokenExpiresAt ? `  Refresh token expires: ${p.refreshTokenExpiresAt}${Date.parse(p.refreshTokenExpiresAt) <= Date.now() ? ' (expired)' : ''}\n` : ''}`);
        }
        for (const p of providers) {
          const name = ctx.registry.get(p.id).displayName;
          if (p.refreshTokenExpiresAt && Date.parse(p.refreshTokenExpiresAt) <= Date.now()) say(`Warning: ${name} refresh token has expired; run "sple auth login --provider ${p.id}"`);
          else if (p.expiresAt && Date.parse(p.expiresAt) <= Date.now()) say(`Warning: ${name} access token has expired; it will be refreshed on next use`);
          else if (p.expiresAt && Date.parse(p.expiresAt) < Date.now() + 300_000) say(`Warning: ${name} access token expires in less than 5 minutes`);
        }
      } else if (verb === 'logout') {
        let exit = 0;
        for (const p of flags.all ? ctx.registry.list() : [registration]) {
          try { const result = await p.create().auth.logout(); if (!flags.quiet) ctx.stdout(`${result.revoked ? 'Revoked access with' : 'Logged out from'} ${p.displayName}\nDeleted: ${result.deletedData.join(', ')}\n`); if (result.notice) say(result.notice); }
          catch (error) { say(`sple: ${formatErrorMessage(error)}`); exit ||= getExitCode(error); }
        }
        return exit;
      } else {
        const interaction = ctx.interaction ?? createOAuthInteraction({ write: text => { progress.clear(); ctx.stderr(text); }, readLine: ctx.prompt });
        const result = await getProvider().auth.login({ mode: flags.manual ? 'manual' : flags['no-browser'] ? 'no-browser' : 'loopback', scopes: [], interaction }).catch(error => { say(`Login failed: ${formatErrorMessage(error)}`); throw error; });
        if (!flags.quiet) ctx.stdout(`Logged in to ${registration.displayName}\nUser: ${result.user?.displayName ?? result.user?.id ?? ''}\nScopes: ${result.scopes.join(', ')}\n${result.expiresAt ? `Token expires: ${result.expiresAt}\n` : ''}`);
      }
    } else if (noun === 'search') {
      const text = inputs.join(' ').trim(); if (!text) throw new UsageError('Search query must not be empty');
      const type = flags.type ?? 'track'; if (!['track', 'album', 'artist', 'playlist'].includes(type)) throw new UsageError('Invalid search type');
      if ((flags.all && (flags.limit !== undefined || flags.offset !== undefined)) || (!flags.all && flags['max-results'] !== undefined)) throw new UsageError('Invalid pagination flags');
      const limit = flags.all ? integer(flags['max-results'], 100, '--max-results', 1) : integer(flags.limit, 10, '--limit', 1);
      const offset = integer(flags.offset, 0, '--offset'); if (offset + limit > 1000) throw new UsageError('--offset + --limit must be ≤1000');
      const p = getProvider(); if (offset && p.capabilities.paginationModel !== 'offset') throw new UsageError('--offset is unavailable on cursor providers');
      const items: SearchItem[] = []; let pageRequest = { offset } as { offset?: number; cursor?: string }, next: typeof pageRequest | undefined, total: number | undefined;
      const seen = new Set<string>();
      while (items.length < limit) {
        const key = JSON.stringify(pageRequest); if (seen.has(key)) throw new ProviderError('Repeated search page'); seen.add(key);
        const result = await p.search({ text, type: type as SearchType }, { limit: Math.min(p.capabilities.maxSearchPageSize, limit - items.length), ...pageRequest });
        items.push(...result.items); total = result.total; next = result.next;
        if (!next) break; pageRequest = next;
      }
      const result: SearchOutput = { items, ...(total !== undefined ? { total } : {}), ...(next?.offset !== undefined && next.offset < 1000 ? { next } : {}) };
      const columns = type === 'track' ? ['title', 'artists', 'album', 'duration', 'id'] : type === 'album' ? ['name', 'artists', 'released', 'tracks', 'id'] : type === 'artist' ? ['name', 'id'] : ['name', 'owner', 'tracks', 'id'];
      print(result, columns, items.map(i => i.type === 'track' ? [i.track.title, i.track.artists.join(', '), i.track.album, duration(i.track.durationMs), i.id] : i.type === 'album' ? [i.name, i.artists.join(', '), i.releaseDate, i.trackCount, i.id] : i.type === 'artist' ? [i.name, i.id] : [i.name, i.owner.displayName ?? i.owner.id, i.trackCount, i.id]), items.map(i => i.id));
      if (!items.length) say(`No results for "${text}" in ${p.displayName}`);
    } else if (command === 'playlist list') {
      exact(0); if (flags.owned && flags.followed) throw new UsageError('--owned and --followed cannot be combined');
      const matches = nameFilter(flags.filter);
      const p = getProvider(); let received = 0;
      const result = await collectPages(async page => { const result = await p.listPlaylists(page, flags.owned ? 'owned' : flags.followed ? 'followed' : undefined); received += result.items.length; progress.update('Listing playlists', received, result.total); return result; }, p.capabilities.readPageSize.playlists, { offsetTotal: p.capabilities.paginationModel === 'offset' });
      progress.clear(); const playlists = result.items.filter(p => matches(p.name)); const output: PlaylistListOutput = { playlists, total: playlists.length };
      print(output, ['name', 'id', 'tracks', 'owner', 'owned', 'public', 'collaborative'], playlists.map(p => [p.name, p.id, p.trackCount, p.owner.displayName ?? p.owner.id, p.owned, p.public, p.collaborative]), playlists.map(p => p.id));
      if (!playlists.length) say('No playlists.');
    } else if (command === 'playlist create') {
      exact(1); if ((flags.public && flags.private) || (flags.collaborative && flags.public)) throw new UsageError('Invalid playlist visibility flags');
      const p = getProvider(); if (flags.collaborative && !p.capabilities.supportsCollaborative) throw new UsageError(`${p.displayName} does not support collaborative playlists`);
      const input = { name: inputs[0]!, public: flags.public ?? false, collaborative: flags.collaborative ?? false, ...(flags.description !== undefined ? { description: flags.description } : {}) };
      const created = flags['dry-run'] ? undefined : await p.createPlaylist(input);
      const result: PlaylistCreateOutput = created ? { ...input, dryRun: false, id: created.id, ref: created.ref, owner: created.owner, ...(created.url ? { url: created.url } : {}) } : { ...input, dryRun: true };
      const visibility = input.collaborative ? 'collaborative' : input.public ? 'public' : 'private';
      const sentence = created ? `Created ${visibility} playlist "${input.name}" (${created.id})${created.url ? ` ${created.url}` : ''}` : `[dry-run] Would create ${visibility} playlist "${input.name}" in ${p.displayName}`;
      print(result, ['id', 'name', 'url'], [[created?.id, input.name, created?.url]], created ? [created.id] : [], sentence); if (flags['dry-run'] && !ctx.stdoutTTY && !flags.json && !flags.quiet) say(sentence);
    } else if (command === 'playlist edit') {
      exact(1); if (flags.public && flags.private) throw new UsageError('--public and --private cannot be combined');
      const changes = { ...(flags.name !== undefined ? { name: flags.name } : {}), ...(flags.description !== undefined ? { description: flags.description } : {}), ...(flags.public || flags.private ? { public: !!flags.public } : {}) };
      if (!Object.keys(changes).length || (changes.name !== undefined && !changes.name.trim())) throw new UsageError('playlist edit requires a change and a non-empty name');
      await stdinRefs(); exact(1); const p = getProvider(); if (!p.updatePlaylist) throw new UsageError(`${p.displayName} does not support playlist edits`);
      const current = await resolver.resolve(p, inputs[0]!);
      if (current.collaborative && changes.public) throw new UsageError('Collaborative playlists must remain private');
      const playlist = flags['dry-run'] ? { ...current, ...changes } : await p.updatePlaylist(current.ref, changes);
      const result: PlaylistEditOutput = { dryRun: flags['dry-run'] ?? false, playlist, changes };
      const sentence = flags['dry-run'] ? `[dry-run] Would edit playlist "${current.name}" (${current.id}) in ${p.displayName}` : `Updated playlist "${playlist.name}" (${playlist.id})`;
      print(result, ['id', 'name', 'description', 'public', 'url'], [[playlist.id, playlist.name, playlist.description, playlist.public, playlist.url]], [playlist.id], sentence);
      if (flags['dry-run'] && !ctx.stdoutTTY && !flags.json && !flags.quiet) say(sentence);
    } else if (command === 'playlist show' || command === 'playlist remove') {
      exact(1); if (verb === 'remove' && !flags.yes && !flags['dry-run'] && !ctx.stdinTTY) throw new UsageError('playlist remove needs --yes when stdin is not a terminal');
      await stdinRefs(); exact(1); const p = getProvider(), playlist = await resolver.resolve(p, inputs[0]!);
      if (verb === 'show') {
        const result = await read(playlist); const output: PlaylistShowOutput = { playlist, tracks: result.tracks.map((t, i) => ({ ...t, position: i + 1 })), unsupportedItems: [] };
        print(output, ['#', 'title', 'artists', 'album', 'duration', 'added at', 'id'], output.tracks.map(t => [t.position, t.title, t.artists.join(', '), t.album, duration(t.durationMs), displayDate(t.addedAt, ctx.stdoutTTY), t.refs[p.id]]), result.tracks.map(t => t.refs[p.id]!).filter(Boolean));
        if (result.unsupported) say(`sple: warning: ${result.unsupported} of ${result.unsupported + result.tracks.length} items in "${playlist.name}" are not supported (local files, podcast episodes, or unavailable tracks) and are not shown`);
        if (!result.tracks.length) say(`Playlist "${playlist.name}" has no tracks.`);
      } else {
        const deleting = p.capabilities.canDeletePlaylist;
        say(deleting ? `This permanently deletes the playlist from ${p.displayName}.` : `${p.displayName} cannot delete playlists; this unfollows it (removes it from your library). Owned playlists can be restored from your ${p.displayName} account page.`);
        if (!flags.yes && !flags['dry-run'] && !/^(y|yes)$/i.test((await ctx.prompt(`${deleting ? 'Delete' : 'Unfollow'} playlist "${playlist.name}" (${playlist.id})? (y/n): `)).trim())) { say('Aborted; nothing was changed.'); return 1; }
        const action = flags['dry-run'] ? deleting ? 'deleted' : 'unfollowed' : (await p.removePlaylist(playlist.ref)).action;
        const result: PlaylistRemoveOutput = { dryRun: flags['dry-run'] ?? false, action, playlist: { id: playlist.id, ref: playlist.ref, name: playlist.name } };
        const sentence = flags['dry-run'] ? `[dry-run] Would ${deleting ? 'delete' : 'unfollow'} playlist "${playlist.name}" (${playlist.id}) in ${p.displayName}` : `${action === 'deleted' ? 'Deleted' : 'Unfollowed'} playlist "${playlist.name}" (${playlist.id})`;
        print(result, ['action', 'id', 'name'], [[action, playlist.id, playlist.name]], [playlist.id], sentence); if (flags['dry-run'] && !ctx.stdoutTTY && !flags.json && !flags.quiet) say(sentence);
      }
    } else if (noun === 'export') {
      if (inputs.some(i => !i.trim()) || (!inputs.length && !flags.liked && !flags.all) || (flags.all && (inputs.length || flags.liked || !flags.output)) || (flags.format !== undefined && !['json', 'csv'].includes(flags.format)) || (flags.json && !flags.output)) throw new UsageError(`Usage: sple ${spec.usage}`);
      await stdinRefs(); const format = (flags.format ?? 'json') as 'json' | 'csv';
      let sourceCount = inputs.length + Number(!!flags.liked); if (sourceCount > 1 && !flags.output) throw new UsageError('Several sources require -o <directory>');
      const p = getProvider(), output: ExportOutput = { files: [], skipped: [] }, sources: { input: string; playlist?: PlaylistSummary; path?: string }[] = [], seen = new Set<string>();
      const index: ExportIndex = { schemaVersion: 1, exportedAt: new Date().toISOString(), provider: p.id, entries: [] };
      let indexPath: string | undefined;
      if (flags.all) {
        inputs = (await collectPages(page => p.listPlaylists(page), p.capabilities.readPageSize.playlists, { offsetTotal: p.capabilities.paginationModel === 'offset' })).items.map(playlist => playlist.ref);
        sourceCount = inputs.length + Number(p.capabilities.likedSongs.read !== 'none');
      }
      for (const input of inputs) {
        try { const playlist = await resolver.resolve(p, input); if (seen.has(playlist.ref)) { say(`sple: warning: duplicate playlist "${playlist.name}" exported once`); continue; } seen.add(playlist.ref); sources.push({ input, playlist }); }
        catch (error) { if (error instanceof UsageError || isFatalProviderError(error)) throw error; output.skipped.push({ input, error: errorInfo(error) }); index.entries.push({ input, kind: 'playlist', status: 'skipped', reason: 'error', error: errorInfo(error) }); }
      }
      if (flags.liked || (flags.all && p.capabilities.likedSongs.read !== 'none')) sources.push({ input: '--liked' });
      if (flags.output) {
        const destination = resolve(flags.output); let info;
        try { info = await stat(destination); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const directory = flags.all || sourceCount > 1 || flags.output.endsWith(sep) || info?.isDirectory();
        if (directory && info && !info.isDirectory()) throw new UsageError('Export directory is an existing file');
        if (!directory) {
          try { if (!(await stat(dirname(destination))).isDirectory()) throw new UsageError('Export parent directory must exist'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UsageError('Export parent directory must exist'); throw error; }
        }
        for (const source of sources) {
          if (flags.all && source.playlist && !source.playlist.itemsReadable) continue;
          source.path = directory ? join(destination, source.playlist ? `${slug(source.playlist.name)}-${source.playlist.id}.${format}` : `liked-songs.${format}`) : destination;
          try { await stat(source.path); if (!flags.force) throw new UsageError(`File exists: ${source.path}. Use --force to overwrite`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        if (flags.all) {
          indexPath = join(destination, 'index.json');
          try { await stat(indexPath); if (!flags.force) throw new UsageError(`File exists: ${indexPath}. Use --force to overwrite`); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        if (directory) await mkdir(destination, { recursive: true });
      }
      let stopped: ErrorInfo | undefined;
      const userId = (await p.auth.status()).user?.id;
      for (const source of sources) {
        const identity = { input: source.input, kind: source.playlist ? 'playlist' as const : 'liked' as const, ...(source.playlist ? { id: source.playlist.id, name: source.playlist.name } : { name: 'Liked Songs' }) };
        if (flags.all && source.playlist && !source.playlist.itemsReadable) { index.entries.push({ ...identity, status: 'skipped', reason: 'not-owned' }); say(`sple: warning: skipped "${source.playlist.name}" (not readable: not-owned)`); continue; }
        if (stopped) { output.skipped.push({ input: source.input, error: stopped }); index.entries.push({ ...identity, status: 'skipped', reason: 'error', error: stopped }); continue; }
        try {
          const result = await read(source.playlist);
          const file = createPlaylistFile({ provider: p.id, version: ctx.version, tracks: result.tracks, ...(source.playlist ? { playlist: source.playlist } : {}), ...(userId ? { userId } : {}) });
          const contents = format === 'json' ? writeJSON(file) : writeCSV(file);
          if (source.path) { await writeAtomic(source.path, contents, { overwrite: !!flags.force }); output.files.push({ path: source.path, format, source: { kind: source.playlist ? 'playlist' : 'liked', name: file.playlist.name, ...(source.playlist ? { id: source.playlist.id } : {}) }, trackCount: result.tracks.length, unsupportedCount: result.unsupported }); }
          else ctx.stdout(contents);
          index.entries.push({ ...identity, status: 'exported', ...(source.path ? { path: source.path } : {}), trackCount: result.tracks.length });
          if (result.unsupported) say(`sple: warning: ${result.unsupported} of ${result.unsupported + result.tracks.length} items in "${file.playlist.name}" are not supported (local files, podcast episodes, or unavailable tracks) and were not exported`);
        } catch (error) {
          if (error instanceof UsageError) throw error;
          if (flags.all && error instanceof AccessRestrictedError && error.reason === 'not-owned') { index.entries.push({ ...identity, status: 'skipped', reason: 'not-owned' }); say(`sple: warning: skipped "${source.playlist?.name}" (not readable: not-owned)`); continue; }
          const info = errorInfo(error); output.skipped.push({ input: source.input, error: info }); index.entries.push({ ...identity, status: 'skipped', reason: 'error', error: info }); if (isFatalProviderError(error)) stopped = info;
        }
      }
      if (indexPath) { await writeAtomic(indexPath, `${JSON.stringify(index, null, 2)}\n`, { overwrite: !!flags.force }); output.indexPath = indexPath; }
      if (flags.output) print(output, ['path', 'format', 'tracks'], output.files.map(f => [f.path, f.format, f.trackCount]), output.files.map(f => f.path));
      const code = partialCode(output.skipped);
      for (const skipped of output.skipped) say(`sple: ${skipped.input}: ${skipped.error.message}`);
      const unreadable = index.entries.filter(e => e.reason === 'not-owned').length;
      if (flags.all && unreadable) say(`sple: skipped ${unreadable} unreadable playlist(s); see index.json`);
      if (code) {
        say(`sple: exported ${output.files.length} of ${sourceCount} playlists; ${output.skipped.length} skipped (see above)`);
        if (flags.json) say(JSON.stringify({ error: { type: 'PartialFailure', message: 'Some exports failed', exitCode: code } }));
      } else if (!flags.json && !flags.quiet) say(`sple: exported ${flags.output ? output.files.length : 1} playlist(s)`);
      return code;
    }
    return 0;
  } finally { progress.clear(); }
}

export async function readStdin(): Promise<string> { let result = ''; for await (const chunk of process.stdin) result += String(chunk); return result; }
export async function packageVersion(): Promise<string> { return (JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version; }
