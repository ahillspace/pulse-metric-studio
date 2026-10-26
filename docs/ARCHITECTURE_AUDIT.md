# Architecture audit

This records the 2026-10-25 architecture audit and code review of the current working tree, including configurable local-agent launch commands, chat submission, proposal disclosures, and provider-modal layout.
It supersedes the 2026-10-22 inspection as the current review record.
Use the [maintainer guide](PULSE_MAINTAINER_GUIDE.md) for maintained runtime contracts; findings below are recommendations, not implemented fixes.

## Review summary

The recent composer, proposal-disclosure, and responsive-modal changes are coherent, and independent frontend review found no concrete regression.
The original review classified launcher consent and direct installer shutdown as high-priority findings; the launcher assessment was narrowed after examining the product's trust model.
The follow-up below records that reassessment, completed corrections, and deferred work separately from the original evidence.

## Implementation follow-up and product decisions

The findings and validation below describe the original audit snapshot.
Subsequent product discussion narrowed implementation to demonstrated, low-risk corrections in the existing owners.
The native launcher finding was overstated as an unconditional P1: its proof assumes JavaScript already executing inside the app window, and no external path to that compromise was demonstrated.
User-configured native tools remain intentional, and no additional native launcher approval is planned.

The subsequent working tree corrects automatic discovery while editing a launch command, rejected-argument diagnostics, assistant disclosure, bounded Tableau body reads, and missing/repeated metadata cursors.
It reuses the existing provider editor, CLI adapters, response reader, and pagination loop without introducing new runtime modules, tool restrictions, or a transport framework.
Existing saved definitions can discover on editor mount; new or edited commands require an explicit catalog reload.
In-flight discovery retains its existing deadline and stale-result suppression; cross-IPC cancellation was not added.
The earlier proposed full transport ownership change and arbitrary metadata page budget are outside this correction.

The agreed product direction retains the editor configuration with a fresh chat on app launch, without generalized session restoration or historical-loadout snapshots.
That persistence change is not part of the low-risk corrections recorded here.
For packaging, minimum runtime compatibility and stale-artifact fixes are separable from cross-machine source provenance.
The larger manifest-driven release contract is deferred.
The subsequent runtime correction makes root `package.json` the minimum-version owner and verifies required startup-flag support in packaging, native runtime selection, and the packaged SQLite check.
The subsequent packaging correction gives each build exclusive ownership of the cached target, fresh bundle collection, and staged publication of its current artifact set.
Existing output paths remain compatible, and failed builds preserve the previous output.
Seven actual-CLI fixture tests cover stale files, retained dependency cache, failure preservation, promotion rollback, cleanup, path safety, and lock refusal.
The direct-installer shutdown finding remains open and concerns interruption of automatic persistence, not a missing manual Save action.
Follow-up validation passed 705 Node tests with two platform-specific skips, 26 locked Rust tests, workspace TypeScript checks, the production build, the architecture guard, Rust formatting, and 248 documentation links.
Independent final code review found no unresolved blocker in the agreed changes.
The extra native broker, transport, and updater diffs are standard formatter output with no behavior change.
A subsequent Windows package verified exactly the two current-version installers, the bundled Node/SQLite startup-flag check, installed component hashes, and successful app startup.

## Examined snapshot and scope

Examined on 2026-10-25 in repository `pulse-metric-studio`, root `.`, branch `main`, based on revision `dcc6baaf7f0569c4a00ec00a01c4df2a6493335d`.
The examined system includes the working tree, not only that commit.
The starting dirty tree contains 27 modified tracked files covering local providers, launch-command validation, Pulse authoring, chat and proposal UI, provider settings/layout, tests, and documentation.
Four untracked maintained files are included: `local-agent-runtime.ts` and its test under core providers, and `local-launch-command.ts` and its test under shared contracts.
The existing untracked audit document is also included.
The untracked `docs/BACKLOG.md` is separate user planning material and remains untouched.
Claims about those dirty files must not be attributed to the baseline commit or the published 0.1.3 release.

Scope includes all five workspaces, the Rust desktop host, state and credential boundaries, representative operation families, CI, packaging, installation, updates, release staging, assets, and provider fixtures.
This is a source-based architecture review and documentation reconciliation, not a comprehensive security, dependency-license, vulnerability, or live-system audit.
No source behavior, dependency, generated file, consent setting, release state, or installed app changes are authorized by this audit.

The inventory includes 336 tracked files and the four relevant untracked source/test files.
Ignored dependencies, `.codex` tooling, OpenSpec material, generated native resources/schemas, native build directories, databases, logs, and scratch files are excluded from maintained-source coverage.
Tracked mobile icon variants are generated asset outputs, not evidence of mobile product support.
No maintained plugin or agent-skill distribution appears in the tracked repository; user-installed CLI plugins and skills are external dependencies.

## Canonical documentation map

| Reader need | Canonical owner |
|---|---|
| Product capabilities, installation, and user data boundaries | [README](../README.md) |
| Environment setup, validation, development, packaging, release, and icon generation | [Contributing](../CONTRIBUTING.md) |
| Composition, dependencies, operation traces, trust boundaries, and feature placement | [Maintainer guide](PULSE_MAINTAINER_GUIDE.md) |
| Durable entities, secret references, migrations, and state recovery | [SQLite contract](PULSE_SQLITE.md) |
| Task rules and links to architectural truth | [AGENTS.md](../AGENTS.md), referenced by [CLAUDE.md](../CLAUDE.md) |
| Versioned Tableau fixture provenance and interpretation | [Fixture README](../packages/pulse/src/pulse/fixtures/tableau-cloud/3.27/2026-08-29/README.md) |
| Historical transfer checks | [Transfer verification](TRANSFER_VERIFICATION.md); historical evidence only |
| Review baseline, coverage, recommendations, and unresolved limits | This audit |

The web package [entry page](../packages/web/README.md) links to these owners rather than maintaining a second setup guide.
The maintainer guide's diagram describes inspected composition relationships; it does not establish production deployment or runtime qualification.

## Coverage ledger

`Verified` means representative source, caller, contract, failure, and cleanup paths were traced.
It does not mean tests or live workflows ran during this audit.
`Partly verified` identifies an external contract, divergent path, or runtime limit that source inspection does not settle.
Source links below locate files; named symbols identify the maintained behavior within them.

| Area and owner | Status | Evidence and examined trace | Canonical documentation and limits |
|---|---|---|---|
| Server composition and renderer transport | Verified | [`main`](../packages/server/src/index.ts), [`buildApp`](../packages/server/src/app.ts), [`desktopFetch`](../packages/web/src/desktop-transport.ts), [`PulseTransport`](../src-tauri/src/pulse_transport.rs); feature registration, desktop IPC versus browser HTTP, errors, origin checks, and bounded native bodies | Maintainer guide runtime/trust sections; no hosted deployment or renderer compromise exercise |
| Native startup, ownership, shutdown, and updates | Partly verified | [`main`, `resolve_node_runtime`, `stop_services`](../src-tauri/src/main.rs), [`readDesktopStartup`, `acquireDesktopOwnership`, `superviseDesktop`](../packages/server/src/desktop.ts), [`Updater`](../src-tauri/src/updater.rs), [`subscribeDesktopLifecycle`](../packages/web/src/desktop-lifecycle.ts); readiness, ownership conflict, save/discard/cancel, pending-update cancellation, service exit | Maintainer guide and Contributing; later native setup failures and platform behavior not fault-injected |
| Configuration, SQLite, and migrations | Verified | [`loadRepoEnv`, `config`](../packages/core/src/config.ts), [`getDb`, `registerDbMigrations`](../packages/core/src/db/index.ts), [`PulseRepository`](../packages/pulse/src/persistence/repository.ts), [feature migrations](../packages/pulse/src/persistence/migrations.ts); environment precedence, WAL/FK, revision writes, version rejection, backups, migration failure cleanup | SQLite contract; isolated fixture migrations ran through tests, no user database upgrade or credential access |
| Secret storage and connection lifecycle | Verified | [`CredentialContext`, `start_credential_broker`](../src-tauri/src/credential_broker.rs), [`BrokerSecretVault`, `LocalSecretVault`](../packages/core/src/secrets/vault.ts), [`migrateSavedSecrets`](../packages/core/src/secrets/migration.ts), [`registerTableauRoutes`](../packages/core/src/tableau/routes.ts), [`session.ts`](../packages/core/src/tableau/session.ts); reference ownership, store failures, lost-response reconciliation, activation/disconnect generations | SQLite contract and maintainer guide; no OS-store access or permission-prompt qualification |
| Tableau REST and field metadata | Partly verified | [`tableauFetch`, `readBoundedBody`, `reauthenticate`](../packages/core/src/tableau/rest-client.ts), [`patSignin`](../packages/core/src/tableau/signin.ts), [`getFieldCatalog`](../packages/core/src/tableau/vds-fields.ts), [`metadata-fallback.ts`](../packages/core/src/tableau/metadata-fallback.ts); identity gate, shared refresh, version adaptation, 429 retry, VDS/GraphQL fallback, cache scope | Maintainer guide connection trace; body-limit bypass and cursor follow-ups below; no live compatibility or performance claim |
| Provider profiles, readiness, APIs, and credentials | Verified | [`ProviderRegistry`](../packages/core/src/llm/registry.ts), [`DbLlmProfileStore`](../packages/core/src/llm/profiles.ts), [`registerLlmRoutes`](../packages/core/src/llm/routes.ts), [`HttpLlmProvider`](../packages/core/src/llm/providers/openai-compat.ts), [`BedrockProvider`](../packages/core/src/llm/providers/bedrock.ts), [`resolveCredentialCommand`](../packages/core/src/llm/providers/credential.ts), [`guardedFetch`](../packages/core/src/llm/providers/guarded-fetch.ts); saved-profile precedence, explicit selection, current health before readiness, semantic completion tracking, redaction, endpoint policy, shutdown | Maintainer guide provider section; SDK credential-process cancellation and account identity limits remain explicit |
| Native local agents and launch commands | Partly verified | [Codex](../packages/core/src/llm/providers/codex-cli.ts), [Claude Code](../packages/core/src/llm/providers/claude-code.ts), [OpenCode](../packages/core/src/llm/providers/opencode-cli.ts), [runtime helper](../packages/core/src/llm/providers/local-agent-runtime.ts), [shared parser](../packages/shared/src/local-launch-command.ts), [`collectProcessOutput`](../packages/core/src/llm/providers/process-tree.ts); executable/prefix parsing, legacy paths, native configuration inheritance, headless/model/output framing, tool/final-event distinction, genuine errors, deadlines, process-tree cleanup | Maintainer guide and README; arbitrary launcher consent gap below; native authentication and billing routes remain user-controlled; no live CLI/account/tool qualification |
| Provider settings and chat presentation | Verified | [`LlmBadge` and `ProfileEditor`](../packages/web/src/components/LlmSettings.tsx), [scoped layout](../packages/web/src/components/llm-settings.css), [`WorkbenchModal`](../packages/web/src/components/workbench.tsx), [`ChatPanel`](../packages/web/src/features/pulse/components/ChatPanel.tsx), [`ProposalReview`](../packages/web/src/features/pulse/author/ProposalReview.tsx); model-load sequencing, busy/error states, viewport-constrained grids, synchronous accepted-send clearing, newer typing preservation, new-response disclosure remount | Maintainer guide; current focused/whole-workspace tests inspected and run; earlier manual browser checks are prior evidence, not a new audit UI exercise; disclosure wording issue below |
| Authoring, proposals, and draft state | Verified | [`createAuthorController`](../packages/web/src/features/pulse/author/controller.ts), [`PulseProposalService`](../packages/pulse/src/application/proposals.ts), [`authorOps`](../packages/pulse/src/llm-authoring.ts), [shared merge rules](../packages/shared/src/pulse-proposal.ts), [workflow routes](../packages/pulse/src/http/workflow-routes.ts); unsaved input, serialized saves, revision conflicts, locks, stale results, final schema parsing and one repair | Maintainer guide and SQLite contract; prompt instructions do not enforce an OS security boundary or tool-action transaction |
| Publication and optional digest following | Verified | [`PulsePublishService`](../packages/pulse/src/application/publish.ts), [serializer](../packages/pulse/src/adapters/tableau/serializer.ts), [`PulseRepository.admit`](../packages/pulse/src/persistence/repository.ts), [`createDefinition` and `resolveDefaultMetricId`](../packages/pulse/src/pulse/pulse-client.ts), [group operations](../packages/pulse/src/pulse/groups.ts); fresh metadata, fingerprinted review, durable intent before sends, confirmed/unknown/unsent outcomes, default-metric resolution, group/membership/subscription failure paths | Maintainer guide publication/recovery and SQLite contract; remote operations and local transactions are not atomic |
| Activity, undo, and receipt-owned group removal | Verified | [Activity controller](../packages/web/src/features/pulse/activity/controller.ts), [`PulsePublishService.undo`, `deleteCreatedGroup`](../packages/pulse/src/application/publish.ts), [`PulseRepository.clearReceipt`](../packages/pulse/src/persistence/repository.ts); offline reads, stale selection, exact created IDs, 404, ownership checks, uncertainty retention | Maintainer guide recovery and SQLite contract; undo is compensating deletion, not remote rollback |
| Inventory and variants | Verified | [`getExistingMetrics`, inventory cache](../packages/pulse/src/application/inventory.ts), [`PulseDimensionalForkService`](../packages/pulse/src/pulse/dimensional-fork-service.ts), [`PulseForkPlanService`](../packages/pulse/src/pulse/fork-plan-service.ts), [variant rules](../packages/pulse/src/domain/variants.ts), [registry controller](../packages/web/src/features/pulse/registry/controller.ts); partial visibility, exact metric ownership, current VDS fields, targeted value checks, date-only plans, per-source outcomes | Maintainer guide Metric Manager; nested concurrency is bounded but throughput is not benchmarked |
| Subscriptions and planned deletion | Verified | [`followTargets`, `unfollowTargets`, follower readers](../packages/pulse/src/application/subscriptions.ts), [`PulseDeletionService`](../packages/pulse/src/application/deletion.ts), [`executeDeletes`](../packages/pulse/src/application/delete-execution.ts); exact pairs/IDs, current scope fingerprint, default-definition review, explicit incomplete-scope override, auth/ambiguity stops, partial outcomes | Maintainer guide Metric Manager; registry command results are not durable across restart |
| Metric preview | Partly verified | [`previewPulseMetric`](../packages/pulse/src/application/metric-preview.ts), [insight/PNG mapping](../packages/pulse/src/pulse/metric-preview.ts), [preview controller](../packages/web/src/features/pulse/registry/preview-controller.ts); context verification, stage errors, insight selection, byte/pixel/CRC limits, stale response discard | Maintainer guide preview section; no live image/API compatibility confirmation |
| Build, quality gates, and dependencies | Verified | [workspace scripts](../package.json), [CI](../.github/workflows/ci.yml), [`discoverTests`](../scripts/run-tests.mjs), [`inspectPulseBoundary`](../scripts/check-pulse-architecture.mjs), [npm lock](../package-lock.json), [Rust manifest](../src-tauri/Cargo.toml); build order, per-file isolated data, JavaScript versus native jobs, actual guard patterns | Contributing; no root lint gate; exact resolutions do not establish exhaustive license or vulnerability review |
| Packaging, install, release, and update helpers | Partly verified | [`build-native.mjs`](../scripts/build-native.mjs), [`composeResources`](../scripts/copy-resources.mjs), [`bundleServer`](../scripts/bundle-server.mjs), [`verifyPackagedSqlite`](../scripts/node-runtime.mjs), [`stage-release.sh`](../scripts/stage-release.sh), [Windows](../scripts/install.ps1) and [macOS](../scripts/install.sh) installers; staging, Node/SQLite pairing, checksums, recorded channel, replacement failure, uninstall retention | Contributing; no artifact build, installation, remote release, signing, or cross-platform qualification during this audit |
| Assets and ancillary fixtures | Verified | [`render-icons.mjs`](../scripts/render-icons.mjs), [icon asset tests](../scripts/icon-assets.test.mjs), [fixture README](../packages/pulse/src/pulse/fixtures/tableau-cloud/3.27/2026-08-29/README.md), [Tauri configuration](../src-tauri/tauri.conf.json); active PNG inputs, generated platform icons, versioned sanitized contract fixtures | Contributing and fixture-local README; design SVGs are not the current icon generator input |
| Distributed services, maintained plugin packages, mobile app, and production telemetry | Not applicable | Tracked inventory and composition expose a local desktop/backend system, optional external CLIs, and structured logs; no maintained deployments or packages for these additional systems | Do not infer support from generated icons, optional CLI plugins, or transitive dependencies |

## Findings and recommendations

These are proposed source changes, not implemented behavior or authorization to change it.
The command-approval bypass, Windows installer shutdown, response-limit bypass, and malformed metadata pagination were reproduced with isolated local probes during this audit.
No probe used a real credential store, live AI/Tableau service, or real application termination.
Priority reflects observed user impact and preservation of existing contracts.

### P1 - New local launch commands bypass native command approval

Classification: introduced security-boundary regression; high confidence.
[`registerLlmRoutes`](../packages/core/src/llm/routes.ts) accepts unsaved launch commands on the setup status and model-catalog GET endpoints.
[`ProviderRegistry.setupStatus` and `listSetupModels`](../packages/core/src/llm/registry.ts) construct providers that execute those commands, and the native [API transport](../src-tauri/src/pulse_transport.rs) permits the provider route family.
An interpreter wrapper can execute arbitrary code before responding to the appended help or model arguments.
The existing [`assertApproved`](../packages/core/src/llm/providers/credential.ts) protects HTTP credential helpers against arbitrary commands introduced by a compromised renderer, but local launch commands do not use an equivalent boundary.

The offline route-to-real-child probe configured a native credential approver that denied every request.
A setup GET still ran a harmless wrapper and created an ignored marker with zero approval calls.
The precondition is a compromised renderer or equivalent caller of its native API surface; ordinary authenticated desktop traffic from another browser remains a separate boundary.
This finding concerns introducing a new executable definition, not the explicitly accepted ability of an approved local agent to use its native tools and instructions.

Require native consent once for a new or changed resolved launcher definition, shared across setup, model discovery, status, and completion.
Preserve arbitrary executable wrappers and native tool permissions after that decision; do not add per-tool app approval or force safe mode.
An illustrative execution boundary is:

```ts
// Proposed shared boundary, not an existing helper.
await requireApprovedLocalLaunch(launch, signal);
return runLocalProcess(launch, request);
```

Keep browser-development policy explicit and avoid a separate approval implementation in every adapter.
The related [`ProfileEditor.loadModels`](../packages/web/src/components/LlmSettings.tsx) effect also runs model discovery after every unsaved launch-command edit.
Its sequence counter discards old results without canceling the corresponding requests or subprocesses.
For OpenCode, editing a wrapper can consequently execute it repeatedly before the definition is committed.
Use an explicit setup/catalog action for changed definitions and carry cancellation through discovery; adding consent without correcting this workflow would instead produce prompts on keystrokes.
Verify denial, approval reuse, changed executable/prefix arguments, cancellation during approval, unsaved setup commands, and all three CLI adapters with real local child fixtures.
An enforced equivalent native launcher approval before these routes would disprove the bypass; none was found.

### P1 - Direct installer helpers override canceled or blocked shutdown

Classification: preexisting data-loss defect newly reproduced in this audit; high Windows confidence, macOS source evidence.
[`Stop-PulseMetricStudio`](../scripts/install.ps1) requests normal close, waits ten seconds, then force-terminates remaining app processes.
[`quit_running_app`](../scripts/install.sh) similarly signals a remaining process after its grace period.
These paths do not distinguish a slow exit from the renderer intentionally keeping the app open after canceled shutdown or failed draft saving.
Direct helper installation or uninstall can therefore discard unsaved work and proceed despite that decision.
The ordinary in-app update first completes the normal shutdown handshake and honors cancellation; do not generalize the defect to that successful flow.

An offline probe extracted the actual Windows function and supplied a still-running fake process after normal close.
It confirmed that forced termination was requested without stopping a real process.
Abort ordinary installation when normal shutdown does not finish, and restrict process discovery to the intended installation.
For example, replace unconditional force termination with a failure before replacement:

```powershell
if (Get-Process -Name 'pulse-metric-studio' -ErrorAction SilentlyContinue) {
    Fail 'Pulse Metric Studio is still running. Finish saving and close it, then try again.'
}
```

Apply the equivalent fail-before-replacement policy on macOS.
Preserve app data, credentials, channel recording, checksum checks, and updater error recovery.
Verify canceled close, failed saving, delayed successful close, and another running installation with process doubles, followed by user-led platform qualification.

### P2 - Metadata pagination accepts an incomplete catalog or repeats indefinitely

Classification: preexisting correctness and resource-bound defect; high confidence.
[`fetchGraphqlNodes`](../packages/core/src/tableau/metadata-fallback.ts) has no repeated-cursor guard and returns accumulated nodes when `hasNextPage` is true but the next cursor is absent.
Its caller then presents that prefix as an ordinary successful field catalog.
A repeated-cursor fixture produced continuation inputs `[null, "repeat", "repeat", "repeat"]` until the fixture stopped the loop.
A missing-cursor fixture returned one measure as a successful metadata catalog despite advertising another page.

Make authoritative catalog discovery reject malformed pagination or report partialness explicitly, and enforce a finite page/read budget.
A minimal guard is:

```ts
const next = pageInfo.endCursor;
if (hasNextPage && (typeof next !== 'string' || !next || seenCursors.has(next))) {
  throw new TableauError('Field metadata pagination is incomplete.', 502);
}
if (hasNextPage) seenCursors.add(next);
```

Preserve authentication errors and the separate intentional best-effort caption-map behavior.
Verify repeated/missing cursors, valid multi-page results, page budgets, and unavailable metadata.

### P2 - The assistant disclosure omits the local-tool boundary

Classification: current user-facing contract mismatch exposed by the provider changes; high confidence.
[`ChatPanel`](../packages/web/src/features/pulse/components/ChatPanel.tsx) says row data and credentials are not included and proposed changes require acceptance, without qualifying local tool actions.
The README and settings correctly state that local agents can retrieve additional data and make direct changes outside app review.
The disclosure can therefore give a reader a stronger privacy and review guarantee than the current integration provides.

Describe the app-supplied prompt separately from native tool effects, for example:

```text
The app sends field metadata, metric settings, and this conversation.
Local agents can retrieve additional data and act through their configured tools.
Draft proposals require acceptance; direct tool actions take effect outside app review.
```

Keep the native-tool policy unchanged and check the disclosure for both API and local providers.

### P2 - Invalid launch arguments masquerade as missing JSON support

Classification: introduced diagnostic regression; high confidence for the installed Codex CLI.
[`CodexCliProvider.check`](../packages/core/src/llm/providers/codex-cli.ts) and [`ClaudeCodeProvider.check`](../packages/core/src/llm/providers/claude-code.ts) combine a nonzero help exit with missing protocol flags into one unsupported-protocol error.
The installed Codex parser rejects `--sandbox -read-only` with exit code 2, while `--sandbox read-only` succeeds and exposes every required app flag.
The app therefore recommends a CLI update for a launch-command typo, obscuring the actual remedy.
Distinguish rejected launch configuration from successful help output that lacks a required capability, without echoing untrusted or secret-bearing stderr:

```ts
if (help.code !== 0) {
  throw this.error('provider_not_configured', 'Codex rejected the launch options. Check Launch command.');
}
if (!REQUIRED_FLAGS.every(flag => help.stdout.includes(flag))) {
  throw this.error('provider_execution', 'Update Codex CLI to use the required noninteractive JSON protocol.');
}
```

Verify both branches and retain sanitized authentication, quota, and execution diagnostics for actual requests.

### P2 - Response limits have bypass paths

Classification: current reliability risk; high source confidence.
[`tableauFetch`](../packages/core/src/tableau/rest-client.ts) reads `resp.clone().text()` for versioned 404 inspection before the common bounded body reader.
[`discoverRestApiVersion`](../packages/core/src/tableau/signin.ts) and current-user reads in [`routes.ts`](../packages/core/src/tableau/routes.ts) also use raw JSON body readers.
Large responses can exceed the stated normal body-size cap in these paths, affecting connection setup, status, and any operation that triggers version adaptation.
An offline probe supplied a 65,543-byte versioned 404 followed by `{}` to a caller with an eight-byte response cap.
The call consumed the oversized diagnostic response and succeeded instead of rejecting it.

Make bounded response reading the common primitive for diagnostics, discovery, user information, and normal results; remove the bypass readers.
Preserve credential redaction, best-effort names, single-flight refresh, version fallback, and the separate read/mutation retry rules.
Verify oversized and stalled chunked versioned 404, server-info, and current-user fixtures.
Thread the caller's limit into the diagnostic path rather than imposing only the larger default:

```ts
const text = await readBoundedBody(resp.clone(), maxResponseBytes, timeoutMs);
```

Existing bounds tests use different response paths; an effective upstream cap covering these reads would disprove the risk, but none was found.

### P2 - Packaging and startup disagree on supported Node versions

Classification: current compatibility defect; high source confidence.
Follow-up status: corrected in the subsequent working tree by deriving both checks from root package metadata and inspecting executables with the required startup flag.
[`assertSupportedNode`](../scripts/node-runtime.mjs) and npm engines accept Node 22.0+, while native [`supported_node_runtime`](../src-tauri/src/main.rs) requires 22.15+ for `--use-system-ca`.
Windows packaging can accept a runtime that the installed launcher rejects when no other compatible runtime exists.
The pinned CI version does not exercise that boundary.
The real JavaScript policy accepted `22.14.0` in an offline probe, while the native test explicitly rejects it.

Use one maintained, platform-aware runtime support policy across preinstall, resource composition, native startup, and their tests.
Preserve the pinned Node 22 macOS compatibility policy and the packaged Node/SQLite round trip.
Verify 22.14, 22.15, the pinned version, and permitted newer majors without launching a production app.
Also probe the actual required startup flag when validating a candidate executable:

```js
spawnSync(executable, ['--use-system-ca', '--version'], { timeout: 10000 });
```

A packaging check exercising the actual launch flag could disprove this gap; the inspected check does not.

### Registry mutations lack durable command recovery

Classification: recovery design gap; high confidence.
The [registry controller](../packages/web/src/features/pulse/registry/controller.ts) retains variant, subscription, and deletion outcomes in memory.
Their application services do not admit commands through `PulseRepository` before remote effects.
Restart loses the reviewed target list and unknown outcomes, while publication retains durable intent and receipts.

Add durable registry command admission and outcomes in application/persistence services, readable through Activity.
Keep variant, subscription, and deletion policies separate; share the evidence lifecycle rather than inventing a generic mutation engine.
Preserve exact IDs, created/reused distinctions, reviewed deletion fingerprints, partial/unknown/unsent states, and no automatic replay.
Verify process interruption and lost responses for each mutation family before implementation.
An undiscovered persistent registry store could disprove the gap; no such schema or caller appears in the traced paths.

### Two authoring entry points own different contracts

Classification: ownership and simplification opportunity; high confidence.
[`registerLlmRoutes`](../packages/core/src/llm/routes.ts) still exposes `/api/llm/author`, wired by server composition, and truncates the supplied message and chat.
The current web flow uses [`PulseProposalService`](../packages/pulse/src/application/proposals.ts) through Pulse workflow routes, with a context-bound document and catalog.
The older registered route has test and shared-contract references, so it cannot be declared unused or removed without a compatibility decision.

Make Pulse application workflows the sole owner of feature-specific authoring behavior and remove the feature callback from core provider administration.
Keep a documented compatibility adapter if the older endpoint has required consumers, then retire it through an explicit compatibility plan.
Preserve proposal merge rules, unsaved input, account readiness tracking, output validation, and external request compatibility.
Verify both endpoint families, search external integration/consumer evidence, and test large messages before removing truncation or routing.
Required independent consumers of the generic route could justify retaining the surface, but not silently divergent guarantees.

### Variant discovery and execution duplicate source policy

Classification: simplification opportunity; high confidence.
[`PulseDimensionalForkService.resolveContext`](../packages/pulse/src/pulse/dimensional-fork-service.ts) and [`PulseForkPlanService.resolveSource`/`resolveClauses`](../packages/pulse/src/pulse/fork-plan-service.ts) independently resolve exact metrics, enforce ownership, load catalogs, and compute common eligible dimensions.
Both are live route consumers, and duplicated rules can drift between discovery and execution.

Extract one source-context resolver and reusable eligibility rules, retaining each caller's failure policy.
Discovery's whole-request errors and creation's per-source results must remain distinct.
Preserve date-only requests without dimension metadata, VDS/domain checks, ambiguous-name rejection, source specification cloning, and diagnostic contracts.
Verify shared fixtures with unavailable or mismatched sources, duplicate names, missing dimensions, and date-only plans.
Reject the extraction if source investigation shows those policies cannot share a cohesive boundary.

### Release staging cannot establish shared provenance

Classification: delivery assurance gap; high confidence.
[`build-native.mjs`](../scripts/build-native.mjs) records component hashes but no Git revision or dirty-source declaration.
[`stage-release.sh`](../scripts/stage-release.sh) accepts version-matching filenames without checking source identity or a required platform set.
A staged release can combine different snapshots or omit a target while passing those checks.

Create a build manifest with source identity, dirty-state declaration, platform, version, and hashes; make staging validate the required manifests.
Preserve helper channel rewriting, installer naming, checksum compatibility, and existing distribution targets.
Verify mixed revisions, stale versions, missing architectures, and hash mismatches using isolated staging fixtures.
A required external release gate with equivalent evidence could reduce this gap, but none appears in repository wiring.

### P2 - Native artifact collection includes stale output

Classification: build isolation risk; high confidence.
Follow-up status: corrected in the subsequent working tree through exclusive target ownership, fresh bundle collection, and transactional publication of the current output set.
[`build-native.mjs`](../scripts/build-native.mjs) creates unique source stages but reuses fixed temporary Cargo targets and copies their entire `release/bundle` directory.
Existing destination output is not required to be empty.
Concurrent builds or stale bundles can contaminate collected artifacts, and successful temporary source stages are retained.
The current local build evidence actually inventories 0.1.0 installers alongside the newly built 0.1.3 installers.
This proves stale collection, although concurrent-build contamination was not exercised.

Give each build explicit target/output ownership, either with a lock and current-artifact collection or with unique roots.
Define successful-stage cleanup while retaining failed stages for diagnosis.
Reject a contaminated output directory before collecting artifacts, for example:

```js
if (fs.existsSync(output) && fs.readdirSync(output).length) {
  throw new Error('Native artifact output must be empty.');
}
```

This guard must accompany target ownership or current-build artifact selection; it does not by itself fix a stale shared Cargo bundle directory.
Preserve dependency caching, validation identifiers, hashes, and failure evidence.
Verify concurrent builds and injected stale artifacts without installing them.
This audit did not exercise concurrency; an external serialization guarantee would narrow the concurrency risk but would not remove stale-output ambiguity.

## Documentation corrections and open questions

The maintained pages separate durable publication receipts from transient registry and local-agent outcomes.
They distinguish desktop request authentication from browser development origin checks and renderer abort from actual backend cancellation.
The SQLite contract documents deliberate legacy-profile/oversized-secret removal and the non-atomic credential migration across stores.
Those destructive compatibility policies are established by existing migration tests; they are not newly inferred accidental defects.
The contributor guide distinguishes inspected build/release procedures, historical qualification, signing defaults, channel-record behavior, and the current direct-helper forced-shutdown limitation.
Manual setup preserves an existing channel; it does not create one.
No blanket guarantee remains that startup never accesses credentials or that a script download bypasses every OS trust prompt.
This follow-up corrects the audit baseline and local-provider consent/capability description and adds direct settings/schema/route navigation to the maintainer guide.
Agent instructions already point to canonical owners and preserve native CLI inheritance; no new policy or approval gate was added to those instructions.

The updater offers a detected version but resolves `latest` again after shutdown.
[`Updater.request` and `installer_command`](../src-tauri/src/updater.rs) do not retain/pass the offered version.
Decide whether that latest-at-apply behavior is intentional or whether the offered version should be pinned; preserve channel ownership, close cancellation, checksum validation, and recovery either way.

Renderer registry caches use draft ownership coordinates rather than the active Tableau principal or session generation.
A same-profile credential replacement can change the principal without an intermediate disconnected render.
Verify cache invalidation on that transition before claiming principal-sensitive frontend cache isolation; backend request-generation checks remain a distinct protection.
The native broker's connection concurrency and later startup-failure cleanup also need focused resource/fault exercises before stronger operational claims.
No standalone vulnerability is claimed solely from HMAC body omission or broker thread structure.

## Validation record

| Check performed during this audit | Result |
|---|---|
| Local documentation links and Markdown anchors | Pass; 248 local links/anchors across 10 entry/canonical documents; external URLs excluded |
| Plain dashes and Git whitespace | Pass; `git diff --check` reports no whitespace errors |
| Source preservation | Pass; all 331 recorded non-documentation file hashes match the starting working tree |
| Node workspace tests | Pass; 684 passed, 2 platform-specific tests skipped on Windows |
| TypeScript and production build | Pass; `npm run typecheck` and `npm run build` |
| Architecture guard | Pass; `npm run check:architecture` |
| Locked Rust tests | Pass; 26 tests using the CI-equivalent resource-free `TAURI_CONFIG`, without composing or replacing installed resources |
| Isolated defect probes | Confirmed launcher execution without native approval, Windows helper forced termination after blocked close, REST diagnostic size-cap bypass, repeated GraphQL cursors, and successful incomplete catalog output |
| Independent fresh-reader exercise | Pass; proposal trace, provider-setting placement, configuration precedence, recovery, trust boundary, and validation commands cross-checked against source; added navigation links independently rechecked |
| Mermaid diagram | Relationships and syntax inspected; not rendered because a Mermaid CLI is unavailable |

The fresh reader found no factual contradiction or frontend regression in the exercised paths and identified the corrected provider-settings navigation gap.
Native inheritance and the optional Claude safe-mode example were checked against current primary [CLI documentation](https://code.claude.com/docs/en/cli-reference) and [configuration troubleshooting](https://code.claude.com/docs/en/debug-your-config#test-against-a-clean-configuration).
That mode does not establish default-system-prompt removal, disable built-in tools, or override managed policy.
Codex and OpenCode help/parser invocations ran without inference; Claude is not installed locally.
External links, vendor entitlements, licenses, dependency vulnerabilities, and live API compatibility were not exhaustively revalidated.
Setup, native packaging, installation, publication, signing, and macOS runtime behavior were inspected rather than executed during this audit.
No live Tableau/model/AWS calls, real application termination, native credential access, source fixes, installed-app changes, or remote mutations occurred.
Prior conversation builds and browser qualification are not counted as new audit checks.
Offline protocol fixtures and these representative source traces do not establish an exhaustive security audit or live-provider certification.
