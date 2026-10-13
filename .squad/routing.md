# Work Routing

## Routing Table

| Work Type | Route To | Examples |
|-----------|----------|----------|
| Architecture and shared core | Luigi | Provider contracts, core changes, architectural decisions |
| Code review and integration | Luigi | Cross-component review, packaging, CI coordination |
| CLI | Clemens | Commands, output, exit codes, CLI auth interaction |
| Spotify provider | Saul | Spotify API, authentication integration, pagination, retries |
| Testing | Thomas | Tests, coverage, regression verification, failure reproduction |
| Documentation | David | README, user guides, CLI reference, accepted decision documentation |

## Issue Routing

| Label | Action | Who |
|-------|--------|-----|
| squad | Triage and assign specialist labels | Luigi |
| squad:luigi | Architecture, core, and integration work | Luigi |
| squad:clemens | CLI work | Clemens |
| squad:saul | Spotify provider work | Saul |
| squad:thomas | Test and verification work | Thomas |
| squad:david | Documentation work | David |

## Rules

1. Assign one accountable specialist using the registry identity.
2. Add bounded collaboration only when independent work or review requires it.
3. Quick factual questions may be answered directly by the coordinator.
4. Apply .squad/governance.md for review and shared-file ownership.
5. Support agents are selected under their charters, never as specialist routes. Scribe only merges accepted durable decisions; Ralph monitors or routes work; Rai and Fact Checker perform bounded reviews when requested or selected.
6. GitHub issue pickup requires a configured issue source and user authorization. No continuous monitor is started by team setup.
