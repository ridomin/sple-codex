# Commands (M1/M2)

The Spotify adapter is implemented. Run commands from this checkout as `node dist/cli/main.js …` after `npm ci && npm run build`, or as `sple …` after installing the packed npm artifact.

| Command | Behavior |
|---|---|
| `sple auth login [--no-browser \| --manual]` | PKCE login using your own Spotify app Client ID. |
| `sple auth status [--provider spotify] [--json\|--quiet]` | Read login metadata locally; make no network requests. |
| `sple auth logout [--provider spotify\|--all]` | Remove stored tokens; revoke Spotify grants manually at the linked account page. |
| `sple search <query…> [--type track\|album\|artist\|playlist] [--limit N] [--offset N]` | Search; default track type and 10 results. |
| `sple search <query…> --all [--max-results N]` | Fetch until exhausted or capped (default 100, maximum 1000). |
| `sple playlist list [--owned\|--followed] [--filter TEXT\|/REGEX/FLAGS]` | Read all pages, displaying ownership and available counts. |
| `sple playlist show <playlist\|->` | Read tracks; IDs, URIs, URLs and exact names are accepted. |
| `sple playlist create <name> [--description TEXT] [--public\|--private] [--collaborative] [--dry-run]` | Create a private playlist by default; collaborative means private. |
| `sple playlist edit <playlist\|-> [--name TEXT] [--description TEXT] [--public\|--private] [--dry-run]` | Change playlist metadata; an empty description clears it. |
| `sple playlist remove <playlist\|-> [--yes] [--dry-run]` | Unfollow on Spotify; Spotify has no playlist-delete API. |
| `sple export <playlist…\|-> [--liked] [-o FILE\|DIR] [--format json\|csv] [--force]` | Write canonical JSON or CSV; one source can go directly to stdout. |
| `sple export --all -o DIR [--format json\|csv] [--force]` | Export all readable playlists and Liked Songs; write `index.json` with exported/skipped entries. |

`--provider` overrides `SPLE_DEFAULT_PROVIDER`, which defaults to `spotify`. The fake provider is registered only with `SPLE_ENABLE_FAKE_PROVIDER=1`; its login needs no Client ID. YouTube Music is not registered yet. `import` and `migrate` are reserved for later milestones.

Quote names containing spaces. Name resolution tries exact case-sensitive names first, then case-insensitive names. Ambiguity exits 2 and lists matches; use an ID to disambiguate. Track reads work only for playlists you own or can access as a collaborator. Copy other playlists' tracks into your own playlist in Spotify to export them.

`--json` writes one result document to stdout; errors and warnings go to stderr. `--quiet` prints IDs (exported paths for file exports). The two flags cannot be combined. Without either, a terminal gets tables and a pipe gets headerless TSV. Auth status uses a human status summary. Login/logout do not accept `--json`. Export to stdout writes the file itself: use `--format json`, not `--json`.

`playlist remove` asks for confirmation unless `--yes` is supplied. A non-terminal stdin requires `--yes`; declining exits 1. Dry runs never prompt or mutate playlists. OAuth may still refresh credentials when a dry run needs reads.

`-` reads one playlist ref per line, ignores blanks and `#` comments, and accepts CRLF. Show/remove need exactly one ref. Export accepts many refs with a directory destination:

```sh
sple playlist list --owned --quiet | sple export - -o backups/
sple export --liked -o liked.json
sple playlist create 'Road Trip' --dry-run --json
```

`--verbose` and `--debug` log to stderr, with `DEBUG=sple:<namespace>` filtering. Tokens, headers and token-request bodies are never logged. Progress appears only on an interactive stderr and clears before warnings/logs. Exit codes: 0 success, 1 general/partial failure, 2 usage, 3 authentication, 4 not found, 5 exhausted rate/quota limit.

Batch exports retain successful files, report skipped inputs, and stop remaining work on auth/rate/quota failure. All names and destination paths are checked before writing. Existing files require `--force`; files are written atomically. Network/5xx failures on uncertain remote writes are not blindly retried.

## Configuration

Config is loaded from `.env` in:

- Linux: `$XDG_CONFIG_HOME/sple`, or `~/.config/sple`.
- macOS: `~/Library/Application Support/sple`.
- Windows: `%APPDATA%\sple`, or `~/.sple` if `APPDATA` is missing.

Process environment values take precedence over `.env`. The supported file syntax is single-line `KEY=value`, optional single/double quotes, blank lines and `#` comment lines. There is no variable expansion. `sple` never writes `.env`; on POSIX, create it with mode `0600`. A permissions warning does not stop the command.

`tokens.json` sits alongside `.env`. It is versioned, supports one active account per provider, and is replaced atomically with mode `0600` on POSIX. Windows relies on the user's profile access rules. Neither file belongs in version control. Logging and errors redact bearer tokens and OAuth credential fields.

The CLI has no hosted service and sends no telemetry. M0's fake provider never calls a service. The broader privacy policy required for YouTube will be added before M4a.

## M2 examples

A name filter is a case-insensitive literal substring. Use `/pattern/flags` for regex, with only `i`, `m`, `s`, `u` flags. Invalid regex is rejected before any requests. Filters combine with ownership flags.

```sh
sple playlist list --owned --filter road --json
sple playlist list --filter '/^(Road|Chill)/i' --quiet
sple playlist edit 'Road Trip' --name 'Weekend Road Trip' --description '' --dry-run --json
sple search 'artist:"The Beatles" album:"Abbey Road" year:1969'
sple search 'isrc:USAAA2600001' --type track
sple export --all -o backups/ --format json
```

Spotify edits require ownership and cannot make a collaborative playlist public. They do not prompt; use `--dry-run` to review first. Search filters are provider syntax: Spotify interprets `artist:`, `album:`, `year:`, `isrc:` where applicable, and the complete query is passed unchanged.

Export-all requires a directory and cannot combine with explicit playlists or `--liked` (Liked Songs is already included). Unreadable playlists are warned about, counted, and listed in `index.json` with `status: "skipped", reason: "not-owned"`; these skips do not fail an otherwise successful run. The index is written even for an empty/partial run. Existing playlist files and the index require `--force`. JSON result output adds `indexPath`; quiet output lists the playlist data files only.
