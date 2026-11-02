# Pulse SQLite contract

SQLite stores durable user work and the evidence needed to understand publications.
Tableau remains authoritative for live inventory, permissions, metrics, groups, and subscriptions.
Backend repositories and shared core stores access SQLite; the web interface uses API contracts.
The shared [database infrastructure](../packages/core/src/db/index.ts), `getDb`, owns one process-local connection with WAL and foreign keys enabled.
The [Pulse repository](../packages/pulse/src/persistence/repository.ts), `PulseRepository`, owns current Pulse records and imports its feature migrations.
See the [maintainer guide](PULSE_MAINTAINER_GUIDE.md) for operation flows and transport boundaries.

## State ownership and location

| State | Owner and lifetime |
|---|---|
| `pulse_workspaces`, `pulse_publish_runs`, `pulse_publish_items` | Pulse repository; durable authoring and publication evidence |
| `connections` | Core Tableau session store; durable connection metadata and credential location |
| `llm_profiles` | Core AI profile store; durable provider configuration and secret references |
| `settings` | Core settings helpers; active connection, active provider, and provider readiness records |
| `local_secrets` | Local secret vault; encrypted fallback values addressed by opaque references |
| `_migrations` | Shared migration infrastructure and saved-secrets migration; applied migration keys |
| `runs`, `run_metrics` | Retained historical publication archives; migration reads these records |
| `drafts`, `pulse_drafts` | Retired tables; Pulse migration version 2 clears their records |
| Active Tableau session and PAT | Core session module; memory only, cleared on disconnect or connection change |
| Field catalogs | Core field discovery; process-local cache partitioned by server, site, user, and datasource |
| Native secrets and credential-command approvals | OS credential store and native approval file; separate from SQLite |

The [configuration module](../packages/core/src/config.ts), `loadRepoEnv` and `config`, resolves `.env` from the module layout without overriding existing process environment values.
In development, it resolves `PULSE_METRIC_STUDIO_DATA_DIR` relative to the repository root; its default is `data`.
Packaged code resolves relative paths from the bundled layout, while the desktop launcher supplies an absolute directory.
The selected directory contains `pulse-metric-studio.db`, SQLite sidecars, migration backups, and the encrypted fallback's `machine.key` when needed.
The [desktop launcher](../src-tauri/src/main.rs), `main`, supplies the platform app data directory through that environment variable.
Configuration and database selection occur at module initialization and first database access, respectively.
Changing directories requires restarting the backend.

The [session module](../packages/core/src/tableau/session.ts), `setSession` and `clearSession`, keeps the active token and resolved PAT outside SQLite.
Session generations prevent a delayed sign-in or refresh from replacing a newer session.
Disconnect clears local session state; it does not call Tableau's sign-out endpoint.
The active connection setting remains available for later restoration.

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

### Connection and provider secrets

The [connection store](../packages/core/src/tableau/session.ts), `saveConnection` and `replaceConnectionCredential`, supports `os` and `encrypted` storage kinds.
An OS-managed connection stores `credential_ref` and an empty `pat_secret_enc` value.
An encrypted connection stores AES-256-GCM ciphertext in `pat_secret_enc` and no credential reference.
The connection API requires `explicitFallback=true` before accepting encrypted PAT storage.
Public connection responses omit secret values.

The [AI profile store](../packages/core/src/llm/profiles.ts), `DbLlmProfileStore`, stores configuration in columns and secret references separately.
API keys, custom header values, and credential commands pass through the [secret vault](../packages/core/src/secrets/vault.ts).
`BrokerSecretVault` delegates to the desktop's native credential broker; `LocalSecretVault` stores encrypted values in `local_secrets`.
Listing profiles reads references without resolving the secrets.
Saving writes new vault entries before updating the profile; failed saves attempt to discard newly created entries.
Successful replacements and deletions attempt to remove obsolete entries.
Cleanup errors produce warnings without reverting a committed profile change, so unused vault entries can remain.

The [encryption module](../packages/core/src/db/crypto.ts), `machineKey`, stores the fallback key beside the database and caches it in process memory.
This fallback does not provide OS credential-store isolation from a process that can read the data directory.
Preserve the key with fallback-encrypted data during backup and restoration.

The [native credential broker](../src-tauri/src/credential_broker.rs), `CredentialContext`, separates PAT and AI secrets into app-specific OS services.
Windows uses Credential Manager, and macOS uses the system `security` tool.
Other platforms report OS credential storage as unavailable.
The broker stores each secret under an opaque reference and limits stored values to 1,200 UTF-8 bytes.
The broker token reaches the backend through the desktop startup pipe and stays outside child-process environment variables.
Credential-command approvals persist exact-command hashes in `approved-credential-commands.json` within the desktop data directory.

## Migration and recovery

The [shared migrations](../packages/core/src/db/index.ts), `MIGRATIONS`, create core tables under the `migration` namespace.
Pulse registers [feature migrations](../packages/pulse/src/persistence/migrations.ts) through `registerDbMigrations` under the `pulse` namespace.
Each SQL migration and its ledger insertion run in the same transaction.
Before an unapplied feature migration, `applyFeatureMigrations` creates a `VACUUM INTO` backup if that migration's backup file does not exist.
This consistent backup includes committed WAL data.
The backup name includes the database path and the migration key.
Do not replace it with a raw copy of an open database file.
Core SQL migrations and saved-secrets migration do not create these feature backups.
If SQL migration fails during database initialization, `getDb` closes the connection and propagates the failure.
The failed transaction leaves its migration key unapplied.

Publication migration retains existing receipts and their recorded ownership.
Historical records with unverified ownership remain ineligible for undo.
Migration version 2 deletes records from the legacy `pulse_drafts` and `drafts` tables.
Current `pulse_workspaces` documents, receipt tables, connections, and settings remain intact.
Migration version 3 adds nullable audience and site content URL columns while preserving existing receipts.
Older receipts retain null values instead of inferred names or site URLs.
Historical publication archives remain readable.
The [migration tests](../packages/pulse/src/persistence/migrations.test.ts) cover these preservation boundaries in temporary SQLite databases.

The separate [saved-secrets migration](../packages/core/src/secrets/migration.ts), `migrateSavedSecrets`, records `credentials:001` after moving legacy provider secrets and recreating eligible PAT entries.
It can also reseal encrypted PATs from an earlier OS-held data key under the local key file.
This workflow spans SQLite and the OS store; it is not one atomic database transaction.
An OS-store access failure leaves the migration unrecorded so the next launch retries; earlier completed steps can remain.
Unreadable legacy AI profile blobs are deliberately deleted after a warning.
Oversized legacy secret values are dropped while other readable profile settings remain.
You must re-enter those credentials or recreate unreadable profiles.
The [saved-secrets tests](../packages/core/src/secrets/migration.test.ts) document these compatibility outcomes and the declined-prompt retry path.

The database infrastructure refuses unknown applied versions in core and registered feature migration namespaces.
Do not open an upgraded database with an old release; restore a pre-upgrade backup into a separate data directory for rollback.

For backup or restore:

1. Exit the desktop app completely.
2. Preserve the full app data directory and its migration backups.
3. Restore into an isolated directory using a matching-version browser backend or a separate native validation identity.
   The installed desktop host selects its own app-data directory; changing the data-directory environment variable does not redirect that host.
4. Confirm restored authoring configurations, receipt identities, unknown outcomes, and connection ownership before using live mutations.

OS credentials remain in the operating system's credential store.
A copied database does not transfer those secrets to another machine.
An isolated native identity also uses a separate credential namespace, so reconnect through that environment when existing references cannot resolve.
Fallback-encrypted values require the matching `machine.key`; a database copy alone cannot recover them.

## Retention policy

Authoring configurations and publication receipts are user work and are retained until deliberately removed.
Uncertain receipts must not disappear through automatic expiration.
The backend rejects receipt deletion while publication is running or an item has an unknown creation or undo outcome.
Activity presents outcomes and eligible remote undo.
Local receipt deletion is currently an API operation.
Confirmed remote resource deletion and local history deletion are distinct actions.

Historical publication archives and pre-migration backups remain available under the existing retention policy.
