import crypto from 'node:crypto';

import type { TableauSession } from '@pulse-metric-studio/core';
import { apiPath, getJson, TableauError } from '@pulse-metric-studio/core';
import {
  batchCreateGroupSubscriptions,
  createDefinition,
  resolveDefaultMetricId,
} from './pulse-client.js';
import { invalidatePulseDefinitionInventory } from './manage-service.js';
import { addUserToGroup, ensureGroup } from './groups.js';
import { getDb } from '@pulse-metric-studio/core';

/**
 * Publish orchestration: validate -> create definitions -> resolve default
 * metrics -> optional group follow -> durable audit ledger.
 *
 * Fixes vs Pulse Metric Studio (ledger): A3 (async metric race), E1 (session-scoped undo),
 * D5 (verbose logging), C6 (echoing full payloads back).
 */

export interface CreateMetricItem {
  payload: Record<string, unknown>;
}

export interface CreateMetricResult {
  itemIndex: number;
  creationStatus: 'created' | 'not_created' | 'unknown';
  resolutionStatus?: 'pending' | 'resolved' | 'failed';
  undoStatus?: 'pending' | 'deleted' | 'failed';
  undoError?: string;
  name: string;
  status: 'created' | 'validation_failed' | 'failed';
  definitionId?: string | null;
  metricId?: string | null;
  error?: string;
  validationErrors?: string[];
}

export interface CreateRunResult {
  runId: string;
  results: CreateMetricResult[];
  group?: { id: string; name: string; existedBefore: boolean; userAddFailed?: boolean; followedCount?: number };
  followResults?: Array<{ metricId: string; ok: boolean; error?: string }>;
  createdCount: number;
  failedCount: number;
}

// Process-local activity only: interrupted runs become recoverable after restart.
export const activePublishRuns = new Set<string>();

export async function publishMetrics(
  session: TableauSession,
  connectionId: string,
  input: {
    payloads: unknown[];
    withGroupFollow: boolean;
    groupName?: string;
    digestAudience?: string;
    datasourceLuid: string;
    datasourceName: string;
  },
  dependencies = { createDefinition, resolveDefaultMetricId },
): Promise<CreateRunResult> {
  if (!Array.isArray(input.payloads) || input.payloads.length === 0) {
    throw new Error('payloads must be a non-empty array');
  }

  const runId = crypto.randomUUID();
  const results: CreateMetricResult[] = [];
  const created: Array<{ definitionId: string; metricId: string | null; name: string }> = [];

  activePublishRuns.add(runId);
  try {
    recordRunHeader(session, connectionId, runId, input);

    // Validate everything first, but structurally only. The web builder is a
    // verbatim port of the working legacy constructor and is the single source
    // of truth for the wire shape; reshaping through zod here silently alters
    // keys (which cost us days of 400s). Fail fast on missing essentials, then
    // post the client's bytes untouched.
    for (const [itemIndex, raw] of input.payloads.entries()) {
      const payload = raw as Record<string, any> | null;
      const name = typeof payload?.name === 'string' ? payload.name : 'Unnamed';
      const spec = payload?.specification;
      const problems: string[] = [];
      if (!spec?.datasource?.id) problems.push('specification.datasource.id missing');
      if (!spec?.basic_specification?.measure?.field) problems.push('basic_specification.measure.field missing');
      if (!spec?.basic_specification?.time_dimension?.field) problems.push('basic_specification.time_dimension.field missing');
      if (!Array.isArray(spec?.basic_specification?.filters)) problems.push('basic_specification.filters must be an array');
      if (!Array.isArray(payload?.extension_options?.allowed_dimensions)) problems.push('extension_options.allowed_dimensions must be an array');
      const result: CreateMetricResult = {
        itemIndex, name, status: problems.length ? 'validation_failed' : 'failed',
        creationStatus: problems.length ? 'not_created' : 'unknown',
        ...(problems.length ? { validationErrors: problems, error: problems.join('; ') } : {}),
      };
      results.push(result);
      const persist = () => recordRunMetric(runId, result, JSON.stringify(raw));
      // Persist the attempt before its POST; an interrupted/ambiguous POST stays unknown.
      persist();
      if (problems.length) continue;
      try {
        const { definitionId } = await dependencies.createDefinition(session, payload as any);
        if (!definitionId) {
          result.error = 'No definition ID in response; creation outcome is unknown. Inspect Tableau before retrying.';
          persist();
          continue;
        }
        Object.assign(result, { status: 'created', creationStatus: 'created', definitionId, metricId: null, resolutionStatus: 'pending', undoStatus: 'pending' });
        // Confirmed remote identity is durable before any optional follow-up request.
        persist();
        invalidatePulseDefinitionInventory(session);
        try {
          result.metricId = await dependencies.resolveDefaultMetricId(session, definitionId);
          result.resolutionStatus = result.metricId ? 'resolved' : 'pending';
        } catch (error) {
          result.resolutionStatus = 'failed';
          result.error = `Definition created, but default metric resolution failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        persist();
        created.push({ definitionId, metricId: result.metricId ?? null, name });
      } catch (error) {
        // Never lose a confirmed ID, including if local persistence fails after POST.
        result.error = error instanceof Error ? error.message : String(error);
        if (!result.definitionId && error instanceof TableauError && error.status >= 400 && error.status < 500) result.creationStatus = 'not_created';
        persist();
      }
    }

    // Group follow
    let group: CreateRunResult['group'];
    let followResults: CreateRunResult['followResults'];
    if (input.withGroupFollow && created.length > 0) {
      try {
        const g = await ensureGroup(session, buildGroupName(input));
        group = { id: g.id, name: g.name, existedBefore: g.existedBefore };

        // Legacy parity: add the publishing user to the group so they see the
        // metrics in their feed. A 409 means they are already a member.
        let userId = session.userId;
        if (!userId) {
          try {
            const me = await getJson<any>(session, apiPath(session, '/users/current'));
            userId = me?.user?.id ?? me?.user?.luid ?? null;
          } catch {
            // Surfaced through userAddFailed below.
          }
        }
        let userAddFailed = false;
        if (userId) {
          try {
            await addUserToGroup(session, g.id, userId);
          } catch {
            userAddFailed = true;
          }
        } else {
          userAddFailed = true;
        }
        group.userAddFailed = userAddFailed;

        const followables = created.filter((c) => c.metricId);
        followResults = await batchCreateGroupSubscriptions(
          session,
          followables.map((c) => ({ metricId: c.metricId!, groupId: g.id })),
        );
        group.followedCount = followResults.filter((f) => f.ok).length;
      } catch (e) {
        followResults = [{ metricId: '', ok: false, error: `Group follow failed: ${e instanceof Error ? e.message : String(e)}` }];
      }
    }

    const createdCount = results.filter((r) => r.status === 'created').length;
    const failedCount = results.filter((r) => r.status !== 'created').length;

    updateRunSummary(runId, { group, followResults, createdCount, failedCount });

    return { runId, results, group, followResults, createdCount, failedCount };
  } finally {
    activePublishRuns.delete(runId);
  }
}

function buildGroupName(input: { groupName?: string; datasourceName: string; digestAudience?: string }): string {
  if (input.groupName && input.groupName.trim()) return sanitizeGroupName(input.groupName.trim());
  const audience = sanitizeAudience(input.digestAudience ?? '');
  return sanitizeGroupName(`pulse-metric-studio - ${input.datasourceName} - ${audience}`);
}

function sanitizeGroupName(name: string): string {
  return name.replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 80);
}

export function sanitizeAudience(audience: string): string {
  const cleaned = audience
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : 'General Leadership';
}

// -- audit ledger -------------------------------------------------------------

function recordRunMetric(runId: string, rec: CreateMetricResult, payloadJson: string): void {
  getDb().prepare(`INSERT INTO run_metrics
    (run_id, item_index, definition_id, metric_id, name, payload_json, status, creation_status, resolution_status, undo_status, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id, item_index) DO UPDATE SET
      definition_id=excluded.definition_id, metric_id=excluded.metric_id, status=excluded.status,
      creation_status=excluded.creation_status, resolution_status=excluded.resolution_status,
      undo_status=excluded.undo_status, error=excluded.error`)
    .run(runId, rec.itemIndex, rec.definitionId ?? null, rec.metricId ?? null, rec.name, payloadJson,
      rec.status, rec.creationStatus, rec.resolutionStatus ?? null, rec.undoStatus ?? null, rec.error ?? null, Date.now());
}

function recordRunHeader(
  session: TableauSession,
  connectionId: string,
  runId: string,
  input: { payloads: unknown[]; datasourceLuid: string; datasourceName: string },
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO runs (id, connection_id, datasource_luid, datasource_name, created_at, summary, server_url, site_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, connectionId, input.datasourceLuid, input.datasourceName, Date.now(), JSON.stringify({ startedAt: Date.now() }), session.serverUrl, session.siteId);
}

function updateRunSummary(runId: string, extra: Record<string, unknown>): void {
  const db = getDb();
  const row = db.prepare('SELECT summary FROM runs WHERE id = ?').get(runId) as { summary: string } | undefined;
  if (!row) return;
  const summary = { ...JSON.parse(row.summary), ...extra };
  db.prepare('UPDATE runs SET summary = ?, group_id = COALESCE(?, group_id), group_name = COALESCE(?, group_name) WHERE id = ?').run(
    JSON.stringify(summary),
    (extra.group as any)?.id ?? null,
    (extra.group as any)?.name ?? null,
    runId,
  );
}
