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

## Workflow

Use subagents for implementation tasks and independent review when available.
Preserve unrelated work and avoid adding generated build output, credentials, databases, or logs to Git.
Do not manually edit generated lockfiles or changelogs.
Use plain dashes in human-facing writing and put each full sentence on its own line in long Markdown files.
Never add an agent as a commit co-author.

Validate changes with the relevant unit tests, TypeScript checks, and build.
Use `npm test` for Node tests and `cargo test --locked --manifest-path src-tauri/Cargo.toml` for Rust tests.
Keep automated tests isolated from live Tableau and AI services.
Do not introduce automated browser tests or live-provider test tooling without an explicit request.
Do not invoke no-mistakes tooling unless explicitly requested.
Desktop and live Tableau workflow validation is user-led.
Keep the repository private until the owner chooses a license and authorizes publication.
