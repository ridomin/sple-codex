# Agent instructions

Use the existing Squad configuration in `.squad/` and agent definitions in
`.github/agents/` to configure agents working in this repository.

## Load the configuration

1. Read `.squad/config.json` first. Resolve the team root and state backend using
   the rules in `.github/agents/squad.agent.md`; local `.squad/` is the default.
2. Read the resolved team's `team.md`, `routing.md`, `casting/registry.json`, and
   `decisions.md` to understand the roster, task ownership, identities, and
   accepted project decisions.
3. For Squad coordination, load `.github/agents/squad.agent.md`. For any other
   configured agent, load its definition from `.github/agents/` when present.
4. Before assigning work to an agent, read its charter under
   `.squad/agents/<agent>/charter.md`. Apply its role, boundaries, and relevant
   policies. Use the actual path and capitalization on disk.
5. Load referenced skills and supporting configuration only when relevant to
   the current task.

System and developer instructions and the user's current request take precedence
over repository instructions. Within the repository, use each agent's current
charter and applicable canonical policy to resolve conflicting generic guidance.
Treat `.squad/templates/` as scaffolding, not active team configuration.

## Configure and route agents

- Use `.squad/team.md` for the active roster and `.squad/routing.md` for task
  assignment. Specialist routes must refer to identities in the casting registry.
- The current roster and specialist registry are empty. Follow the coordinator's
  Init Mode when asked to assemble a team; do not infer active specialists from
  templates or built-in support charters.
- When adding or changing an agent, keep its charter, roster entry, routing, and
  casting configuration consistent. Follow `casting/policy.json` and the
  coordinator's configuration workflow.
- Keep executable agent definitions in `.github/agents/` and persistent team
  configuration in `.squad/`. Reference these sources instead of duplicating their
  full instructions here.
- Preserve generated sections in agent definitions and use the documented Squad
  workflow to refresh them.
- Delegate using tools available in the current runtime and pass the resolved
  team root, agent charter, relevant decisions, task scope, and expected output.
  Follow the coordinator's fallback when its documented dispatch tools are absent.

## Built-in support agents

Support agents are separate from specialist routing destinations. Follow their
current charters when selecting or configuring them:

- Scribe: `.squad/agents/scribe/charter.md` — merges accepted durable decisions.
- Ralph: `.squad/agents/ralph/charter.md` — discovers and routes queued work.
- Rai: `.squad/agents/Rai/charter.md` — provides bounded responsible-AI review.
- Fact Checker: `.squad/agents/fact-checker/charter.md` — verifies claims and
  challenges assumptions within the requested review scope.

## Preserve team state

Honor the configured state backend before changing mutable team state. For
non-local backends, use the runtime state tools required by the coordinator;
do not substitute direct file writes. Keep durable decisions in the canonical
decision record, and follow current charters for whether histories or logs are
appropriate. Preserve unrelated repository changes.
