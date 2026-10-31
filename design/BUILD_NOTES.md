# Design build notes

The redesign and the behavior changes below were approved for production implementation on 2026-10-31.
The HTML remains a visual reference; production retains the React components, controllers, contracts, and mutation safeguards.
Add existing uses a fresh, selection-scoped invocation of the existing follow-state endpoint because the cached identities have no per-metric freshness timestamp.
That read is batched at 200 metrics with at most four concurrent requests, discards results after context changes, and does not replace the inventory snapshot.
It merges direct user and group targets using directory names, preserves existing pills, and reports incomplete reads.
Deletion follower disclosure invokes the existing follower-detail endpoint on demand for the exact reviewed metric.
Friendly deletion labels are presentation-only; reviewed IDs and fingerprints remain authoritative.
Activity actions belong to the selected publication above the history/details layout; its separate Refresh results control is removed while history Refresh remains.

The sections below preserve the design-stage audit from 2026-10-30 at `bb8011d`.
References below to unchanged production code, pending decisions, and prototype-only checks describe that earlier audit, not the implementation status above.
Current-run validation is recorded separately at the end of this note.

## Implementation boundary

Use the HTML as a visual reference, not as replacement app logic.
Do not port its fixture handlers, selection helpers, request simulations, or receipt models into production.
Apply visual changes to the existing components while retaining their event handlers, state ownership, schemas, and review safeguards.
The explicitly proposed behavior changes below require separate implementation and validation.
Visual similarity and prototype checks do not establish production workflow parity.

## Decision summary

**Add existing** is a behavior change, not a visual adjustment.
Manager already fetches direct user and group subscriber IDs for each metric during initial loading.
It does not fetch all follower names in that response.
The follower picker separately loads the user and group directory with names.
Reuse those two datasets to add existing subscribers as deduplicated pills for the exact selected metrics.
Refresh the existing follow-state request when identity data is incomplete or stale.

Expandable **N followers** in deletion review is also a behavior change.
Deletion review currently fetches fresh counts, not follower identities.
Use the existing follower-detail endpoint on demand to show affected users and groups.
This adds a request invocation but requires no new endpoint.
An alternative is to enrich initial follow-state with names; that changes the existing response and fetch workflow.
Production implementation of these options remains pending your decision.

## Visual corrections in the concept

- Place **Create variants** beside the other selection actions instead of at the opposite end of the toolbar.
- Preserve the existing source picker, timeframe, dimension-value selection, include/exclude controls, grouped filters, preview, and footer layout.
- Preserve the follower modal's search, target list, selected pills, refresh, and follow/unfollow actions without adding a selected-metrics list.
- Use existing friendly metric labels in deletion review instead of displaying IDs when those labels are available.
- Use plain deletion warnings without a colored side band or decorative warning card.
- Show Activity's existing creation counts and item states without a new aggregate outcome field or outcome filter.

The concept uses local example member values and subscriber identities, not live data.
It does not reproduce server pagination, permission checks, partial failures, or metadata compatibility resolution.
Create variants remains a source- and screenshot-based visual example, not proof of production behavior parity.

## Interaction audit and prototype checks

The audit compares Author, Metric Manager, Activity, and their represented dialogs with their existing components and handlers.
The existing app was not driven through its desktop runtime.
No development browser server was listening on ports 4620 or 4621 during this pass.
The browser checks below run only against the standalone HTML with example data.
They do not establish live Tableau, AI-provider, persistence, or native-shell parity.

### Verified or corrected represented controls

| Area | Contract retained or correction made | Evidence |
|---|---|---|
| Manager selection handoff | Copy the exact selected IDs into the local variants plan; initially collapse the picker when selection is nonempty. | Browser check: 35 Manager IDs equal 35 dialog IDs, with 35 preview cards and the picker closed. |
| Change source metrics | Change opens the existing source disclosure; selection changes remain local to the dialog. | Browser check: picker opens; changing 14 sources to 13 does not change Manager selection. |
| Cancel and reopen | Discard local source changes and initialize again from the Manager selection. | Browser check: cancel restores the original 14 selected Manager IDs; reopening inherits 14. |
| Filtered-out selections | Manager filtering must not discard selected IDs outside the visible subset. | Browser check: filtering to Gross margin still opens all 14 selected sources. |
| Source families | Compare canonical timeframe/filter identity, never truncated display text. | Browser check: two five-value filters with identical shortened captions remain separate selectable families. |
| Filter clauses | Keep selected values together in one clause and one variant per source. | Browser check: two selected values retain three previews for three sources; incomplete field editing blocks creation. |
| Staged filter labels | Use the existing single-value, keeps-count, and excludes-count summaries. | Source comparison with `fork-plan.ts`; browser check displays Product Name: keeps 5. |
| Expand and collapse | Apply the existing displayed-definition expansion rule. | Corrected from preserving hidden expansion state to the native replacement rule. |
| Metric preview | Open the existing nonmodal side-panel composition, retaining Manager selection and interaction. | Browser check: preview panel visible, no dialog opened, existing selection retained. |
| Follower picker | Keep search, target list, pills, Refresh targets, and explicit Follow/Unfollow; do not list selected metrics above it. | Browser checks cover local target selection and disabled empty-target actions. |
| Add existing | Merge example existing subscribers without duplicate pills. | Repeated browser activation produces two distinct pills, not four. Production behavior remains proposed. |
| Deletion scope | Default metric selection includes its definition and sibling metrics; display friendly names and expandable follower counts. | Browser checks cover affected siblings and the two-follower disclosure. Live review fingerprints are not modeled. |
| Digest controls | Hide audience controls without clearing values; preserve audience protection. | Browser check retains the audience, disabled group-follow choice, and lock through Clear configuration. |
| Clear configuration | Remove metric/slicer settings only; keep digest settings, search, Hide unused, chat, and composer. | Browser check retains Regional leaders, protected audience, Profit search, Hide unused, and unsent composer text. |
| Field search and counts | Match original field labels with trimmed case-insensitive search; count the filtered measure set. | Corrected edited-name search and global measure totals. |
| Metric defaults | Use the first available fixture date, Number, Neutral, Over time, and Day. | Source comparison with `defaultPulseMetric`; browser check reads Order Date and Neutral. |
| Metric deselection | Disable configured editors while retaining their edited values. | Browser check retains Currency after deselection. |
| Dimensions | Retain the existing collapsed dimension-metric section with Distinct count. | Browser check edits Account Name as a dimension metric without counting it as a measure. |
| Metric columns | Retain the native ten-column order, calculation choices, date clearing, format, sentiment, data mode, cumulative restrictions, and granularity. | Source audit of `MetricTable.tsx` and shared contracts. |
| Text limits | Retain the existing name/audience limits and description limit. | Restored 32,768-character names/audiences and 262,144-character descriptions. |
| Field information | Retain inline disclosure rather than opening a new modal. | Corrected control structure; live metadata remains unavailable in the fixture. |
| Clear chat | Clear the transcript without deleting an unsent composer; disable when the transcript is empty. | Corrected local handler and availability. |
| Publication entry | Require metric and slicer selection to open review; do not require valid date/name before entering review. | Source comparison with `PublishSection.tsx`; local review exposes blocking issues. |
| Publication review | Show selected names, calculations/source fields, dates, cumulative state, slicers, descriptions, and digest request. | Restored represented review content and separate Cancel/Publish metrics controls. No submission occurs. |
| Header counts | Show example remote inventory counts, not active draft selections. | Corrected to the Manager fixture inventory; editing a draft does not alter inventory counts. |
| Assistant and modals | Preserve hide/show state, resize keys, expanded semantics, Close/Cancel/Escape, backdrop dismissal, and focus return. | Source comparison and targeted browser checks; busy-state dismissal guards remain outside the fixture. |
| Activity actions | Show only the selected publication's actions in a stable toolbar above the log. | Toolbar is outside the scrolling metric details, names the selected datasource/time, and hides without a selection. |
| Activity Refresh results | Omit this control as requested. | It exists in native `Receipt.tsx:208`; its prototype control and handler are removed. History Refresh remains. |
| Activity receipts | Keep created, failed, unconfirmed, and not-sent counts derived from receipt items. | No aggregate outcome field or outcome filter remains. |

The reported lost-selection state was not reproduced in the current HTML.
This is not evidence that an earlier served version behaved correctly.
The verified handoff must remain unchanged during visual integration.
An empty Manager selection still opens the source picker, matching the existing app's empty-selection behavior.
Do not conceal a future handoff failure by forcing the picker shut or selecting arbitrary metrics.

### Explicitly unrepresented service and conditional states

The datasource chooser is a placeholder rather than the native connected/offline datasource search flow.
Provider settings, Connections, and Disconnect are outside this three-screen concept.
The assistant does not reproduce proposal review, Apply/Discard, property-lock merging, request progress, error recovery, or provider tool disclosures.
The publication example does not reproduce revision-bound previews, command idempotency, stale-review checks, unknown-command recovery, or publication results.
Local examples do not establish behavior for unavailable fields, truncated catalogs, pagination, partial identity inventories, or asynchronous metadata changes.
Persistence, save conflicts, shutdown recovery, updater state, and connection ownership remain native-app responsibilities.
Activity fixture eligibility is simplified; production must retain `undoEligible`, retryable undo states, already-deleted exclusions, original-connection checks, publishing guards, and busy-state guards.
Group deletion must retain its existing created-group ID, deletion-state, connection, and busy-state checks.
The metric preview cannot load Tableau imagery or open a valid live metric URL from example IDs.
Follow/unfollow, deletion, variant creation, and confirmation results are local demonstrations, not service implementations.
These omitted states require native component validation before any production integration is approved.

### Separate visual pass

Increase supporting text legibility while retaining the compact desktop type scale.
Raise disabled table-value contrast without making disabled commands look active.
Give definition names stronger weight and reduce excess header-row padding.
Use the existing preview and copy icon controls to reduce repeated text without changing their actions or accessible labels.
Use friendly calculation captions instead of code-like aggregation expressions.
Use consistent modal titles, control heights, horizontal padding, and primary-button color across screens.
Keep the follower target list content-sized with a scroll maximum, rather than leaving a fixed empty well.
Use a flat selected-publication toolbar and plain warnings without decorative colored side-band cards.
Remove unnecessary framing around the digest disclosure so receipt content reads as one work surface.
Inspect normal desktop renders of the screens and represented dialogs after these changes.
Emulated-viewport screenshot scaling was unreliable, so no screenshot-based visual claim is made for other window sizes.

## Data fetched today

Source references below use repository-relative paths and one-based line numbers.

| Stage | Actual fetch and returned data | Source evidence |
|---|---|---|
| Manager load | Inventory loads first, followed by follow-state requests for its metric IDs in batches of 200, with four batches concurrent. | `packages/web/src/features/pulse/registry/controller.ts:175`, `:183`, `:187`, `:193` |
| Renderer API | `POST /api/pulse/follow-state` sends metric IDs. | `packages/web/src/features/pulse/api/registry.ts:24` |
| Current-user context | Backend lists the current user's groups unless a selected group ID is supplied, then passes user and group IDs to `getFollowState`. | `packages/pulse/src/pulse/routes.ts:116`, `:124`, `:131` |
| User's groups | Paginated `GET /api/{version}/sites/{siteId}/users/{userId}/groups` returns group IDs and names, not each group's members. | `packages/pulse/src/application/subscriptions.ts:215`, `:229`, `:250` |
| Counts | Backend calls `GET /api/-/pulse/subscriptions:batchGetMetricFollowerCounts?metric_ids=...`, in batches of 200. | `packages/pulse/src/pulse/pulse-client.ts:12`, `:449`, `:478`, `:489` |
| Exact subscriber identities | Backend also lists subscriptions for every requested metric, with concurrency five. | `packages/pulse/src/application/subscriptions.ts:44`, `:97`, `:104` |
| Subscription pagination | `GET /api/-/pulse/subscriptions?metric_id=...` follows `page_token`, rejecting invalid continuations and read-limit overflow. | `packages/pulse/src/pulse/pulse-client.ts:339` |
| Returned follow-state | Response contains current-user/group relationship booleans, distinct USER IDs, distinct GROUP IDs, counts, availability, and diagnostics. | `packages/pulse/src/application/subscriptions.ts:69`, `:142`, `:164`, `:174`, `:199` |

Initial follow-state already includes identities for all returned direct USER and GROUP subscribers, independently of the current user's membership.
It does not return their friendly names, even when the provider subscription records include names.
It does not expand GROUP subscribers into individual group members.
Fetching `/users/current` supplies only the current user's best-effort display name and proves no complete follower or group-member inventory.
See `packages/core/src/tableau/routes.ts:629` and `:642`.
Complete group memberships cannot be inferred from the current user's groups, the site directory, subscription IDs, or aggregate counts.

`followerIdsStatus` distinguishes available, partial, and unavailable identity inventory independently of current-user group-context failures.
Unknown follower types make identity inventory partial; subscription failures make it unavailable.
Count availability is separate, so an available count does not establish available identities.
See `packages/pulse/src/application/subscriptions.ts:183` through `:204`.
These are source guarantees about processed responses, not live verification of Tableau visibility, permissions, or current remote completeness.

## Existing detail and directory requests

The existing follower badge opens a definition-level modal that requests details for that definition's metrics.
See `packages/web/src/features/pulse/components/ExistingMetrics.tsx:445`, `:531`, and `packages/web/src/features/pulse/registry/views.tsx:378`.
`loadFollowers` delegates to `POST /api/pulse/followers-detail`, whose backend calls `getFollowersDetail`.
See `packages/web/src/features/pulse/registry/controller.ts:573`, `packages/web/src/features/pulse/api/registry.ts:32`, and `packages/pulse/src/pulse/routes.ts:193`.

This detail request re-fetches subscriptions rather than reusing the initial follow-state arrays.
It deduplicates lookup keys across metrics by `(type, id)`, retains supplied names, and resolves missing names.
See `packages/pulse/src/application/subscriptions.ts:585`, `:609`, and `:653`.
Missing USER names use `GET /api/{version}/sites/{siteId}/users/{id}`, preferring `name` over `fullName`.
Missing GROUP names use a paginated site-group listing, not a group-member query.
See `packages/pulse/src/pulse/pulse-client.ts:507`, `:513`, `:529`, and `packages/pulse/src/application/subscriptions.ts:630`.
Names use a five-minute, 512-entry cache scoped by server, site, type, and ID.
See `packages/pulse/src/application/subscriptions.ts:45`, `:732`, `:756`, and `:789`.
Details return per-metric `{id, name, type}` followers, status, and diagnostics, with raw-ID fallbacks for unresolved names.
See `packages/pulse/src/application/subscriptions.ts:695` and `packages/shared/src/pulse-contracts.ts:401`.
Partial detail status can indicate name-resolution failure, so it does not always mean missing follower IDs.

The existing follow-target picker separately loads `GET /api/pulse/follow-targets` when opened.
It lists site users and groups, including names, and filters locally.
See `packages/web/src/features/pulse/components/FollowTargetModal.tsx:70`, `:95`, and `packages/pulse/src/pulse/routes.ts:148`.
Backend directory reads run together; users prefer `fullName` over `name`, unlike the user-detail lookup.
See `packages/pulse/src/application/subscriptions.ts:815` and `packages/pulse/src/pulse/pulse-client.ts:564`, `:585`.
Directory membership identifies selectable targets, not which targets follow selected metrics or which people belong to a group.

## Deletion impact

The current backend chooses `metric.name || definition.name`, then falls back to the metric ID.
An upstream metric name containing its own ID is truthy, so the definition-name fallback does not apply.
The dialog displays that returned name directly.
See `packages/pulse/src/application/deletion.ts:139`, `:162`, and `packages/web/src/features/pulse/components/ExistingMetrics.tsx:607`.
The renderer already has `forkFriendlyName` and `metricDisplayName`, which reject ID-only names and include filter or timeframe context.
See `packages/web/src/features/pulse/registry/views.tsx:527`, `:568`, and `:583`.
Reuse these friendly labels for the exact reviewed metric IDs.
Keep reviewed target IDs, deletion scope, revision checks, and mutation fingerprints authoritative and unchanged.
When metadata is unavailable, show an explicit unavailable name instead of manufacturing a friendly label.

Deletion review fetches fresh per-metric follower counts for the affected IDs and attaches metric IDs, metric names, and nullable follower counts.
It does not fetch subscriber identities or follower friendly names.
Missing counts remain `null`, not zero.
See `packages/pulse/src/application/deletion.ts:138` through `:164` and `packages/shared/src/pulse-contracts.ts:258`.
The current deletion dialog renders those per-metric counts as text and labels null counts unavailable.
See `packages/web/src/features/pulse/components/ExistingMetrics.tsx:607` through `:617`.

Manager's identity arrays can support a distinct union across selected metrics without summing counts.
`countDistinctFollowers` already implements separate USER and GROUP sets and checks identity availability.
See `packages/web/src/features/pulse/registry/views.tsx:177`.
`deletionBlastRadius` formats that union with an incomplete-data warning, but the current deletion dialog does not call it.
See `packages/web/src/features/pulse/registry/views.tsx:355` and `packages/web/src/features/pulse/components/ExistingMetrics.tsx:592`.
A GROUP counts as one subscriber identity, not its number of people.
Summed per-metric counts cannot establish unique people or unique subscriber identities across metrics.

## Recommendation and pending choice

Recommended design: reuse current identity inventory and existing on-demand details; keep initial loading unchanged.
The following choices remain pending your decision, with no production implementation authorized by this note:

| Proposed interaction | Recommended data use | Fetch impact |
|---|---|---|
| **Add existing** | Union USER and GROUP IDs across the exact selected metrics, deduplicate by `(type, id)`, and merge into selected targets. | Reuse loaded follow-state; join names from the picker directory when available. |
| **Add existing** with missing or stale inventory | Refresh the existing follow-state request and show incomplete inventory explicitly. | Additional invocation of an existing fetch, not a new endpoint. |
| Clickable **N followers** in deletion review | Request details for that reviewed metric ID and reuse the follower-list presentation. | Additional on-demand invocation of the existing detail endpoint. |
| Aggregate impact identity list | Request details for the reviewed affected metric IDs, then union by `(type, id)`. | Existing detail endpoint; no group-member expansion. |
| Names available immediately without detail re-fetch | Enrich initial follow-state with names from its subscription reads and resolve missing names in the backend. | Modify the existing response contract and fetch workflow; extra directory/user reads can remain necessary. |
| Every person reached through groups | Define group expansion, permission failures, and overlap semantics before implementation. | New group-member retrieval is required beyond these audited follower paths. |

Prefer the recommended on-demand design unless you choose immediate names or expanded group membership as a requirement.
**Add existing** means the union of existing subscriber targets, not an intersection or the entire site directory.
Do not treat unresolved inventory as an empty selection or claim all existing followers were added when some selected metrics remain unavailable.
Keep unresolved names identifiable by type and ID, and exclude unsupported types from mutation targets with an explicit diagnostic.
An older count and a fresh identity query can differ; show their scopes and availability rather than forcing numerical agreement.

## Activity receipt data

Activity already receives `createdCount`, `failedCount`, `unknownCount`, and `unattemptedCount`, plus publication lifecycle fields.
See `packages/shared/src/pulse-contracts.ts:203` through `:218`.
The receipt list endpoint aggregates stored `pulse_publish_items.creation_status` values into those counts.
The full receipt derives the same counts from stored items; these are computed response fields, not a separate durable outcome enum.
See `packages/pulse/src/persistence/repository.ts:184`, `:211`, `:244`, and `:412`.
Routes expose list and detail at `/api/pulse/receipts` and `/api/pulse/receipts/:id`.
See `packages/pulse/src/http/workflow-routes.ts:149` and `packages/web/src/features/pulse/api/client.ts:148`.
Activity displays created, failed, unconfirmed, and not-sent counts directly, highlighting failed or unknown creation counts.
The detail view displays the same summary, lifecycle warnings, individual items, and separate follow results.
See `packages/web/src/features/pulse/activity/Activity.tsx:45` and `packages/web/src/features/pulse/activity/Receipt.tsx:60`, `:77`.
Use these existing fields for Activity presentation without adding an `outcome` field or persistence migration.
Creation counts alone do not summarize follow failures, undo results, or every publication lifecycle condition.
Manager follow and deletion results remain controller memory rather than Activity publication receipts.
See `docs/PULSE_MAINTAINER_GUIDE.md:245`.

## Production implementation validation, 2026-10-31

The actual React app was exercised through both the Vite development server and the compiled production build with an isolated HTTP fixture API.
The fixture API used the repository's contract-shaped test data and never contacted Tableau or AI services.
Baseline reproduction showed UUID deletion labels, static follower counts, and no Add existing control.
The same flows now show friendly labels, exact-metric follower disclosure, and deduplicated subscriber pills.
The production request log confirmed that Add existing sent the exact three selected metric IDs and follower disclosure sent only the expanded metric ID.
Manual target selections survived addition, and repeated addition retained three unique user/group pills.
Partial subscriber reads showed an explicit incomplete-inventory message.
Unavailable follower details retained the reviewed count and showed an unavailable message instead of claiming zero followers.
Create variants inherited all 35 selected sources with its picker collapsed, opened source editing through Change, and restored the Manager selection after cancel and reopen.
Two selected dimension values remained grouped in 35 source previews.
Activity showed the selected-publication actions above the variable-length details, retained the original undo and group-deletion confirmations, and hid the actions after Close details.
History Refresh remained while Activity's Refresh results control was absent.
The rendered pass covered Author, expanded Manager rows, the variants and follower dialogs, deletion review, and Activity.
Build, workspace TypeScript checks, architecture checks, and the full Node test suite passed.
All 26 Rust tests passed, and 34 targeted regression tests passed after final integration.
No live Tableau mutation, AI-provider run, or native desktop interaction was performed.
Browser evidence establishes renderer behavior with isolated responses; it does not establish live service or native-shell compatibility.
Independent review identified Activity confirmation stacking beneath the application header.
Both confirmations now mount at the document body while their state remains owned by the selected receipt.
The compiled renderer verified that the modal backdrop covers the header and retains the native confirmation scope.
