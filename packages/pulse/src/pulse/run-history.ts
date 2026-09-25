import { getDb, getSessionContext, isSessionCurrent, type TableauSession } from '@pulse-metric-studio/core';
import type { CreateMetricResult, CreateRunResult } from './create-service.js';
import { activePublishRuns } from './create-service.js';
import { executeDeletes, type ExecuteDeletesDependencies } from './manage-service.js';

export interface RunReceipt extends CreateRunResult {
  publishing: boolean;
  createdAt: number;
  datasourceLuid: string;
  datasourceName: string;
}

function owner(session: TableauSession) {
  const context = getSessionContext(session);
  if (!context || !isSessionCurrent(session)) throw Object.assign(new Error('Reconnect to the owning Tableau connection.'), { statusCode: 401 });
  return [context.connectionId, context.serverUrl, context.siteId];
}

function receipt(row: any): RunReceipt {
  const results = getDb().prepare('SELECT * FROM run_metrics WHERE run_id = ? ORDER BY item_index').all(row.id).map((item: any): CreateMetricResult => ({
    itemIndex: item.item_index, name: item.name, status: item.status,
    creationStatus: item.creation_status, definitionId: item.definition_id, metricId: item.metric_id,
    ...(item.resolution_status ? { resolutionStatus: item.resolution_status } : {}),
    ...(item.undo_status ? { undoStatus: item.undo_status } : {}),
    ...(item.undo_error ? { undoError: item.undo_error } : {}),
    ...(item.error ? { error: item.error } : {}),
    ...(item.status === 'validation_failed' && item.error ? { validationErrors: item.error.split('; ') } : {}),
  }));
  const summary = JSON.parse(row.summary);
  return {
    publishing: activePublishRuns.has(row.id),
    runId: row.id, createdAt: row.created_at, datasourceLuid: row.datasource_luid, datasourceName: row.datasource_name,
    results, createdCount: results.filter((item) => item.creationStatus === 'created').length,
    failedCount: results.filter((item) => item.creationStatus !== 'created').length,
    ...(summary.group ? { group: summary.group } : {}),
    ...(summary.followResults ? { followResults: summary.followResults } : {}),
  };
}

export function listRunReceipts(session: TableauSession, datasourceLuid?: string): RunReceipt[] {
  const scope = owner(session);
  const rows = getDb().prepare(`SELECT * FROM runs WHERE connection_id = ? AND server_url = ? AND site_id = ?
    ${datasourceLuid ? 'AND datasource_luid = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT 20`)
    .all(...scope, ...(datasourceLuid ? [datasourceLuid] : []));
  return rows.map(receipt);
}

export function getRunReceipt(session: TableauSession, runId: string): RunReceipt {
  const row = getDb().prepare('SELECT * FROM runs WHERE id = ? AND connection_id = ? AND server_url = ? AND site_id = ?').get(runId, ...owner(session));
  // Old unscoped rows remain preserved, but cannot safely authorize a remote delete.
  if (!row) throw Object.assign(new Error('Publish run not found for this connection and site.'), { statusCode: 404 });
  return receipt(row);
}

const undoInFlight = new Set<string>();

export async function undoRunReceipt(session: TableauSession, runId: string, dependencies?: ExecuteDeletesDependencies) {
  const run = getRunReceipt(session, runId);
  if (activePublishRuns.has(runId)) throw Object.assign(new Error('Publishing is still running. Wait for it to finish before undoing this run.'), { statusCode: 409 });
  if (undoInFlight.has(runId)) throw Object.assign(new Error('Undo is already running.'), { statusCode: 409 });
  undoInFlight.add(runId);
  const result: Awaited<ReturnType<typeof executeDeletes>> = { definitionsDeleted: 0, metricsDeleted: 0, failures: [], outcomes: [] };
  try {
    for (const item of run.results.filter((candidate) => candidate.definitionId && candidate.undoStatus !== 'deleted')) {
      owner(session);
      const deleted = await executeDeletes(session, [{ definitionId: item.definitionId!, metricIds: [], name: item.name }], dependencies);
      const outcome = deleted.outcomes[0]!;
      // Commit each outcome before continuing, including partial failures.
      getDb().prepare('UPDATE run_metrics SET undo_status = ?, undo_error = ? WHERE run_id = ? AND item_index = ?')
        .run(outcome.status === 'failed' ? 'failed' : 'deleted', outcome.status === 'failed' ? outcome.error ?? 'Deletion failed.' : null, runId, item.itemIndex);
      result.definitionsDeleted += deleted.definitionsDeleted;
      result.failures.push(...deleted.failures);
      result.outcomes.push(...deleted.outcomes);
    }
    return { ...result, run: getRunReceipt(session, runId) };
  } finally {
    undoInFlight.delete(runId);
  }
}
