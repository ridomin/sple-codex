# Squad Governance

## Ownership

Squad coordinates the confirmed roster in team.md and routes specialist work through routing.md. The casting registry contains only Luigi, Clemens, Saul, Thomas, and David. Support agents retain their current charters.

Luigi owns architecture and shared provider-neutral core; Clemens owns the CLI; Saul owns Spotify; Thomas owns tests and coverage; David owns user documentation. Shared auth, HTTP, schema, and interface changes require coordination with Luigi and the affected specialist.

## Reviews

Use a review scope proportionate to the change. Routine work has at most one blocking gate; high-risk work may have a primary gate and one orthogonal specialist gate. Rai and Fact Checker are advisory unless explicitly selected as a gate. No automatic support-agent review fan-out is required.

Blocking findings must identify evidence, the violated requirement, scope, and the minimum approval condition. A rejected artifact's author cannot own or contribute to its immediate revision. Assign a different qualified specialist, or escalate if none is available. Focus rereview on blockers, the revision delta, and regressions.

## Validation

Follow .github/PR_REQUIREMENTS.md. Use existing tests and offline provider fixtures. Do not claim live Spotify verification unless it was performed or explicitly confirmed by the owner and recorded as such.

## State

The configured backend is local. Preserve existing decisions and unrelated repository changes. Squad records accepted durable decisions; Scribe may merge accepted inbox entries. Do not create routine histories, session logs, audit trails, or speculative decision records. Initial specialist history files are setup context only.

Current charters and this canonical policy resolve conflicting generic scaffold guidance, subject to system instructions and the user's current request. Templates are scaffolding, not active agents or policy.
