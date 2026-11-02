# Improvement validation

This report records the implementation dispositions and focused evidence for `fix/application-audit-followup`.
The starting commit is `80fd522f97d2e97208083672dc7bbcef2cc366d1`.
That base includes merged cached-deletion PR #1 and M1, its explicit-refresh correction while follower enrichment remains pending.
The [registry regression tests](../packages/web/src/features/pulse/registry/controller.test.ts) preserve that correction.
R02 is committed as `492c7b2`; the final pull request records the complete examined revision and independent review result.
This report supplements the [maintainer guide](PULSE_MAINTAINER_GUIDE.md) and [historical architecture audit](ARCHITECTURE_AUDIT.md).

## Required findings

All R01-R17 findings are confirmed and fixed in the examined implementation.
The evidence below uses deterministic fixtures, fake services, deferred responses, and permitted component/controller tests.
Native workflows and real provider access remain unqualified by these checks.
Proposal validation warnings contain at most 20 entries of 500 characters each.

| ID | Resulting behavior | Source and regression evidence |
| --- | --- | --- |
| R01 | Bounded pagination retains partial results on failed or malformed pages, repeated tokens, and limits; deletion and visibility consume explicit completeness. | [Metric adapter](../packages/pulse/src/pulse/pulse-client.ts), [pagination tests](../packages/pulse/src/pulse/metric-pagination.test.ts), [snapshot tests](../packages/pulse/src/application/inventory-snapshots.test.ts) |
| R02 | Direct helpers stop before replacement or removal when automatic close exceeds its wait, preserving the running app and keep-open decisions. | [Windows helper](../scripts/install.ps1), [macOS helper](../scripts/install.sh), [actual helper-flow tests](../scripts/installer-shutdown.test.mjs), [lifecycle tests](../packages/web/src/desktop-lifecycle.test.ts) |
| R03 | Dispatch ownership prevents old ordinary or receipt-based authentication failures from expiring replacement sessions; matching current-owner rejection still expires authentication. | [API client](../packages/web/src/features/pulse/api/client.ts), [session events](../packages/web/src/features/pulse/shell/session-events.ts), [API regressions](../packages/web/src/features/pulse/api/client.test.ts) |
| R04 | Status separates reachability from authentication, preserving sessions on transient failures and clearing only definitive matching-owner authentication failures. | [Connection routes](../packages/core/src/tableau/routes.ts), [status/session tests](../packages/core/src/tableau/rest-client.test.ts), [connection UI tests](../packages/web/src/features/pulse/connections/controller.test.ts) |
| R05 | Complete list records include ownership, specification, and a boolean default flag; summaries request counts while visible details request identities. | [Inventory](../packages/pulse/src/application/inventory.ts), [list-record tests](../packages/pulse/src/application/inventory-list-records.test.ts), [follow-summary tests](../packages/pulse/src/pulse/follow-summary.test.ts), [consumer tests](../packages/web/src/features/pulse/registry/controller.test.ts) |
| R06 | Stable owner/datasource/session coordinates control loading. Unchanged-context edits, automatic-write acknowledgments, and assistant acceptance do not refresh remote inventory across TTL expiry. | [Shell](../packages/web/src/features/pulse/PulseApp.tsx), [registry controller](../packages/web/src/features/pulse/registry/controller.ts), [fake-clock regressions](../packages/web/src/features/pulse/registry/controller.test.ts) |
| R07 | Follow and unfollow reconcile only affected IDs while retaining inventory and unrelated relationships, including after lost responses or navigation. | [Registry mutations](../packages/web/src/features/pulse/registry/controller.ts), [405-metric and uncertain-outcome tests](../packages/web/src/features/pulse/registry/controller.test.ts) |
| R08 | Owner/source contexts share dimension discovery, preserve catalog provenance, and use exact datasource lookup; execution still validates fresh metadata and ownership. | [Dimension service](../packages/pulse/src/pulse/dimensional-fork-service.ts), [catalog adapter](../packages/core/src/tableau/vds-fields.ts), [real adapter-flow tests](../packages/pulse/src/pulse/dimension-context-api.test.ts), [catalog tests](../packages/core/src/tableau/vds-fields.test.ts) |
| R09 | One metric sends one bounded mixed-recipient envelope, with identity-matched outcomes and explicit unknown or unattempted results instead of replaying ambiguous writes. | [Subscription orchestration](../packages/pulse/src/application/subscriptions.ts), [batch adapter tests](../packages/pulse/src/pulse/subscription-batches.test.ts) |
| R10 | Operation/session ownership evidence persists after success; only unresolved listings repeat, and visibility timeout never authorizes repeating creation. | [Reconciliation](../packages/pulse/src/pulse/reconciliation.ts), [reconciliation tests](../packages/pulse/src/pulse/reconciliation.test.ts), [fork tests](../packages/pulse/src/pulse/fork-plan-service.test.ts) |
| R11 | Returning A -> B -> A shares A's pending request; settled failures permit retry, and obsolete responses cannot replace the current display. | [Registry request ownership](../packages/web/src/features/pulse/registry/controller.ts), [navigation regressions](../packages/web/src/features/pulse/registry/controller.test.ts) |
| R12 | Publication previews retain receipt/owner scope through unrelated inventory replacement and canceled confirmations; explicit refresh and relevant receipt or ownership changes still regenerate them. | [Publication results](../packages/web/src/features/pulse/author/PublicationResult.tsx), [published metrics](../packages/web/src/features/pulse/author/PublishedMetrics.tsx), [real confirmation tests](../packages/web/src/features/pulse/author/publication-preview-cache.test.tsx) |
| R13 | Inventory, previews, directories, catalogs, membership, and pending reads partition by relevant owner and authenticated generation. Reconnection cannot silently reuse old follower state or review authority. | [Session cache key](../packages/pulse/src/application/session-cache-key.ts), [backend ownership tests](../packages/pulse/src/application/inventory-snapshots.test.ts), [frontend ownership tests](../packages/web/src/features/pulse/registry/controller.test.ts) |
| R14 | Workspace-hosted dialogs and controller admission block new mutations while closing or unavailable; cancellation restores admission, and existing operations retain their outcomes. | [Variant dialog](../packages/web/src/features/pulse/registry/VariantDialog.tsx), [controller admission tests](../packages/web/src/features/pulse/registry/controller.test.ts), [dialog tests](../packages/web/src/features/pulse/registry/variant-admission.test.tsx) |
| R15 | Mixed-validity replies retain accepted operations, bounded warnings, and corrected narration through chat and review; all-invalid replies retain the repair/failure path. | [Parser tests](../packages/pulse/src/llm-authoring.test.ts), [service/contract tests](../packages/pulse/src/application/proposals.test.ts), [warning renderer tests](../packages/web/src/features/pulse/author/proposal-warnings.test.tsx) |
| R16 | Stable profiles reuse Bedrock clients and SDK credentials without redundant preflights; SDK refresh remains active, and retired clients drain admitted requests before disposal. | [Bedrock adapter](../packages/core/src/llm/providers/bedrock.ts), [installed-SDK credential fixture](../packages/core/src/llm/providers/bedrock.test.ts), [registry lifecycle tests](../packages/core/src/llm/registry.test.ts) |
| R17 | Per-profile ownership spans reference resolution, validation, vault writes, SQLite, and cleanup, including deletion; shared-Db instances serialize matching IDs while unrelated IDs progress. | [Profile store](../packages/core/src/llm/profiles.ts), [registry](../packages/core/src/llm/registry.ts), [overlapping real-store/HTTP tests](../packages/core/src/llm/profiles.test.ts) |

Registry/dimension requests also carry an optional captured `expectedOwner`; a backend owner mismatch returns HTTP 409 before provider work.
The [admission tests](../packages/pulse/src/pulse/session-admission.test.ts) cover queued old-owner requests and malformed owner input.
Omitted owners retain legacy compatibility; cached deletion continues to use its existing snapshot authority.

## Additional observations

These IDs follow the nine observations in the implementation brief, in their original order.

| ID | Disposition | Evidence and scope |
| --- | --- | --- |
| O01 | Confirmed and fixed | Negotiation makes forward progress and commits only successful versions; [regressions](../packages/core/src/tableau/rest-client-throttle.test.ts) retain the synthetic-404 evidence limit. |
| O02 | Confirmed and fixed | Provider delay beyond the local deadline returns unavailable without early retry; [throttle tests](../packages/core/src/tableau/rest-client-throttle.test.ts) cover shared identity deferral. |
| O03 | Confirmed and fixed | Passive configuration status uses `installed:null` for unchecked CLIs; [registry](../packages/core/src/llm/registry.test.ts) and [renderer tests](../packages/web/src/components/llm-passive-status.test.tsx) preserve explicit testing. |
| O04 | Confirmed and fixed | Directories share bounded owner/session state across mounts, while explicit refresh and session changes reload them; [directory tests](../packages/web/src/features/pulse/registry/controller.test.ts) preserve freshness. |
| O05 | Confirmed and fixed | Continuous native log rotation bounds active files and two archives; [fixed-buffer stream tests](../src-tauri/src/bounded_log.rs) cover oversized files, bursts, sink failure, and shutdown. |
| O06 | Confirmed and fixed | Source identity and sanitized evidence prevent mixed-source or conflicting-byte promotion; [provenance](../scripts/release-provenance.test.mjs), [staging](../scripts/stage-release.test.mjs), and [build tests](../scripts/build-native.test.mjs) cover the contract. |
| O07 | Reviewed; no product defect established | Validation remains local under [Contributing](../CONTRIBUTING.md), with no hosted service, repository setting, or new formatting/lint policy enabled. |
| O08 | Confirmed parsing defects fixed; broader cleanup deferred | [Group parsing](../packages/pulse/src/pulse/groups.test.ts) avoids unintended creation, and [malformed legacy author requests](../packages/core/src/llm/routes.test.ts) return HTTP 400 while compatibility routes remain. |
| O09 | Confirmed and fixed | Canonical destination specification plus definition ID deduplicates writes and creation/undo ownership; [fork-plan tests](../packages/pulse/src/pulse/fork-plan-service.test.ts) cover source mapping and outcomes. |

The R09 envelope follows the [official Tableau Pulse methods reference](https://help.tableau.com/current/api/rest_api/en-us/REST/rest_api_ref_pulse.htm).
The 200-recipient request bound is a local app limit, not a claimed Tableau maximum.
A batch-level conflict does not establish that every recipient already follows.

## Measured request changes

Tableau counts come from production adapters with deterministic provider fixtures.
The inventory comparison uses the same complete metric records and the same pagination adapter in both phases.
It isolates list reuse and initial relationship loading policy; missing pages do not count as savings.

| Fixture or boundary | Before | After |
| --- | --- | --- |
| 20 definitions, 200 complete metrics, initial summary | 423 requests | 22: 1 definition page + 20 metric lists + 1 count batch |
| 20 definitions, 405 complete metrics, initial summary | 835 requests | 24: 1 definition page + 20 metric lists + 3 count batches |
| Three mixed recipients following one metric | 3 POSTs | 1 POST |
| Five visibility attempts with immediate exact ownership | 5 exact metric reads + 5 parent reads + 5 lists | 1 exact metric read + 1 parent read + 5 lists |
| Unchanged two-source fields/count/values/search | 4 catalog loads | 1 catalog load; 8 necessary adapter calls, including 3 data queries |
| Two sources with the same destination | 2 get-or-create POSTs | 1 POST; 2 mapped results and 1 creation owner |
| One ordinary Bedrock completion | 3 credential-process invocations | 1; repeated valid completion remains at 1 cumulative invocation |
| Bedrock credential expiration | No reuse guarantee | SDK refresh increases the cumulative count to 2 and the next completion succeeds |

The inventory reductions intentionally change initial detail availability.
The earlier path reconstructs exact metrics and eagerly loads membership and follower identities.
The new path supplies complete inventory and count summaries first; visible rows and actions request relationship detail when needed.
The **Only followed** filter requests candidate relationships; **Add existing** obtains fresh selection evidence.
These counts do not claim identical initial identity detail.
Unrequested identities and unavailable counts remain distinct; unknown follower reach never becomes zero.
The [200-metric regression](../packages/pulse/src/application/inventory-list-records.test.ts) retains the 22-request summary budget.
Boundary fixtures cover 2, 200, and 405 metrics, and the [frontend controller tests](../packages/web/src/features/pulse/registry/controller.test.ts) exercise the consumer loading policy.

Cached deletion retains its separate acceptance contract:

- Opening review makes zero Tableau requests.
- Execution sends only selected DELETEs and relies on whole-definition cascade.
- Completion shares one datasource refresh, including navigation overlap.
- Incomplete inventory, owner/generation changes, default metrics, and changed fingerprints cannot silently authorize deletion.
- Confirmed, partial, unknown, and unattempted outcomes remain distinguishable.

The [cached-deletion integration tests](../packages/server/src/pulse-cached-deletion.test.ts) exercise these guarantees through real routes and adapters.

## Focused verification

These counts are non-additive because selected runs overlap and some files receive later focused rechecks.
They describe implementation checks, not a complete suite at the final commit.

| Focused check | Recorded result |
| --- | --- |
| Actual installer-script flows with mocked process/download commands | Before: 10 passed, 12 failed. After: 22 passed, 0 failed, 0 skipped. |
| Desktop lifecycle tests | 9 passed. |
| Backend inventory, pagination, subscriptions, dimensions, groups, publication, VDS, and cached deletion | 163 passed, 0 failed, 0 skipped. |
| Complete-list/default-flag, snapshot, and pagination follow-up | 19 passed, 0 failed, 0 skipped. |
| Affected frontend checkpoint | 155 passed; final API/registry/connection/preview/admission selection: 47 passed. |
| Final Pulse owner-admission, count-summary, and dimension-context selection | 7 passed. |
| Core REST/status integration checkpoint and final throttle/version selection | 71 passed at the checkpoint; 9 passed in the final throttle/version selection. |
| Selected core LLM, profile, route, Bedrock, and native CLI adapter files | 118 passed, 0 failed, 0 skipped; final registry recheck: 33 passed. |
| Author parser and proposal service | 18 passed. |
| Existing authoring/provider renderers plus proposal warnings | 25 passed; separate passive-status renderer: 1 passed. |
| Native bounded-log tests | 6 passed, 0 failed, 0 ignored; 26 unrelated tests filtered. |
| Native build, release staging, and provenance tests | 23 passed. |
| Shared build and relevant workspace TypeScript checks | Passed during focused implementation. |
| Rust formatting and changed-file whitespace checks | Passed during focused implementation. |
| Architecture guard | Passed after frontend owner-admission wiring and in the final integrated check. |

The installer checks use Windows PowerShell and a POSIX shell with fake process boundaries.
The logging check runs a real synthetic child producing stdout/stderr bursts, without starting the desktop UI.
Readers use fixed 8 KiB buffers and continue draining when log writes fail.
The Bedrock check uses the installed SDK, a synthetic credential helper, fake time, and a fake HTTP handler.
No fixture calls live Tableau, AWS, or an AI service.
Existing server-rendered authoring tests emit React layout-effect warnings; those warnings do not establish native UI behavior.

### Final integration record

The final pull request records the examined source commit and review outcome.
The integrated checks use the pinned Node.js 22.23.2 runtime and the committed dependency lockfile.

| Command | Integrated result |
| --- | --- |
| `npm ci` | Passed; lockfile unchanged; in-memory SQLite probe passed. |
| `npm run build` | Passed for all workspaces. |
| `npm run typecheck` | Passed. |
| `npm run check:architecture` | Passed. |
| `npm test` | 857 tests: 855 passed, zero failed, and two platform-specific skips. |
| `node scripts/copy-resources.mjs` | Passed; bundled Node reports 22.23.2 and the SQLite startup probe passed. |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | 32 passed, zero failed, and zero ignored. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --check` | Passed. |

The skipped Node cases cover credential-command process-tree timeout and POSIX descendant-pipe termination on this Windows host.
The first integrated run found an outdated success fixture that omitted the subscription identity required for a confirmed outcome.
The fixture now returns a valid receipt without weakening its assertions; its six focused cases and the subsequent complete suite pass.
Dependency installation reports six existing advisories: one low, four moderate, and one high.
Dependency upgrades are outside these behavioral fixes and remain separate work.

## Scope and remaining qualification

R18 remains withdrawn.
This pass adds no conversation summarization, truncation policy, history selection, prompt budgeting, generic job infrastructure, or persistence layer.
Registry mutation recovery across restart remains a separate durability follow-up; unknown outcomes and publication receipts remain intact.
Desktop readiness authentication and signed IPC remain protections against a replacement local peer.
Persistence remains automatic; no user-facing **Save** step or save-before-close workflow is introduced.
Native CLI launch permissions, inherited setup, and output contracts remain unchanged.

The following qualification remains user-led:

- Verify Windows/macOS install, uninstall, and in-app update with delayed automatic persistence beyond the helper wait, rejected writes, retry, discard, and keep-open cancellation.
- Verify ordinary quit, pending assistant/catalog work, dialog mutation blocking, cancel-close recovery, packaged startup, and retained app data/native credentials.
- Verify rendered warning placement, counts versus unrequested identity states, visible detail loading, preview retention, and datasource/session switching in the packaged app.
- Verify real Tableau pagination, mixed user/group subscriptions, throttling, delayed visibility, destination aliases, and partial or ambiguous outcomes without replaying uncertain writes.
- Verify AWS credential refresh, profile replacement, vault dialogs, external sign-out, native CLI tools, managed policies, cancellation, and provider error reporting.
- Verify continuous packaged logging and archived diagnostics on both platforms, including startup failure and descendants retaining inherited pipe handles.
- Review the actual platform/architecture release set and source evidence before publication; offline staging tests do not qualify installer binaries.

The installed AWS SDK does not expose a process deadline or cancellation guarantee for an already-running `credential_process` helper.
Profile serialization is process-local and shared-Db scoped, not a cross-process lock.
Native shutdown waits at most 500 ms for log readers; descendants retaining pipes can leave readers detached until host exit.
Desktop and server logs each retain at most 3 MiB, including their active file and two archives.
Release source/hash evidence establishes consistency, not publisher authentication.
These dependency and lifetime limits remain explicit.
No release, repository-setting change, merge, external message, or publication forms part of this validation work.
