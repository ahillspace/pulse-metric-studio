# Measure Tableau requests

Use this procedure to measure Metric Manager request counts and Tableau throttling.
It changes no request, caching, reconciliation, or retry behavior.
Use a datasource where creating one filtered metric variant is acceptable.

## Run the logging build

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
3. Select one original source metric and click **Create variants**.
   Wait for the dimension fields to load automatically.
   Select a **Dimension field**, wait for its count and values, and select one value under **Include selected**.
   Record dialog opening and field selection separately to distinguish metadata requests from value queries.
4. Keep a supported timeframe and click **Create 1 variant** while the dimensions context is less than 60 seconds old.
   Choose a filter and timeframe combination that does not already exist.
   Record the displayed outcome and elapsed time, including errors or an unknown outcome.
   Leave the results visible until background loading settles, then wait five seconds.
   This window includes the follow-up inventory and follower refreshes.
5. Dismiss the results and expand the same definition again.
   Record whether follow details load again.
6. Select the same original source metric, reopen **Create variants**, and repeat the exact filter and timeframe from step 4.
   Click **Create 1 variant** again and record the outcome and subsequent background loading.
   Selecting the original source avoids the unchanged-variant restriction on the new filtered metric.
7. Repeat that duplicate creation up to 10 more times, starting each when the preceding operation finishes.
   Keep the same source and variant so these attempts do not intentionally create additional metrics.
   Record each attempt's time, duration, and visible result.
   Stop at the first throttling message, local 429, or approximately 30-second stall with a failed or partial result.
   If all 10 complete without throttling, stop and report that result.
8. After a throttle, leave the app idle for two minutes and record any background results.
   Do not restart during this window, because restarting clears the in-memory shared cooldown.

If an outcome is unknown, inspect Tableau before retrying.
The diagnostic build retains the existing mutation safety rules.
No fixed attempt count can guarantee a 429 because Tableau's limits and other traffic vary.

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
Successful health polling does not produce API completion lines, but outbound Tableau calls remain recorded.
Read archives from `.2` to `.1`, followed by the active file; byte-boundary rotation can split a JSON line between files.
Desktop logs have a separate 3 MiB budget.

For this checkout and machine, the agent can read these files directly.
After testing, provide the measurement time window, step notes, outcomes, and whether you reached throttling.
If testing elsewhere, provide all available backend log files and those notes.
Avoid adding screenshots or notes containing credentials or filter values.

## Interpret the diagnostics

Each Tableau attempt carries the triggering API request's `reqId` and a separate logical Tableau request ID.
Group attempt events by `reqId` and endpoint to count outbound calls per API request.
Use the recorded step windows to group follow-up API requests into the same user action.
Count only outbound attempt events as Tableau calls; local rejection and cooldown events do not represent additional requests.
Attempt `durationMs` includes response consumption or cancellation; `headersMs` measures the time until response headers arrive.
Authentication rejections finish their timing before the separate authentication refresh starts.
Use `startedAt` and `headersMs` to order provider responses when concurrent attempts finish in a different order.
Cooldown `waitedMs` is cumulative for one admission; use its final value rather than adding repeated cooldown-extension events.
`throttleHoldMs` records the shared cooldown remaining when Tableau returns a 429.
Local rejection reasons distinguish `throttle_deadline` from `capacity_timeout`.

The diagnostics also record these measurement facts:

- Metric creation returns a metric ID and a created or existing outcome.
- Inventory summaries separately count literal `specification`, alias `metric_specification`, usable specification, and explicit Boolean `is_default` fields.
  The `inventory_get_metric` operation identifies exact-metric fallback calls.
- Reconciliation records each actual poll, separately from retries within that poll.
- Dimension context events identify cache hits and misses; operation labels distinguish source, catalog, and filter-validation calls.
- Subscription events identify pagination without recording follower identities or response bodies.
- Throttle events record Retry-After, shared cooldown, actual waits, and rejections before a request is sent.

This procedure supplies evidence for the later analysis and design spec.
It does not establish API capabilities or measured request counts before you run it.
