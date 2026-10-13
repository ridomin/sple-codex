# Squad Decisions

## Active Decisions

### 2026-10-13: M0 implementation baseline

The user authorized starting the reviewed implementation plan. M0 uses strict TypeScript/ESM, Node 24 as the LTS baseline, npm packaging, the native test runner, and an 80% core/adapter line-coverage gate. The only runtime dependency is `debug`.

The canonical schema lives in `schemas/`. HTTP reads retry transient failures; uncertain writes are not replayed without established idempotency. Provider-backed Spotify commands await confirmed or repeated S1–S4 evidence. Daily quota persistence and migration checkpoints remain M4 work.

The detailed decisions and delivery boundary are in [ADR 0006](../docs/adr/0006-stack-and-tooling.md) and [ADR 0010 Amendment 2](../docs/adr/0010-http-oauth-and-token-refresh.md#amendment-2-m0-retry-safety-2026-10-13).

### 2026-10-13: M1 Spotify evidence and implementation

Rido confirmed S1–S3: "verified, assume the spikes work". The [spike record](../docs/spikes/M1-spotify-spikes.md) records owner confirmation without claiming new live captures. M1 uses the confirmed page sizes/ISRC/collaborator behavior, retains the S4 Premium fallback, and keeps automated tests offline. M1 commands and export formats are implemented; live account smoke testing and network performance were not independently repeated.

The user authorized continuing to M2 immediately after M1 verification.

### 2026-10-13: M2 CLI contracts

M2 adds optional provider metadata editing, literal substring or explicit `/pattern/flags` playlist filters, documented Spotify field-query passthrough, and export-all with an atomic `index.json`. Expected unreadable playlists are warnings and index entries with `reason: 'not-owned'`; actual failures keep the partial-failure exit/output contract. The detailed accepted implementation contract is [ADR 0007 Amendment 3](../docs/adr/0007-cli-conventions.md#amendment-3-m2-polish-2026-10-13).

### 2026-10-13: Cost-effective Codex models

Rido requested the most cost-effective available Codex model for each configured agent. All five specialists and four support agents use `gpt-6-luna`, with the same Squad default and persistent per-agent overrides. The current Codex runtime and local model catalog list GPT-6 Luna as available; [OpenAI model guidance](https://developers.openai.com/api/docs/guides/model-selection) identifies Luna as the most cost-efficient option. This preference takes precedence over generic task-based model selection. If unavailable, report it instead of silently upgrading to a more expensive model. These settings apply to future agent dispatches and do not change the model of the already-running coordinator session.

### 2026-10-13: Astra for the Lead

Rido revised the cost-effective model policy for Luigi: the Lead uses `gpt-6-astra` with high reasoning effort for architecture and complex tasks. All other agents and the Squad default remain on `gpt-6-luna`. Persistent overrides cover both the lowercase dispatch identity `luigi` and display name `Luigi`, because the SDK performs exact-key lookup. This supersedes the earlier all-Luna policy for Luigi only.

#### 2026-10-13: Empty Spotify playlist names

Rido's committed fix `2c4588c` accepts an empty Spotify playlist name and maps it to `"(untitled)"` in both list and metadata summaries. IDs, ownership, readability, counts and pagination are preserved. Missing, null and non-string names remain provider validation errors. CLI consumers and exports use the returned fallback; create/edit inputs still require a non-empty name.

Canonical contract: [ADR 0003 Amendment 4](../docs/adr/0003-provider-interface-and-capabilities.md#amendment-4-empty-spotify-playlist-names-2026-10-13). Evidence: the committed adapter change and named regression test in `test/spotify.test.mjs`. This records the existing accepted fix; it introduces no product change.

#### 2026-10-13: StandardJS and native test tooling

The current [ADR 0006](../docs/adr/0006-stack-and-tooling.md#decision) tooling policy uses `ts-standard` for TypeScript and `standard` for JavaScript tests/scripts, with `npm run lint`, `npm run lint:fix`, and linting included in `npm run check`. Tests use `node:test` and `node:assert/strict`; Jest and Vitest are excluded. These are development tools; `debug` remains the only runtime dependency.

Provenance: ADR 0006, README, package scripts and dependency changes were already present in the working tree when this review began. This entry indexes that existing ADR policy and does not claim separate owner confirmation or a committed tooling change. The native test runner was already part of the accepted M0 baseline.

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction
