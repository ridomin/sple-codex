# Pull Request Requirements

Preserve the accepted contracts in docs/adr/ and .squad/decisions.md. Describe the concrete behavior change and relevant validation.

For code changes, run npm run check (lint, strict TypeScript checks, offline tests, and the 80% core/adapter line-coverage gate). For documentation or team-configuration changes, validate affected references and configuration; product tests are required only when product behavior changes.

Use the ownership and bounded review policy in .squad/governance.md. Publishing, deployment, and merging follow the user's authorization; configuring the team does not perform these actions.
