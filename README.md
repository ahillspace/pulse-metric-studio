# Pulse Metric Studio

Pulse Metric Studio by ahillspace is a local desktop workbench for authoring and managing Tableau Pulse metrics.
Connect a Tableau Cloud site, select a published datasource, configure metric definitions and filters, and publish or manage metrics with optional AI assistance.
The application runs on your machine and connects to Tableau and the AI provider you configure.
Pulse Metric Studio is independent and is not affiliated with Tableau or Salesforce.

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
The desktop shell provides a single-instance window and an authenticated bridge to its bundled backend.
Closing the window exits the app and stops its backend.
Build artifacts appear in `native-artifacts/`.
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
AI provider keys are encrypted in the application database with a key that the desktop app keeps in Windows Credential Manager or macOS Keychain.
A provider can mint short-lived tokens with a credential command; the first time a new command runs, the desktop app shows the exact command and asks you to allow it.
Saved credential commands are never shown again in the settings, because their arguments can contain secrets.
The desktop backend trusts your operating system's certificate store so that corporate TLS inspection works, which means any root certificate your system trusts can inspect Tableau and AI traffic.

## Author and manage metrics

**Author** restores your current configuration when you select a datasource.
Edits persist automatically.
Edit metric properties directly in the table and choose the digest audience above it.
Review and accept assistant proposals before applying them.
Manual edits and locked properties remain protected during proposal acceptance.

**Metric Manager** supports definition search, variants, subscriptions, and bulk deletion.
Create variants from selected metrics, with timeframe and filter changes beside a preview.
Deleting default metrics includes a review of the affected definitions and their dependent metrics.
**Activity** keeps publication results available while disconnected and offers undo for eligible confirmed creations.
Publication results also provide a separate action to delete a group created by that publication.
In Metric Manager, preview a metric card using the connected Tableau account.
Previews require Tableau Cloud metric image API support and available insight data.

The backend owns validation, Tableau requests, and SQLite access.
SQLite stores the latest authoring configuration and publication receipts.

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
Before Rust tests on a fresh checkout, run `npm run build` and `node scripts/copy-resources.mjs` to prepare native resources.
Unit tests use local fixtures and mocked provider responses.
Desktop workflows and Tableau publishing require user-led manual validation.

Maintenance guidance and the SQLite contract are in the repository's `docs` directory.
The Windows target is Windows 11 x64.
macOS targets include Apple silicon and Intel, with a declared minimum of macOS 11.0.
Each platform requires native runtime qualification before release.

Product distribution is planned through GitHub Releases in `ahillspace/pulse-metric-studio`.
Documentation lives in this repository and support belongs in its Issues.

## License

Pulse Metric Studio is licensed under [Apache 2.0](LICENSE).
