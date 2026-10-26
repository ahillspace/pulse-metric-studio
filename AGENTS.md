# Repository instructions

This repository contains Pulse Metric Studio, published by ahillspace.
Keep the product focused on Tableau Pulse metric authoring and management.

## Structure

- `packages/pulse/src` owns Pulse authoring, publishing, management, and run history.
- `packages/web/src/features/pulse` owns the Pulse interface.
- `packages/core` owns configuration, storage, Tableau connections, and AI providers.
- `packages/shared` owns shared contracts and schemas.
- `packages/server` hosts the local application API.
- `src-tauri` owns the desktop shell and credential broker.
- `scripts` owns build and packaging tooling.

Use the `@pulse-metric-studio/*` workspace scope and `PULSE_METRIC_STUDIO_` prefix for application environment variables.
The desktop identifier is `com.ahillspace.pulsemetricstudio`.

## Architecture and onboarding

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and check ordering, then the [maintainer guide](docs/PULSE_MAINTAINER_GUIDE.md) for runtime boundaries and feature placement.
The [SQLite contract](docs/PULSE_SQLITE.md) owns durable state and migration behavior.
The [architecture audit](docs/ARCHITECTURE_AUDIT.md) records its examined snapshot, coverage limits, and recommendations; recommendations are not implemented behavior.

Keep renderer code on shared contracts and API clients, provider serialization in backend adapters, and SQL in repositories or core stores.
Preserve revision checks, connection ownership, reviewed mutation fingerprints, partial and unknown outcomes, and publication command idempotency.
Local CLI providers inherit the user's native setup and launch options; do not force safe mode, permission bypass, or tool restrictions.
Preserve the app's headless/output contract and document how optional native flags affect permissions and inherited instructions.
Local-agent tool actions execute outside app proposal review and publication receipts; do not describe those app mechanisms as controlling every agent action.
Update each concern's canonical documentation when its contract changes instead of copying architecture into instruction files.

## Workflow

Use subagents for implementation tasks and independent review when available.
Preserve unrelated work and avoid adding generated build output, credentials, databases, or logs to Git.
Do not manually edit generated lockfiles or changelogs.
Use plain dashes in human-facing writing and put each full sentence on its own line in long Markdown files.
Never add an agent as a commit co-author.

Validate changes with the relevant unit tests, TypeScript checks, and build.
Run `npm run check:architecture` when changing ownership boundaries; it enforces selected patterns and does not replace review.
Use `npm test` for Node tests and `cargo test --locked --manifest-path src-tauri/Cargo.toml` for Rust tests.
Keep automated tests isolated from live Tableau and AI services.
Do not introduce automated browser tests or live-provider test tooling without an explicit request.
Do not invoke no-mistakes tooling unless explicitly requested.
Desktop and live Tableau workflow validation is user-led.
The repository is shared with all employees through `sfdc-qbranch-emu/pulse-metric-studio` and is open source under Apache 2.0.
