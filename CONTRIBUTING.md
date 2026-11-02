# Contribute to Pulse Metric Studio

Use this page for setup, validation, packaging, and release procedures.
Use the [maintainer guide](docs/PULSE_MAINTAINER_GUIDE.md) for architecture, feature locations, state, and security boundaries.
[AGENTS.md](AGENTS.md) records repository rules.

## Set up your environment

Use Node.js 22.23.2 from [.nvmrc](.nvmrc) and the committed npm lockfile.
The root package manifest owns the minimum Node version; runtime checks and native startup consume that requirement and verify `--use-system-ca` support.
Desktop work also requires Rust and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
Windows needs C++ build tools and WebView2; macOS needs Xcode command line tools.

From the repository root, run:

```sh
npm ci
npm run tauri:dev
```

Desktop development builds shared packages and the frontend, composes resources, and starts Tauri.
It uses bundled frontend and backend resources rather than browser watchers.
Restart desktop development after changes that need resource recomposition.

For browser development, run:

```sh
npm run dev
```

This script builds shared dependencies, then starts their watchers, the server, and Vite.
Vite serves port 4621 and proxies `/api` to port 4620 by default.
[.env.example](.env.example) describes optional configuration; runtime settings also configure the app.
The desktop host owns its server port, app data directory, and native credential configuration.

## Validate a change

Run the relevant checks before opening a pull request:

```sh
npm run build
npm run typecheck
npm run check:architecture
npm test
node scripts/copy-resources.mjs
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

On a fresh checkout, `node scripts/copy-resources.mjs` supplies files referenced by the Rust build.
Run the listed build, type, architecture, Node, resource composition, and Rust checks locally before opening a pull request.
The [audit validation record](docs/ARCHITECTURE_AUDIT.md#validation-record) distinguishes inspected procedures from checks actually run during that review.

`npm run build` builds workspaces in dependency order.
`npm test` prebuilds shared backend dependencies, runs script tests, and runs every workspace test command.
The Node test runner discovers tests recursively and isolates each file's data directory.
The architecture guard checks selected import and responsibility boundaries; it does not replace review.
There is no separate lint command in the root manifest.

Keep automated tests isolated from live Tableau and AI services.
Desktop, installer, and live Tableau qualification remain user-led.
Automated browser tests and live-provider test tooling require an explicit request.
The [transfer verification record](docs/TRANSFER_VERIFICATION.md) describes the earlier 0.1.0 transfer, not current-release qualification.

## Prepare a pull request

- Describe the problem, resulting behavior, and validation performed.
- Add meaningful isolated tests for new behavior.
- Preserve unrelated work and existing user data.
- Keep credentials, databases, logs, build output, and local qualification artifacts out of Git.
- Regenerate lockfiles through package managers, and do not manually edit generated files or changelogs.
- Use plain dashes in prose, and do not add an agent as a commit co-author.

Use the [maintainer guide](docs/PULSE_MAINTAINER_GUIDE.md) to locate representative changes and their contracts.
Open bug reports with your platform, app version, and reproduction steps.

## Build desktop packages

Build installers on the target operating system:

```sh
npm run tauri:build
```

This command runs [build-native.mjs](scripts/build-native.mjs), which stages a separate source copy and prepares installed dependencies.
The stage discards copied workspace outputs and rebuilds them from staged sources.
Workspace imports resolve to staged packages; external dependencies can share the installed dependency tree.
Keep installed external dependencies unchanged during packaging.
Changes to compiled workspace files in the original checkout after staging cannot change the stage's backend bundle.
Tauri invokes [copy-resources.mjs](scripts/copy-resources.mjs) in that stage.
Resource composition bundles the backend and copies the frontend, installer helpers, Node executable, and native SQLite module.
It verifies a SQLite round trip with the packaged Node executable.
Runtime inspection and the SQLite check use the same required startup flag as the installed backend.
Installed users do not need a separate Node installation.

The packager supports Windows and macOS and writes installers and `build-evidence.json` under ignored `native-artifacts/`.
Evidence includes platform, architecture, Node version, desktop identity, and artifact hashes.
Private build evidence also records the source commit, dirty state, and normalized source-content identity.
The packager verifies that source identity remains unchanged while copying the build stage.
Public `release-evidence.json` contains only source, version, runtime, platform, and relative artifact identity fields; local diagnostic paths remain private.
Temporary build stages remain available for diagnostics.
The packager exclusively locks its cached Cargo target while a build runs and clears only that target's prior bundle outputs.
It assembles artifacts and evidence in a fresh directory, then replaces the previous app-owned output after success.
Build or promotion failure preserves the previous output.
A nonempty custom output must have matching app build evidence; source directories, directory links, and unowned nonempty directories are rejected.
If a builder is forcibly interrupted, its `.pulse-native-build.lock` can remain in the temporary target directory.
Verify that the process identified in that lock has stopped before removing the stale lock and retrying.

macOS packaging requires Node 22 and sets the deployment target to macOS 11.0.
Mach-O deployment checks do not establish runtime qualification on macOS 11.
Windows bundles configure the WebView2 download bootstrapper.

For a separate validation identity and output directory, run:

```sh
node scripts/build-native.mjs --validation
```

On Windows, validation produces an executable and resources instead of an installer.
This command creates artifacts; it does not validate desktop workflows.

## Maintain icon assets

The web artwork in `packages/web/src/assets/pulse-icon.png` is the source for platform and tray icons.
Run `npm run icons` to render intermediate PNGs and invoke Tauri's platform icon generator.
The tracked SVG files under `design/` are reference artwork; the current generator reads the PNG source.
Keep generated icons consistent with that source instead of editing their pixels independently.

## Publish a release

Publication is a manual maintainer workflow.
The public release repository is `ahillspace/pulse-metric-studio`.

1. Update versions consistently across root and workspace manifests, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
   Regenerate npm and Cargo lockfiles through their package managers.
2. Complete automated checks and user-led platform qualification.
3. Build macOS disk images on the matching Mac architecture.
   Set `APPLE_SIGNING_IDENTITY` to override the configured ad-hoc identity when needed.
4. Build Windows installers on Windows.
   Use Windows and macOS artifacts from the same examined revision.
5. Stage the release into an empty directory:

   ```sh
   sh scripts/stage-release.sh release-assets PATH_TO_INSTALLER
   ```

   Staging reads the root package version, copies matching installers, rewrites helper defaults, and writes `checksums.txt`.
   It also discovers matching disk images and Windows setup installers under `native-artifacts/`.
   External installers need their matching sanitized `release-evidence.json` beside the file or in the parent build directory.
   Preserve this sidecar when transferring installers between build machines.
   Staging verifies source identity and artifact hashes, rejects conflicting sources or duplicate filenames, and promotes all output together.
   Historical installers without matching evidence require a new build.
   Dirty builds remain supported, but matching commit names and dirty flags do not establish matching source contents.
   Check that every intended platform and architecture is present.
   Matching filenames do not establish shared source revision or a complete platform set.
6. Review staged files, then create and publish the release:

   ```sh
   gh release create vX.Y.Z release-assets/* --draft --repo ahillspace/pulse-metric-studio
   gh release edit vX.Y.Z --draft=false --latest --repo ahillspace/pulse-metric-studio
   ```

Draft releases remain outside the installers' latest-release lookup.
Use numeric three-part versions for in-app updates; the updater rejects prerelease suffixes.
Checksums detect corruption relative to the downloaded manifest; they do not authenticate the publisher.
The tracked configuration has no Windows signing configuration and defaults to ad-hoc macOS signing.
Signing and notarization require separate credentials and platform qualification.

## Understand installation and updates

The [Windows](scripts/install.ps1) and [macOS](scripts/install.sh) helper installers download releases and verify SHA-256 checksums before installation.
The helpers record the public repository in the app data directory's `update-channel` file, and the app passes it explicitly for updates.

A direct setup-file or disk-image installation does not record a channel.
An existing channel in the same app data directory remains effective.
Debug builds disable updates.
Release builds with a valid channel and bundled helper check at launch and every 24 hours.
The app offers updates when the reported numeric version is newer.

**Update now** enters normal shutdown, saves pending drafts, stops services, and launches the bundled helper.
A canceled close cancels the pending update.
The helper resolves the latest release again when installation begins.
Handled installer failures write an error record and attempt to reopen the installed app.
Process or operating-system failures can prevent recovery; inspect the update log and restart manually.

The macOS helper stages the replacement beside the old app and restores the old path when the final move fails.
Windows delegates installation and its failure handling to NSIS.
Both helpers clean their temporary download directories.
Helper uninstall removes the app and channel record while retaining app data and native credentials.
Preserve the data directory and credential entries during ordinary updates and uninstalls.

The helpers request normal close and wait for the app's automatic persistence and shutdown handshake.
If the app remains open after the bounded wait, installation or removal stops before changing the installed app.
The helpers do not force-stop the app after a delayed write, persistence failure, or canceled close.
Let the automatic close finish before retrying; no manual Save action is required.
The normal in-app update completes the shutdown handshake before starting its helper.
