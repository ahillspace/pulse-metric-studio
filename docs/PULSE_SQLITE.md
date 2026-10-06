# Pulse SQLite contract

SQLite stores durable user work and the evidence needed to understand publications.
Tableau remains authoritative for live inventory, permissions, metrics, groups, and subscriptions.
Only backend repositories access SQLite.

## Active Pulse tables

### `pulse_workspaces`

| Column | Purpose |
|---|---|
| `id` | Stable local authoring workspace identifier |
| `connection_id`, `server_url`, `site_id`, `datasource_luid` | Immutable ownership coordinates; unique as a tuple |
| `datasource_name` | Recognizable display name while offline |
| `schema_version` | Persisted document format version, separate from revision |
| `revision` | Positive counter for atomic compare-and-update saves |
| `document_json` | Validated authoring document: metrics, slicers, audience, follow preference, and conversation with per-message size limits |
| `updated_at` | Ordering and save timestamp |

The document contains authoring intent, including choices, labels, and locks.
Current metadata is loaded separately when connected and rechecked before publication.
Saving increments the revision in the same SQL statement that checks the expected revision.
The row holds the latest working document.
Selecting a datasource restores its configuration through the backend.

### `pulse_publish_runs`

| Column | Purpose |
|---|---|
| `id` | Stable publication command ID and receipt ID |
| `request_hash` | Rejects reuse of a command ID for different input; null only for imported historical runs |
| `connection_id`, `server_url`, `site_id` | Owning connection; missing historical coordinates remain unknown |
| `user_id` | Acting Tableau principal at publication time; unknown for imported records |
| `datasource_luid`, `datasource_name` | Context for diagnosis and offline history |
| `digest_audience` | Chosen audience captured from the approved publication for group action labels; null for older receipts |
| `site_content_url` | Original Tableau site content URL for publication links; null when unknown |
| `created_at`, `finished_at` | Admission and completion times; missing completion can indicate interruption |
| `follow_receipt_json` | Versioned group, membership, and per-item subscription outcomes |

The follow receipt distinguishes created, reused, failed, unknown, skipped, and unattempted effects.
It contains the identifiers and diagnostics needed to explain the optional follow workflow.
Publication links and group action labels use the stored publication context independently of the current connection or edited workspace.

### `pulse_publish_items`

| Column | Purpose |
|---|---|
| `run_id`, `item_index` | Stable item position; composite primary key and cascading run foreign key |
| `name` | Intended definition name for diagnosis |
| `definition_summary_json` | Small versioned authoring summary: measure, aggregation, time, running-total choice, slicers |
| `definition_id` | Confirmed remote creation identity |
| `metric_id` | Confirmed resolved default metric identity |
| `creation_status` | `not_attempted`, `not_created`, `unknown`, or `created` |
| `resolution_status` | Null, `pending`, `resolved`, or `failed`; independent of definition creation |
| `diagnostic_json` | Bounded structured explanation of publication or resolution failure |
| `undo_status` | Null, `pending`, `unknown`, `deleted`, or `failed` |
| `undo_diagnostic_json` | Separate compensation diagnostic, preserving the original outcome |

SQL constraints validate JSON and permitted states.
A confirmed creation requires a definition ID; resolved visibility requires a metric ID.
The entire intended item list is inserted with its run before remote writes begin.
Counts, busy indicators, and undo availability are derived when reading receipts.

List queries return paginated summaries and aggregate item counts in SQL.
Full documents and receipt items are read by ID only when opened.

`settings` and `connections` store app settings and Tableau connection metadata.

## Migration and recovery

Pulse registers its own migrations with shared database infrastructure.
Each migration runs in a transaction and is recorded under the `pulse` namespace in `_migrations`.
Before a feature migration, `VACUUM INTO` creates a consistent backup that includes committed WAL data.
The backup name includes the database path and the migration key.
Do not replace it with a raw copy of an open database file.

Publication migration retains existing receipts and their recorded ownership.
Historical records with unverified ownership remain ineligible for undo.
Migration version 2 deletes records from the legacy `pulse_drafts` and `drafts` tables.
Current `pulse_workspaces` documents, receipt tables, connections, and settings remain intact.
Migration version 3 adds nullable audience and site content URL columns while preserving existing receipts.
Older receipts retain null values instead of inferred names or site URLs.
Historical publication archives remain readable.
Migration tests cover these preservation boundaries in real SQLite databases.

The app refuses unsupported future schema versions.
Do not open an upgraded database with an old release; restore a pre-upgrade backup into a separate data directory for rollback.

For backup or restore:

1. Exit the desktop app completely.
2. Preserve the full app data directory and its migration backups.
3. Restore into an isolated directory and launch the matching application version against it.
4. Confirm restored authoring configurations, receipt identities, unknown outcomes, and connection ownership before using live mutations.

OS credentials remain in the operating system's credential store.
A copied database does not transfer those secrets to another machine.

## Retention policy

Authoring configurations and publication receipts are user work and are retained until deliberately removed.
Uncertain receipts must not disappear through automatic expiration.
The backend rejects receipt deletion while publication is running or an item has an unknown creation or undo outcome.
Activity presents outcomes and eligible remote undo.
Local receipt deletion is currently an API operation.
Confirmed remote resource deletion and local history deletion are distinct actions.

Historical publication archives and pre-migration backups remain available under the existing retention policy.
