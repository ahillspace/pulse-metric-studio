# Measure Tableau requests

Use this procedure to measure Metric Manager request counts and Tableau throttling.
It covers retained inventory, local mutation patches, lazy filter discovery, shared subscription coverage, and bounded cooldown recovery.
Use a datasource where creating test variants and deleting the reviewed test targets is acceptable.
Desktop and live Tableau qualification remain user-led; automated checks use isolated provider fixtures.

## Run the desktop build

Close the running desktop app normally, including any tray instance.
From the repository root, with the dependencies installed and the documented Node.js and Tauri prerequisites, run:

```powershell
npm run tauri:dev
```

This command rebuilds backend packages and the frontend, composes desktop resources, and launches the development desktop app.
It uses the normal desktop data directory and saved connections.
No debug setting or logging switch is required.
Keep this terminal open during the test.

## Record the actions

Record each step's start and finish time, including the timezone.
Wait until loading and follower indicators settle, then leave five seconds between steps unless a step says otherwise.
Keep the same connection, datasource, source metric, and follow target throughout.
Avoid other Tableau work during the measurement window.
Names and filter values are unnecessary in your notes.

1. Connect, select the datasource, and open **Metric Manager**.
   Record the displayed definition and metric counts after loading finishes.
   A fresh app launch establishes a fresh page view and empty in-memory caches.
2. Expand one definition with several metrics.
   Wait for follow details to settle.
   Collapse and expand it again, recording that repeat as a separate action.
3. Select one original source metric and click **Create variants** without adding filters.
   Record dialog opening separately; a timeframe-only dialog requires zero Tableau calls.
4. Select a different supported timeframe and click **Create 1 variant** while the inventory source facts are less than 60 seconds old.
   Choose a timeframe combination that does not already exist.
   Record the displayed outcome and elapsed time, including errors or an unknown outcome.
   Confirm that the resulting metric appears without an automatic inventory reload.
5. Dismiss the results and expand the same definition again.
   Record retained details for known metrics separately from explicit inspection of the newly returned metric.
6. Select the same original source metric, reopen **Create variants**, and repeat the exact timeframe from step 4.
   Click **Create 1 variant** again and record the existing outcome and retained row count.
7. Reopen **Create variants**, click **Add filters**, and wait for eligible dimension fields.
   Select a **Dimension field**, wait for its count and values, and select one value under **Include selected**.
   Record dialog opening, filter discovery, and field selection separately to distinguish metadata requests from value queries.
   Create the filtered variant while its source context remains fresh, then repeat the exact filtered destination.
   Selecting the original source avoids the unchanged-variant restriction on the new filtered metric.
   Record new and duplicate outcomes separately; neither should trigger automatic inventory or count reloads.
8. If cooldown qualification is needed, repeat that duplicate creation up to 10 more times, starting after the preceding operation finishes.
   Keep the same source and variant so these attempts do not intentionally create additional metrics.
   Record each attempt's time, duration, and visible result.
   Stop at the first cooldown banner, local 429, or failed or partial result.
   If all 10 complete without throttling, stop and report that result.
9. After a throttle, record the banner's wait estimate, any extensions, and confirmed partial results.
   Verify that overlapping mutation controls remain disabled during known cooldown and selections remain intact.
   Leave the app idle through the reported wait and record admitted work that resumes.
   Expiry must not resubmit the whole command or an unknown write.
   Do not restart during this window, because restarting clears the in-memory shared cooldown.
10. Review deletion of the intended test targets and record preview and submission separately.
    Preview requires zero Tableau calls; healthy execution sends only the reviewed DELETE requests.
    Confirmed deletions disappear locally while failed, unknown, and unsent targets remain inspectable.
    No automatic inventory reload follows deletion or local cooldown refusal.
11. After cooldown, click **Refresh metrics** deliberately and record that separate reconciliation window.

If an outcome is unknown, inspect Tableau before retrying.
Publication receipts, default-metric resolution, and undo retain their independent safety rules.
No fixed attempt count can guarantee a 429 because Tableau's limits and other traffic vary.

## Compare healthy call budgets

Compare warm-context calls separately from source or catalog misses, transport retries, and explicit follower inspection.
`D` is the number of canonical destinations, and `F` is the number of distinct nonempty filter clauses requiring validation.

| Action | Expected Tableau calls |
|---|---|
| Open a timeframe-only variant dialog | 0 |
| Create or retrieve warm timeframe variants | `D` get-or-create calls |
| Create or retrieve warm filtered variants | `F` validation queries plus `D` get-or-create calls |
| Read local cooldown status | 0 |
| Apply confirmed create or delete patches | 0 |
| Preview deletion from the displayed snapshot | 0 |
| Delete reviewed targets with healthy responses | One DELETE per reviewed destination |
| Expand metrics with retained relationship coverage | 0 repeated detail or summary-count calls |

The first detail demand uses one shared discovery page and bounded targeted fallback when site coverage is incomplete or unqualified.
A demand cannot exceed 20 subscription calls; explicit continuation retains progress and respects site bounds of 20 pages and 2,000 records.
These bounds are app preferences, not Tableau service limits.
Cold or expired source facts and catalog metadata add required acquisition calls without changing the warm budgets.
Missing negative coverage remains unknown until targeted reads complete or site coverage receives user-led qualification.
Personal-only requests retain the authority of the acquired scope rather than upgrading earlier site reads.
Exhausted local page or record limits disable **Load more** and retain an explanatory diagnostic.

## Locate the logs

On Windows, the normal desktop backend log is in the app's roaming data directory.
Open that directory with:

```powershell
explorer.exe (Join-Path $env:APPDATA 'com.ahillspace.pulsemetricstudio')
```

Retain these files if present:

- `pulse-metric-studio-server.log`
- `pulse-metric-studio-server.log.1`
- `pulse-metric-studio-server.log.2`

The active backend file holds 16 MiB, with two archives, for a 48 MiB total budget.
Successful health and local cooldown polling do not produce API completion lines, but outbound Tableau calls remain recorded.
Read archives from `.2` to `.1`, followed by the active file; byte-boundary rotation can split a JSON line between files.
Desktop logs have a separate 3 MiB budget.

For this checkout and machine, the agent can read these files directly.
After testing, provide the measurement time window, step notes, outcomes, and whether you reached throttling.
If testing elsewhere, provide all available backend log files and those notes.
Avoid adding screenshots or notes containing credentials or filter values.

## Interpret the diagnostics

Each Tableau attempt carries the triggering API request's `reqId` and a separate logical Tableau request ID.
Queued gate events retain that same request attribution when another request releases capacity.
Group attempt events by `reqId` and endpoint to count outbound calls per API request.
Use the recorded step windows to group follow-up API requests into the same user action.
Count only outbound attempt events as Tableau calls; local rejection and cooldown events do not represent additional requests.
Pending Manager reads and writes acquire local cooldown status; a final local check captures fast terminal throttles.
These status reads make no Tableau calls.
Follow and unfollow receipts retain per-target and summary `sent` and `throttle` metadata.
Known cooldown refuses these commands before subscription preflight, and a new throttle stops later metric envelopes.
An entirely unsent throttle uses HTTP 429; a throttled response containing submitted mutations uses HTTP 207.
Confirmed inventory receipts contain complete normalized snapshots with an owner-state lifetime and revision.
Reordered receipts and superseded refreshes cannot discard confirmed local changes or replace newer inventory authority.
Attempt `durationMs` includes response consumption or cancellation; `headersMs` measures the time until response headers arrive.
Authentication rejections finish their timing before the separate authentication refresh starts.
Use `startedAt` and `headersMs` to order provider responses when concurrent attempts finish in a different order.
Cooldown `waitedMs` reports the completed admission wait; local rejection events report time spent before refusal.
`throttleHoldMs` records the shared cooldown remaining when Tableau returns a 429.
`retryAfterMs` preserves the provider minimum; the actual shared wait also includes the positive client floor and bounded jitter.
Retry floors are 1, 2, 4, and 8 seconds, including when `Retry-After` is zero.
One queued eligible request probes recovery; an extra health call must not appear in the attempt count.
Local rejection reasons distinguish `throttle_deadline` from `capacity_timeout`.
Structured command errors and item outcomes distinguish sent work from local unsent refusal and carry shared retry timing when throttled.
Local status remains identity-wide; use final item outcomes to classify each target.

The diagnostics also record these measurement facts:

- Metric creation returns a metric ID and a created or existing outcome.
- Inventory summaries separately count literal `specification`, alias `metric_specification`, usable specification, and explicit Boolean `is_default` fields.
  The `inventory_get_metric` operation identifies exact-metric fallback calls.
- Publication default-metric resolution retains its required reads, which appear as outbound attempts.
  Manager get-or-create confirmation does not poll metric visibility.
- Dimension context events identify cache hits and misses; operation labels distinguish source, catalog, and filter-validation calls.
- Subscription events identify pagination without recording follower identities or response bodies.
- Throttle events record Retry-After, shared cooldown, actual waits, and rejections before a request is sent.

Record actual counts and diagnostics alongside these expected budgets.
The procedure does not establish live API compatibility or measured request counts before you run it.
