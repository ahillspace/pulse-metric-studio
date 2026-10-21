# Maintain Pulse Metric Studio

Pulse Metric Studio is a desktop app with Windows and macOS release targets.
Product management owns its user experience; dedicated engineers own implementation, qualification, and releases.
The local browser server is a development and test harness.

## Start here

Use the Node version in `.nvmrc`, the repository lockfile, and the supported Rust toolchain for Tauri.
Windows builds need the Visual Studio C++ build tools and WebView2.
macOS builds need Xcode command line tools.

Windows 11 x64 and macOS on Apple silicon and Intel are desktop targets.
The declared macOS compatibility minimum is 11.0 with the pinned Node 22 runtime.
Native packaging rejects incompatible runtime or Mach-O deployment targets.
This dependency-based minimum requires runtime qualification on each supported platform before release.
CI builds on Windows Server 2022 x64, macOS 15 arm64, and macOS 15 x64, with an explicit architecture check.
These are intended release targets; the transfer verification document records checks actually completed in this repository.
Runner labels follow the [GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

```sh
npm ci
npm run build
npm run tauri:dev
```

For browser development, `npm run dev` starts the default Pulse interface and backend watchers.
The web entry point loads Pulse directly.
Browser development can use explicitly selected encrypted credential storage.
The installed application uses Windows Credential Manager or macOS Keychain.
Do not copy production credentials into fixtures, reports, screenshots, or source control.

## Ownership and permitted dependencies

| Responsibility | Location | Owns |
|---|---|---|
| Application contracts | `packages/shared/src/pulse-contracts.ts` | Validated app requests, documents, plans, and receipts |
| Pure authoring rules | `packages/shared/src/pulse-domain.ts` | Document edits and responsive validation without network or database access |
| HTTP boundary | `packages/pulse/src/http` | Parse requests, invoke named workflows, return structured errors |
| Application workflows | `packages/pulse/src/application` | Revision checks, publication review and execution, proposals, deletion planning |
| Persistence | `packages/pulse/src/persistence` | SQL, migration, document revisions, durable publication outcomes |
| Tableau integration | `packages/pulse/src/adapters` and `packages/pulse/src/pulse` | Provider serialization, inventory, variants, subscriptions, transport |
| Presentation | `packages/web/src/features/pulse` | Connections, Author, Metric Manager, Activity, and their local controllers |
| Desktop host | `src-tauri` | Native credentials, authenticated API bridge, child process lifecycle |
| Host infrastructure | `packages/core` and `packages/server` | Runtime capabilities and Pulse registration |

The frontend talks to the backend API.
Backend repositories own SQLite access, and backend adapters construct Tableau requests.
Shared app contracts describe user intent; provider payloads stay behind the backend boundary.
Pure validation can run in the frontend for immediate feedback, and the backend independently enforces the rules using current metadata.
The shell owns navigation, page headers, and assistant sizing.
Author owns inline metric editing and proposal review; Metric Manager owns selected source metrics and the variant dialog.
Proposal review and acceptance use the same merge rules, and the shared document diff describes the changes that will apply.
New metrics default to over-time data mode with a daily minimum granularity.
The app owns the initial month-to-date timeframe and data mode; assistant operations preserve manually selected data modes.
Assistant instructions permit a coarser minimum only for an explicit user request or field metadata that states daily data is unavailable.
Schema parsing strips unsupported assistant properties before applying edits.

Run `npm run check:architecture` after moving responsibilities.
The guard checks forbidden imports, frontend provider serialization, and direct database or network access in pure/workflow code.
Use the guard alongside code review.

Draft and receipt list endpoints return bounded summaries, with `offset`, `limit`, `q`, and a total count.
The default page size is 50 and the maximum is 100.
Repository queries search saved configurations and publication history.
Open a selected record through its detail endpoint.

## Trace a publication

1. Choosing a datasource restores its authoring configuration using immutable connection, server, site, and datasource coordinates.
2. Edits save with an expected revision.
   SQLite updates only when that revision still matches.
3. Assistant output proposes changes against a captured document.
   Explicit acceptance merges compatible changes while preserving manual property locks and newer edits or removals.
   Conversation survives proposal discard; requests use current input even when background saving fails.
4. Publication saves the intended document and asks the backend to review that exact revision.
5. The backend refreshes datasource metadata, validates meaning, serializes provider requests, and returns a preview fingerprint.
6. The approved command includes the revision, fingerprint, and a new command ID.
7. Before any remote write, one local transaction records the run, every intended definition, the chosen audience, and the original site content URL.
8. The backend records each confirmed remote ID before optional group and subscription work.
9. Author displays a result dialog with creation counts, diagnostics, and actions.
   Activity retains the complete receipt while disconnected.

Publication verifies the initial metric's month-to-date timeframe through Tableau reads before resolving it for group subscriptions.
An unexpected timeframe retains the confirmed definition and records a resolution diagnostic.
Digest groups use `pmStudio - Datasource Name - chosen name`, with the complete datasource and audience labels.
The transport escapes XML while preserving the group name.
Group actions use recorded group IDs and publication ownership.

For a new rule, add pure validation and route integration tests, then verify the relevant UI workflow.
For a provider wire change, capture the expected Tableau payload fixture before changing serialization.

## Handle an interrupted operation

The app does not replay publications when it restarts.
An interrupted request can have a confirmed creation, a confirmed rejection, an unknown outcome, or an item never attempted.
Inventory visibility is separate from creation: a definition can be confirmed while its default metric is still pending.

A repeated submission with the same command ID and reviewed input returns the stored receipt.
Reusing the ID with different input is rejected.
SQLite admission and Tableau writes remain separate operations.

When an outcome is unknown:

1. Keep the receipt and its exact server/site/datasource context.
2. Inspect Tableau using TADX or the provider UI for the named resource and intended configuration.
3. Establish what happened before submitting a new publication.
4. Use exact resource IDs for any cleanup and record the result.

Do not infer that a timeout means failure.
Do not delete reused metrics or groups merely because they appear in a receipt.
Undo compensates confirmed definition creations and rechecks connection ownership.
It is a destructive action against those definitions, including their Tableau dependents; review the displayed scope before using it.
Group deletion is a separate receipt-owned operation for groups confirmed created by that publication.
Author and Activity read the same updated receipt outcomes.

Window close, tray Quit, and operating-system quit requests use the same desktop shutdown flow.
The editor stops accepting changes, waits for current assistant and catalog updates, and saves every open draft before the native host stops the backend.
The user can keep the app open while those changes finish.
After saving finishes, the editor stays disabled until the native host exits.
A failed save keeps the window and edits available.
Closing without saving requires a separate confirmation that identifies the affected drafts.
Browser development warns before navigating away with unsaved draft changes.

## Change Metric Manager behavior

Inventory, variants, subscriptions, and deletion have separate named responsibilities.
Dimension discovery, member counts, and value queries send validated POST bodies so large selections do not exceed desktop URL limits.
Source metric and definition reads use bounded concurrency, and repeated definition reads share one request within the operation.
Date and dimensional variants use the canonical variant endpoint.
Deletion first asks the backend for a plan, then submits the exact selection and plan fingerprint.
A bulk selection containing defaults opens an explicit review of the affected definitions and their metrics.
An ordinary variant selection never authorizes deleting its parent definition.
Incomplete inventory cannot establish that a selection covers every dependent resource.

Metric Manager previews use Tableau's springboard insight and metric card image APIs through the existing authenticated connection.
The backend verifies the exact metric, definition, and datasource before rendering.
The frontend receives a bounded PNG image; Tableau credentials remain in the backend.
PNG decoding and CRC validation use `pngjs`; resource guards reject oversized dimensions, duplicate headers, and unsupported interlaced images before decoding.
Preview images remain in memory and are discarded when the context or inventory changes.
The card uses the unique successful BAN summary sparkline, one successful period-over-period insight, and the highest-scored successful supporting insight.
Tableau supplies the chart, facts, and markup.
Springboard requests specify bundle version `1`; card image requests use Tableau's default locale.
Provider order breaks equal scores.
Missing required insights produce an unavailable state; unrelated partial insight failures can still yield a usable card.
The image API requires Tableau Cloud support introduced with API 3.29.
Provider-shaped fixtures cover mapping, permissions, context changes, size limits, and response failures; they do not establish live rendering compatibility.

Keep partial and truncated results visible in the interface.
An empty visible subset is not evidence that a datasource has no definitions.

## Qualify a change

```sh
npm run build
npm run typecheck
npm run check:architecture
npm test
node scripts/copy-resources.mjs
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Unit and server integration tests use local fixtures, temporary databases, and controlled provider responses.
Desktop and live Tableau workflow validation is user-led.

CI runs native transport tests and builds Windows and macOS installers on their respective platforms.
A successful build does not establish native runtime qualification.
Before release, qualify installation, upgrade, restart, sleep/wake, credential restoration, and uninstall on each supported operating system.

For user-led live qualification, use an authorized test site and disposable resources.
Record exact resource identifiers, inspect their saved configuration, and confirm cleanup.
Keep credentials, production data, and test evidence outside source control.

## Diagnose failures

For OpenCode, reproduce the same model with an ordinary CLI invocation before diagnosing account access.
The app uses a dedicated OpenCode agent with approval-required permissions.
Stock noninteractive OpenCode rejects those approval requests; never add auto-approval flags.
The adapter verifies effective agent permissions, rejects disabled or hidden app agents, and disables inherited MCP servers before submitting a prompt.
Changing this launch contract also requires user-led real-model read/write-denial qualification before release.
The installed OpenCode executable and managed configuration remain trusted dependencies.

Start with the user-visible receipt and its command ID.
For request failures, retain the returned error code or reference and the app version.
Server logs suppress authorization headers and omit request query strings from request serialization.
Disconnect requests identify the connection and session generation they intend to close.
A stale request cannot disconnect a newer activation, including a newer session for the same connection.
Unhandled errors return a reference rather than raw internal exception details.

Activity records publication history.
Share only the minimum receipt and log excerpt needed for diagnosis.
Datasource names, field names, and user instructions can be sensitive even when they contain no credentials.
Assistant requests disclose a size-limited prompt containing datasource field metadata, the current metric and slicer configuration, audience settings, conversation and prior proposal context, and new authoring instructions to the configured model provider.
The app does not add Tableau row data or stored Tableau credentials to the authoring prompt.

## Build and release

```sh
npm run tauri:build
```

This builds the app and stages native packaging in a temporary directory, so files used by an already running app are not replaced.
Artifacts are copied to `native-artifacts/` by default.
The native host serves bundled assets and forwards permitted API requests through a restricted native command.
Per-launch secrets are delivered to the child through stdin and remain outside the renderer.
Readiness verifies possession of the secret before normal authenticated requests begin.

The Windows and macOS CI jobs build on their respective platforms.
Public distribution additionally requires the organization's signing identities, macOS notarization access, release ownership, and approved distribution channel.
Keep a record of the exact source revision, runtime versions, artifact checksums, migration evidence, and native qualification results for each release.

### Isolated native validation

`node scripts/build-native.mjs --validation` builds a test app with a unique identifier.
On Windows it produces a portable executable and accompanying resources; on macOS it produces the configured native bundles.
Its app data, WebView profile, single-instance identity, and credential namespace are separate from the installed product.
The evidence file records its exact executable, identifier, and component hashes.

## Receiving engineer exercise

Before accepting ownership, a receiving engineer should complete these tasks using this guide:

1. Add a validated authoring rule and its tests in the owning modules.
2. Diagnose an uncertain publication from its receipt and confirm its remote outcome.
3. Upgrade a copy of a previous database and verify workspace and receipt preservation and the documented legacy draft deletion.
4. Build the installer and complete the platform release checklist.

Record unclear steps and improve the guide before handoff.
