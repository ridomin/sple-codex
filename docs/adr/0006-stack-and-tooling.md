# ADR 0006: Stack, tooling and M0 baseline

- **Status:** Accepted for M0 (2026-10-13)
- **Related:** requirements NFR-1/2/6, ADRs 0003/0004/0007/0008/0010

## Decision

Use strict TypeScript and ESM, compiled by `tsc` to `dist/`. Target Node.js 24 or newer, with Node 24 as the development/CI baseline. Node 24 is Active LTS on this decision date according to the [Node release schedule](https://github.com/nodejs/Release#release-schedule). The local environment currently runs Node 26; compatibility with Node 24 is verified separately.

Distribute compiled JavaScript through an npm `bin` entry and expose the canonical schema via the package's `exports`. No standalone binary or CLI framework is needed. Arguments use `node:util.parseArgs`; HTTP uses native `fetch`; OAuth uses native crypto and HTTP; atomic token writes use native filesystem APIs.

The only runtime dependency is `debug` (ADR 0007 A11). Development dependencies are TypeScript, Node/debug types, Ajv and ajv-formats. Ajv validates the canonical schema in tests only; application code does not depend on it.

Tests use Node's built-in test runner. The cross-platform launcher passes explicit argument arrays, avoiding shell differences in globs. Coverage must reach 80% lines across executable core and adapter modules. Fixtures and injected fetch/clock/sleep/random functions keep automated tests offline and deterministic. Real loopback listeners test OAuth callback validation and cleanup without contacting provider APIs.

CI runs typechecking, coverage and package inspection on Linux, macOS and Windows with Node 24. Compiled output, dependencies, coverage artifacts and local credentials are ignored.

## Contract reconciliation

- `schemas/canonical-playlist.v1.schema.json` is the canonical published schema. The pre-implementation copy under `docs/` has been moved there; its validity rules are unchanged.
- Latest dated amendments take precedence over superseded ADR sections. Requirements §11/§12 describe actual implementation status; older references to already-built milestones are historical and do not establish completion.
- Spotify playlist item responses use `item`; the add-items request body remains `{ "uris": [...] }` per the [official endpoint reference](https://developer.spotify.com/documentation/web-api/reference/add-items-to-playlist). There is no general request-body rename from `tracks` to `items`.
- Config uses an explicit parser for ADR 0004's single-line subset, rather than mutating global process environment through `process.loadEnvFile`. File/env precedence and permission warnings stay as specified. This supports dependency injection and rejects multiline values consistently.
- No v0 token schema exists. Versions other than 1 are rejected; no speculative migration or file locking is implemented. Writes preserve other providers and reserved account slots; concurrent writers remain last-write-wins.
- The dry-run requirement applies to playlist/import/migrate operations. Auth token/grant changes and writing an explicitly requested export/report file are excluded. Auth logout therefore has no dry-run flag.

## Delivery boundary

M0 includes provider types/errors and registry, a configurable fake adapter, config and atomic token storage, offline auth status/logout, PKCE/loopback/manual authorization infrastructure, browser interaction, HTTP retries and single-flight refresh, pagination/name resolution, redacted logging and per-process quota accounting.

OAuth token exchange and provider identity calls are adapter work in M1/M4a. Daily quota persistence and migration checkpoints are M4 work; the M0 quota limiter deliberately tracks only this process. HTTP adapters can debit it through `beforeRequest` for every attempt, including retries.

M1 still begins with confirming or repeating S1–S4 and committing sanitized evidence. M4b still requires checkpoint/cache/report-review contracts that preserve duplicate source tracks.

## Verification (2026-10-13)

Strict typechecking passes. All 27 tests pass on Linux with Node 24 and Node 26; core/adapters have 99.72% line coverage. The canonical schema compiles under Ajv strict mode. A packed npm artifact was installed into an isolated temporary directory and its CLI version, offline status command, and schema package export were verified. The Linux/macOS/Windows CI matrix is configured; macOS and Windows jobs have not been run locally.

## M1/M2 verification (2026-10-13)

M1 implemented the Spotify adapter, PKCE token exchange/identity persistence, automatic refresh, search, playlist list/show/create/remove, canonical JSON/CSV exports and Liked Songs. M2 added metadata editing, name filters, documented field-query passthrough and export-all with its index (ADR 0007 Amendment 3). S1–S3 are owner-confirmed; their provenance and the S4 fallback are recorded in the spike report.

Strict typechecking passes and the combined 47-test suite passes on Linux with Node 24 and Node 26. Core/adapters have 99.39% line coverage; Spotify alone has 98.42%. The 1,000-track mocked integration test verifies ten item-page requests, at most four concurrent reads, ordered positions and canonical output. This does not independently establish real network throughput. No authenticated Spotify smoke test was performed by the agent. Package installation checks use the fake provider and isolated temporary configuration.
