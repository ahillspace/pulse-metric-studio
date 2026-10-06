import {
  registerDbMigrations,
  sanitizeProviderMessage,
  type Db,
} from '@pulse-metric-studio/core';
import {
  PulseDraftContextSchema,
  PulsePublishReceiptSchema,
  type PulseDefinitionSummary,
  type PulseFollowReceipt,
} from '@pulse-metric-studio/shared';
import type { LegacyItemRow, LegacyRunRow } from './rows.js';

export function emptyFollowReceipt(
  requested = false,
  itemCount = 0,
): PulseFollowReceipt {
  return {
    version: 1,
    requested,
    group: { status: 'not_attempted' },
    membership: { status: 'not_attempted' },
    subscriptions: requested
      ? Array.from({ length: itemCount }, (_, itemIndex) => ({
          itemIndex,
          status: 'not_attempted' as const,
        }))
      : [],
  };
}
export function emptyDefinitionSummary(): PulseDefinitionSummary {
  return {
    version: 1,
    fieldId: '',
    fieldLabel: '',
    aggregation: '',
    timeDimensionFieldId: null,
    timeDimensionLabel: '',
    temporality: '',
    cumulative: false,
    slicers: [],
  };
}
function parse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function diagnostic(message: unknown): string | null {
  return typeof message === 'string' && message
    ? JSON.stringify({
        message: sanitizeProviderMessage(message).slice(0, 1200),
      })
    : null;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE pulse_workspaces (
      id TEXT NOT NULL PRIMARY KEY, connection_id TEXT NOT NULL, server_url TEXT NOT NULL, site_id TEXT NOT NULL,
      datasource_luid TEXT NOT NULL, datasource_name TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version > 0),
      revision INTEGER NOT NULL CHECK(revision > 0), document_json TEXT NOT NULL CHECK(json_valid(document_json)), updated_at INTEGER NOT NULL,
      UNIQUE(connection_id, server_url, site_id, datasource_luid));
    CREATE INDEX pulse_workspaces_updated ON pulse_workspaces(updated_at DESC);
    CREATE TABLE pulse_publish_runs (
      id TEXT NOT NULL PRIMARY KEY, request_hash TEXT, connection_id TEXT NOT NULL, server_url TEXT, site_id TEXT, user_id TEXT,
      datasource_luid TEXT NOT NULL, datasource_name TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER,
      follow_receipt_json TEXT NOT NULL CHECK(json_valid(follow_receipt_json)));
    CREATE INDEX pulse_publish_owner_created ON pulse_publish_runs(connection_id, server_url, site_id, datasource_luid, created_at DESC);
    CREATE TABLE pulse_publish_items (
      run_id TEXT NOT NULL REFERENCES pulse_publish_runs(id) ON DELETE CASCADE, item_index INTEGER NOT NULL CHECK(item_index >= 0),
      name TEXT NOT NULL, definition_summary_json TEXT NOT NULL CHECK(json_valid(definition_summary_json)), definition_id TEXT, metric_id TEXT,
      creation_status TEXT NOT NULL CHECK(creation_status IN ('not_attempted','not_created','unknown','created')),
      resolution_status TEXT CHECK(resolution_status IN ('pending','resolved','failed')),
      diagnostic_json TEXT CHECK(diagnostic_json IS NULL OR json_valid(diagnostic_json)),
      undo_status TEXT CHECK(undo_status IN ('pending','unknown','deleted','failed')),
      undo_diagnostic_json TEXT CHECK(undo_diagnostic_json IS NULL OR json_valid(undo_diagnostic_json)),
      PRIMARY KEY(run_id,item_index),
      CHECK(creation_status <> 'created' OR length(definition_id) > 0 AND definition_id IS NOT NULL),
      CHECK(resolution_status IS NULL OR resolution_status <> 'resolved' OR length(metric_id) > 0 AND metric_id IS NOT NULL),
      CHECK(undo_status IS NULL OR creation_status = 'created'));
  `);
  const runInsert = db.prepare(
    'INSERT INTO pulse_publish_runs VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  );
  const itemInsert = db.prepare(
    'INSERT INTO pulse_publish_items VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  );
  for (const run of db.prepare('SELECT * FROM runs').all() as LegacyRunRow[]) {
    if (
      !PulsePublishReceiptSchema.shape.id.safeParse(run.id).success ||
      !Number.isSafeInteger(run.created_at)
    )
      continue;
    const owner = PulseDraftContextSchema.safeParse({
      connectionId: run.connection_id,
      serverUrl: run.server_url,
      siteId: run.site_id,
      datasourceLuid: run.datasource_luid,
    });
    const old = object(parse(run.summary));
    const group = object(old.group);
    const followResults = Array.isArray(old.followResults)
      ? old.followResults
      : [];
    const rows = db
      .prepare('SELECT * FROM run_metrics WHERE run_id=? ORDER BY item_index')
      .all(run.id) as LegacyItemRow[];
    const follow = emptyFollowReceipt(
      Boolean(old.group || run.group_id || followResults.length),
    );
    const groupId = text(group.id) || run.group_id;
    if (groupId)
      follow.group = {
        id: groupId,
        name: text(group.name) || run.group_name || '',
        status:
          group.existedBefore === true
            ? 'reused'
            : group.existedBefore === false
              ? 'created'
              : 'unknown',
      };
    if (typeof group.userAddFailed === 'boolean')
      follow.membership = {
        status: group.userAddFailed ? 'failed' : 'created',
        ...(group.userAddFailed
          ? { error: 'Publishing user could not be added to the group.' }
          : {}),
      };
    follow.subscriptions = followResults.map((raw, index) => {
      const entry = object(raw);
      const metricId = text(entry.metricId);
      const error = text(entry.error);
      return {
        itemIndex:
          rows.find((row) => row.metric_id === metricId)?.item_index ?? index,
        ...(metricId ? { metricId } : {}),
        status:
          entry.ok === true
            ? 'created'
            : entry.ok === false
              ? 'failed'
              : 'unknown',
        ...(error
          ? { error: sanitizeProviderMessage(error).slice(0, 1200) }
          : {}),
      };
    });
    runInsert.run(
      run.id,
      null,
      run.connection_id,
      owner.success ? run.server_url : null,
      owner.success ? run.site_id : null,
      null,
      run.datasource_luid,
      run.datasource_name,
      run.created_at,
      typeof old.createdCount === 'number' ? run.created_at : null,
      JSON.stringify(follow),
    );
    for (const row of rows) {
      if (!Number.isSafeInteger(row.item_index) || row.item_index < 0) continue;
      const payload = object(parse(row.payload_json));
      const specification = object(payload.specification);
      const basic = object(specification.basic_specification);
      const measure = object(basic.measure);
      const timeDimension = object(basic.time_dimension);
      const dimensions = object(payload.extension_options).allowed_dimensions;
      const summary: PulseDefinitionSummary = {
        ...emptyDefinitionSummary(),
        fieldId: text(measure.field),
        fieldLabel: text(measure.field),
        aggregation: text(measure.aggregation),
        timeDimensionFieldId: text(timeDimension.field) || null,
        timeDimensionLabel: text(timeDimension.field),
        cumulative: specification.is_running_total === true,
        temporality: text(specification.temporality),
        slicers: Array.isArray(dimensions)
          ? dimensions
              .filter((id): id is string => typeof id === 'string')
              .map((fieldId) => ({ fieldId, fieldLabel: fieldId }))
          : [],
      };
      const created = Boolean(row.definition_id);
      itemInsert.run(
        run.id,
        row.item_index,
        row.name,
        JSON.stringify(summary),
        row.definition_id || null,
        row.metric_id || null,
        created
          ? 'created'
          : row.creation_status === 'not_created'
            ? 'not_created'
            : 'unknown',
        created
          ? row.metric_id
            ? 'resolved'
            : row.resolution_status === 'failed'
              ? 'failed'
              : 'pending'
          : null,
        diagnostic(row.error),
        created
          ? ['pending', 'unknown', 'deleted', 'failed'].includes(
              row.undo_status ?? '',
            )
            ? row.undo_status
            : 'pending'
          : null,
        diagnostic(row.undo_error),
      );
    }
  }
}
// Legacy Pulse draft storage is retired. Settings and publication archives are preserved.
function retireLegacyDrafts(db: Db): void {
  db.exec('DELETE FROM pulse_drafts; DELETE FROM drafts;');
}
function publicationDisplayContext(db: Db): void {
  db.exec(`
    ALTER TABLE pulse_publish_runs ADD COLUMN digest_audience TEXT;
    ALTER TABLE pulse_publish_runs ADD COLUMN site_content_url TEXT;
  `);
}
registerDbMigrations('pulse', [
  { version: 1, migrate },
  { version: 2, migrate: retireLegacyDrafts },
  { version: 3, migrate: publicationDisplayContext },
]);
