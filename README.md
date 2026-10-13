# sple

A local CLI for music playlists, with a provider-neutral core. The first music-service release targets Spotify; YouTube Music comes later.

M1 and M2 Spotify commands are implemented: PKCE login, offline status/logout, catalog search, playlist list/show/create/edit/remove, name filtering, field searches, and JSON/CSV exports including Liked Songs and export-all indexes. An opt-in fake provider keeps tests offline. See [Spotify setup](docs/user/setup.md) to connect your account.

Requires Node.js 24 or newer. Node 24 is the development/CI baseline; the compiled CLI is packaged for npm. This checkout is not automatically published.

```sh
npm ci
npm run check
node dist/cli/main.js --help
node dist/cli/main.js auth status --json
```

The checks lint TypeScript with `ts-standard` and JavaScript tests/scripts with `standard`, compile strict TypeScript, and run Node's built-in `node:test` runner with an 80% line coverage gate on core and adapters. Use `npm run lint` to check StandardJS style or `npm run lint:fix` to apply automatic fixes. Tests use `node:assert/strict`; Jest and Vitest are not used. Provider HTTP requests are mocked. OAuth tests bind temporary listeners on `127.0.0.1`; they do not contact music services.

For a local fake-provider demo on POSIX:

```sh
SPLE_ENABLE_FAKE_PROVIDER=1 node dist/cli/main.js auth login --provider fake
SPLE_ENABLE_FAKE_PROVIDER=1 node dist/cli/main.js auth status --provider fake --json
SPLE_ENABLE_FAKE_PROVIDER=1 node dist/cli/main.js auth logout --provider fake
```

The fake catalog and playlists are in memory, so they are reset between processes. Only fake login tokens persist, in the same user config directory used by the real providers. In PowerShell, set `$env:SPLE_ENABLE_FAKE_PROVIDER = '1'` before running the commands.

See [current commands](docs/user/commands.md), [requirements](docs/requirements.md), [stack decisions](docs/adr/0006-stack-and-tooling.md), and the [canonical export schema](schemas/canonical-playlist.v1.schema.json).
