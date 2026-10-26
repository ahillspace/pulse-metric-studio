# Pulse Metric Studio

Pulse Metric Studio is a desktop workbench for building and managing Tableau Pulse metrics.
Pick a published datasource, shape metric definitions and filters with an AI assistant or by hand, and publish a whole set of metrics in one step.
Manage what you published afterwards: variants, followers, previews, and clean deletion.

It runs on macOS and Windows and connects to your Tableau Cloud site and the AI provider you configure.
Local CLI providers use your native configuration and the launch options you choose.

Owner and maintainer: Andrew Hill (`andrew-hill_sfemu`).
Pulse Metric Studio is open source under the [Apache 2.0 license](LICENSE).
It is an independent tool, not a Tableau or Salesforce product.

## What you get

- **AI-assisted authoring.** Describe the audience and the assistant proposes metrics and slicers from the datasource's real fields; you review proposed draft changes before applying them.
  Local agents can also read documents, inspect Tableau, and act through tools available in their native configuration.
- **A full metric editor.** Edit names, descriptions, formats, sentiment, time dimensions, and granularity directly in the table, and lock what the assistant must not touch.
- **One-step publishing.** Publish a reviewed set of metric definitions, optionally followed by a digest group, and see each metric's preview and Pulse link afterwards.
- **Metric Manager.** Search definitions, create filtered or retimed variants in bulk, manage followers, preview metric cards, and delete with a reviewed list of exactly what goes.
- **Activity with undo.** Every publication keeps a receipt, even offline, with a confirmed undo for the metrics it created.

## Install

Run one command.
The installer picks the right build for your machine, verifies it against the release's `checksums.txt`, installs Pulse Metric Studio, and starts it.

Public releases, from [ahillspace/pulse-metric-studio](https://github.com/ahillspace/pulse-metric-studio):

```bash
# macOS (Terminal)
curl -fsSL https://github.com/ahillspace/pulse-metric-studio/releases/latest/download/install.sh | sh
```

```powershell
# Windows (PowerShell)
& ([scriptblock]::Create((irm https://github.com/ahillspace/pulse-metric-studio/releases/latest/download/install.ps1)))
```

Internal releases, from the private `sfdc-qbranch-emu/pulse-metric-studio` repository, need the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`) with an account that can open it:

```bash
# macOS (Terminal)
gh release download --repo sfdc-qbranch-emu/pulse-metric-studio --pattern install.sh -O - | sh
```

```powershell
# Windows (PowerShell)
& ([scriptblock]::Create((gh release download --repo sfdc-qbranch-emu/pulse-metric-studio --pattern install.ps1 -O - | Out-String)))
```

If the internal command cannot find the release, you are probably signed in with the wrong account; run `gh auth switch`.

- Install a specific version: `... | sh -s -- --version 0.1.0` on macOS, or append `-Version 0.1.0` on Windows.
- Uninstall (keeps your connections, drafts, and history): `... | sh -s -- uninstall` on macOS, or append `-Action Uninstall` on Windows.

### Updates

The app checks the repository it was installed from when it starts and once a day.
When a newer release is out, it offers the update, and an **Update to X.Y.Z** button stays above the assistant settings until you install it.
Updating saves your drafts, closes the app, installs the new release with the same installer, and opens the app again.
Update checks and installation use the recorded repository.
Reinstalling through another channel's helper replaces that record.

The one-line command records the repository used for updates.
Installing a disk image or setup file by hand does not create that record, but it preserves an existing update channel.
Run the install command to enable updates when no channel is recorded.

<details>
<summary>Installing by hand from the Releases page</summary>

Download the latest build from [Releases](../../releases/latest): `Pulse-Metric-Studio_*_x64-setup.exe` on Windows, or the `Pulse-Metric-Studio_*.dmg` for your Mac.

Default build configuration uses ad-hoc macOS signing and has no Windows signing configuration.
Browser downloads can show operating-system trust prompts.
The one-command installer downloads without a browser and records the update channel.
Operating-system trust prompts still depend on the signing, quarantine, and local policy of the installed artifact.

- Windows SmartScreen: click "More info", then "Run anyway".
- macOS "unidentified developer": right-click Pulse Metric Studio in Applications, choose Open, and confirm.
- macOS "Pulse Metric Studio is damaged and can't be opened": that is the download's quarantine flag, not real damage. Clear it once with `xattr -dr com.apple.quarantine "/Applications/Pulse Metric Studio.app"`.

</details>

## Get started

1. Create a Personal Access Token in Tableau Cloud (your account settings), then connect with your site URL, the token name, and its secret.
2. Optionally set up an AI provider in **Settings**: Codex CLI, Claude Code, OpenCode CLI, Amazon Bedrock, an OpenAI-compatible gateway, or the Anthropic API.
   Choose an explicit model and run **Test connection**.
3. Open **Author**, pick a published datasource, and either ask the assistant for a draft or add metrics yourself.
4. Review the result and publish. **Activity** keeps the receipt, and **Metric Manager** takes it from there.

## Your data and connections

- Tableau tokens, AI provider keys, custom header values, and credential commands are each stored as their own entry in macOS Keychain or Windows Credential Manager; the app database keeps only a reference.
  Profile listings use stored references without reading secret values.
  Connection restoration, provider requests, and legacy-secret migration can access the credential store.
- Settings show a saved secret as `***************`, which reveals nothing about its length or content.
- Local providers inherit native CLI credentials and configuration, including API keys, account sign-in, and configured provider routes.
  The CLI owns authentication; Pulse stores the launch command and model settings and does not choose a different billing route automatically.
- Local providers inherit native instructions, tools, skills, hooks, plugins, and MCP servers unless your launch options change them.
  Tool actions take effect directly, outside app proposal review, publication receipts, and undo.
- Drafts, settings, and publication receipts live in your user profile: `~/Library/Application Support/com.ahillspace.pulsemetricstudio/` on macOS, `%APPDATA%\com.ahillspace.pulsemetricstudio\` on Windows.
- The app's backend only listens on `127.0.0.1` and accepts requests signed by its own window.
- A provider can mint short-lived tokens with a credential command; the first time a new command runs, the app shows the exact command and asks you to allow it. Saved commands are never shown again in Settings, because their arguments can contain secrets.
- The backend trusts your operating system's certificate store so that corporate TLS inspection works, which means any root certificate your system trusts can inspect Tableau and AI traffic.
- The app sends datasource field names, captions, types, and calculated-field formulas to the AI provider, without querying row data for the prompt.
  The assistant also receives your conversation, pasted content, and current draft context.
  Local agents can retrieve additional data through tools and include it in requests to their provider.

### Configure a local CLI

Install Codex CLI, [Claude Code](https://code.claude.com/docs/en/setup), or OpenCode separately.
Configure authentication through the CLI's own supported flow, for example:

```sh
claude auth login
```

In **Settings**, choose the corresponding local provider and enter a model supported by your CLI configuration.
Use **Launch command** for an executable and optional prefix arguments.
For a new or edited OpenCode launch command, use **Reload models** before selecting a model and saving the profile.
Editing the command does not execute it.
The app adds the headless command, selected model, and response format; do not include those options yourself.
Quote paths or arguments containing spaces.
Shell expansion and implicit script invocation are unavailable; use an explicit interpreter command for scripts.
Use **Check setup** to check launch configuration without sending a model request.
Use **Test connection** to verify the selected model; this consumes account usage.
For account profiles, a successful test verifies that request.
The readiness indicator stays yellow when the CLI does not expose a stable account identity between runs.
If discovery cannot find your installation, provide the executable location.
The app reports unsupported CLI capabilities instead of silently changing the requested execution mode.

Launch options control native behavior, for example:

```sh
codex --sandbox read-only
claude --safe-mode
```

Pulse does not add safe mode, unrestricted access, auto-approval, or isolated configuration flags automatically.
Native headless permission handling applies; the app does not provide an interactive CLI approval terminal.
The app validates final structured proposals against its operation schema.
Catalog fields remain authoritative for proposed metrics and slicers.

Multiple profiles for one CLI share its native configuration unless their launch options select different settings.
Switch credentials through the CLI, then test the profile again.
Pulse does not automatically sign you in, sign you out, or select another provider after a failure.
Usage and charges follow your vendor account settings, including any enabled extra credits.
Subscription sign-in does not guarantee that every request uses included subscription allocation.
See the [maintainer guide](docs/PULSE_MAINTAINER_GUIDE.md) for execution boundaries and qualification limits.

## Development

Use Node.js 22.15 or newer; `.nvmrc` pins the CI runtime.

```sh
npm ci
npm run build
npm start
```

The local application is served at `http://127.0.0.1:4620`.
Use `npm run dev` for server and web development with hot reload.
Optional configuration is documented in `.env.example`.
Local server development stores data in `./data`, configurable with `PULSE_METRIC_STUDIO_DATA_DIR`, and offers an explicitly labeled encrypted-storage fallback for Tableau tokens.

Desktop builds need the Rust toolchain and the native Tauri prerequisites for your operating system.
Use `npm run tauri:dev` to run the desktop app and `npm run tauri:build` to package it into `native-artifacts/`.
The package includes its own Node runtime and native SQLite module, so end users do not need Node.js installed.
[CONTRIBUTING.md](CONTRIBUTING.md) covers the checks to run, signing, and how releases are published.

| Location | Purpose |
| --- | --- |
| `packages/pulse` | Pulse authoring, publishing, metric management, and run history |
| `packages/core` | Configuration, storage, Tableau connections, and AI providers |
| `packages/shared` | Shared contracts and metric schemas |
| `packages/server` | Local HTTP server |
| `packages/web` | React application |
| `src-tauri` | Desktop shell and OS credential broker |
| `scripts` | Development, packaging, install, release, and unit-test commands |

Read the [maintainer guide](docs/PULSE_MAINTAINER_GUIDE.md) for architecture and operation flows, the [SQLite contract](docs/PULSE_SQLITE.md) for state and recovery, and the [architecture audit](docs/ARCHITECTURE_AUDIT.md) for findings and coverage limits.
The Windows target is Windows 11 x64.
macOS targets include Apple silicon and Intel, with a declared minimum of macOS 11.0.

## Built with

Pulse Metric Studio stands on these open-source projects.
Thank you to their maintainers.

| Project | License | Used for |
| --- | --- | --- |
| [Tauri](https://tauri.app) and its opener, single-instance, and window-state plugins | MIT or Apache-2.0 | Desktop shell and the bridge to the local backend |
| [Node.js](https://nodejs.org) | MIT | Bundled runtime for the local backend |
| [Fastify](https://fastify.dev) with `@fastify/cors`, `@fastify/sensible`, and `@fastify/static` | MIT | Local HTTP server |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) and [SQLite](https://sqlite.org) | MIT; public domain | Local storage |
| [React](https://react.dev) and [Zustand](https://github.com/pmndrs/zustand) | MIT | User interface and state |
| [Zod](https://zod.dev) | MIT | Shared request and metric contracts |
| [pngjs](https://github.com/pngjs/pngjs) | MIT | Preview image decoding and CRC validation |
| [AWS SDK for JavaScript](https://github.com/aws/aws-sdk-js-v3) | Apache-2.0 | Amazon Bedrock provider |
| [dotenv](https://github.com/motdotla/dotenv) | BSD-2-Clause | Development configuration |
| [keyring](https://github.com/open-source-cooperative/keyring-rs) | MIT or Apache-2.0 | Credential Manager access on Windows |
| [reqwest](https://github.com/seanmonstar/reqwest), [Serde](https://serde.rs), [uuid](https://github.com/uuid-rs/uuid), and [RustCrypto `hmac` and `sha2`](https://github.com/RustCrypto) | MIT or Apache-2.0 | Native transport, request signing, and credential broker |
| [rfd](https://github.com/PolyMeilex/rfd) | MIT | Native dialogs |
| [Vite](https://vite.dev) and [TypeScript](https://www.typescriptlang.org) | MIT; Apache-2.0 | Build tooling (build time only, not shipped) |

## Contributing

Bug reports and pull requests are welcome.
[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the code layout, the checks to run, and how releases are built.
