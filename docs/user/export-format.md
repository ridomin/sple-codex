# Export files

Canonical JSON is versioned (`schemaVersion: 1`) and preserves supported track metadata, ordering and provider refs. It includes the export timestamp, generator version, source provider/account when known, playlist metadata, and ordered tracks. ISRC can be absent, null or a string. The [published JSON Schema](../../schemas/canonical-playlist.v1.schema.json) defines the format and is available as `sple/schemas/canonical-playlist.v1.schema.json` in the npm package.

Local files, podcast episodes and unavailable items are dropped with a stderr warning. Exported track positions are contiguous from 1; `unsupportedItems` is currently empty. `trackCount` counts the exported tracks, rather than the service's pre-read count. JSON is lossless for these supported tracks; it is not a backup of unsupported media.

CSV uses UTF-8 without a BOM, RFC 4180 quoting and CRLF records, with columns:

```text
position,title,artists,album,duration_ms,added_at,isrc,ref
```

Artists are joined by `; `, and only the source provider's ref is written. Empty cells represent missing values, including null ISRC. CSV has no playlist-level metadata and loses distinctions that JSON preserves. Values beginning with `=`, `+`, `-` or `@` are written unchanged: opening an untrusted playlist export in a spreadsheet may interpret these as formulas.

Without `-o`, exactly one source is written to stdout. With several sources, `-o` is a directory; a single source treats a trailing path separator or existing directory as a directory, otherwise as a file whose parent must exist. Directory exports use `<slug>-<id>.json` or `.csv`, and Liked Songs uses `liked-songs.json` or `.csv`. Existing targets need `--force`.

These files belong to you. They are created where you request, are outside managed cache retention, and are not deleted on logout or read/uploaded automatically. Keep JSON when you want to retain all metadata for a later import.

## Export-all index

`export --all -o DIR` also writes `index.json` with `schemaVersion: 1`, `exportedAt`, `provider`, and `entries`. Entries identify the input, playlist ID/name when known, source kind, and exported/skipped status. Exported entries give an absolute path and track count. Unreadable playlists have `reason: "not-owned"`; other failures have `reason: "error"` and the same typed error information as the CLI. Liked Songs is a separate `kind: "liked"` entry.

The index is a manifest, not a canonical playlist file for import. It is created atomically and participates in overwrite preflight. A partial run retains successful files and records failures/skips in its index.
