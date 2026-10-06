# Todo

- [x] Datasource picker: show available datasources immediately and allow selection with optional search.
  Reported issue: selection requires filtering and displays "Refine your search for more matches."

- [x] Restore metric settings directly in the authoring table: metric name, description, format, sentiment, data mode, cumulative, minimum granularity, and field details.

- [x] Update the generic AI prompt used to create metrics for a business audience.
  Include all metrics and slicers that provide end-user business value, with meaningful names and sensible formats and sentiment.
  Include distinct counts of dimensions only when they provide significant end-user value.
  Replace the instruction to select only focused measures and a few slicers.

- [x] In proposal review, show "Review resulting metrics" below the change summaries.
  Keep the Measures and Filters summary collapsible and expanded by default.
  This is the final Overhead review direction.

- [x] Summarize proposed changes at the metric and slicer level, grouped under "Measures" and "Filters".
  Show concise entries such as "Quantity Added", "Deal Health Score Added", "Revenue Removed", and "Customer Name Added".
  Put the existing property-by-property change list underneath in a collapsed "Review all changes" section.

- [x] Give digest-group creation/following and audience selection prominent placement and clear visual hierarchy in the authoring workflow.
  The current controls look like an ignorable footer despite their importance.
  Restore the lock/unlock icon for protecting the audience from assistant changes.

- [x] Clear the assistant message input after a successful Send submission.
  Reported issue: clicking Send leaves the submitted text in the input.
  Preserve the text if submission fails.

- [x] Keep Undo Publication's current behavior of retaining the created group, and add a separate `Delete "<group name>" Group` button on both Activity and the metric-building page.
  Target the group created by that publication.

- [x] Rename "Registry" to "Metric Manager" throughout the user-facing interface.

- [x] Investigate and fix follower counts in Metric Manager.
  Reported issue: follower count shows as unavailable almost all the time.

- [x] Update the metric-authoring LLM's system instructions to preserve minimum time granularity.
  Change it only when the user explicitly requests it or the measure name or description explicitly states that daily data is unavailable.
  Default all newly built metrics to month-to-date.
  Treat the metric timeframe and minimum time granularity as separate settings.

- [x] Widen the datasource dropdown so datasource names are readable.

- [x] Make the metric assistant sidebar horizontally resizable by dragging its edge.

- [x] Make the left navigation sidebar collapsible to icons, following Tableau Cloud's interaction pattern.

- [x] Add a polished title bar to every page, using the supplied example as the visual reference.
  Include a page icon, a clear title, and the existing page action buttons.
  Place the datasource selector in the title bar on pages that use it.

- [x] Review the app for small visual and interaction improvements and create an HTML proposal using the overhead skill.
  Include replacing the datasource details button with an icon as a proposed improvement.
  Present the proposed changes visually for user review before changing the app.
  The proposal and final annotations are approved for implementation.

- [x] Show the metric assistant only in Author.

- [x] Replace the inline variant planner with a centered Create variants dialog.
  Prepopulate source metrics from the exact Metric Manager selection.
  Keep source selection editable and show timeframe and filter changes beside a readable per-source preview.

- [x] Verify assistant provider defaults with clean local storage.
  Determine whether the existing unconfigured providers came from this machine's saved settings or the installer defaults.
  Fresh installations should present setup choices rather than pre-existing broken provider profiles.
  Preserve legitimate provider configurations already saved on the user's machine.

- [x] Replace technical provider/protocol labels such as "Chat Completions" and "Converse" with recognizable provider names and access methods.
  Clearly distinguish subscription access from API access, such as "OpenAI subscription" versus "OpenAI API", matching the integration's actual capabilities.

- [x] Use the supplied image as the single consistent application icon on Windows and macOS, including installed app icons, window/title-bar icons, tray/menu-bar icons, and the in-app identity.
  Replace the mismatched title-bar and sidebar icons shown in the screenshot.
  Source image:

  ```powershell
  Invoke-Item C:\Users\"Andrew Hill"\Downloads\"ChatGPT Image Oct 5, 2026, 12_37_02 AM".png
  ```

## Release qualification

- [ ] Complete user-led Windows installation, upgrade, and visual workflow checks.
- [ ] Build and qualify the macOS installers on Apple silicon and Intel.
