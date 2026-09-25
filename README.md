# Pulse Metric Studio

Pulse Metric Studio by ahillspace is a local desktop workbench for authoring and managing Tableau Pulse metrics.
Connect a Tableau Cloud site, select a published datasource, configure metric definitions and filters, and publish or manage metrics with optional AI assistance.
The application runs on your machine and connects to Tableau and the AI provider you configure.

## Development

Use Node.js 22 or newer; `.nvmrc` pins the CI runtime.

```sh
npm ci
npm run build
npm start
```

The local application is served at `http://127.0.0.1:4620`.
Use `npm run dev` for server and web development with hot reload.
Optional configuration is documented in `.env.example`.

## Desktop builds

Install the Rust toolchain and the native Tauri build prerequisites for your operating system.

```sh
npm run tauri:dev
npm run tauri:build
```

Build Windows installers on Windows and macOS bundles on macOS.
The package includes its own Node runtime and native SQLite module, so end users do not need Node.js installed.
The desktop shell provides a window, system tray, and single-instance behavior.
Quitting the application stops its local server.
App data is stored under the operating system's application data directory using `com.ahillspace.pulsemetricstudio`.
Local server development stores data in `./data`, configurable with `PULSE_METRIC_STUDIO_DATA_DIR`.

## Connections and AI

Connect with a Tableau Personal Access Token.
Desktop credentials use Windows Credential Manager or macOS Keychain, with only a credential reference stored in the application database.
Local web development offers an explicitly labeled encrypted-storage fallback.
Manual verification is still required for desktop credential restoration after a full application restart.

Configure AI assistance in the application's provider settings.
Supported providers include OpenCode CLI, Amazon Bedrock, OpenAI-compatible endpoints, and Anthropic.
Select an explicit model before using AI authoring.

## Repository

| Location | Purpose |
| --- | --- |
| `packages/pulse` | Pulse authoring, publishing, metric management, and run history |
| `packages/core` | Configuration, storage, Tableau connections, and AI providers |
| `packages/shared` | Shared contracts and metric schemas |
| `packages/server` | Local HTTP server |
| `packages/web` | React application |
| `src-tauri` | Desktop shell and OS credential broker |
| `scripts` | Development, packaging, and unit-test commands |

Run `npm run typecheck`, `npm test`, and `cargo test --locked --manifest-path src-tauri/Cargo.toml` for automated validation.
Unit tests use local fixtures and mocked provider responses.
Desktop workflows and Tableau publishing require user-led manual validation.

Product distribution is planned through GitHub Releases in `ahillspace/pulse-metric-studio`.
Documentation lives in this repository and support belongs in its Issues.
No license has been selected yet.
