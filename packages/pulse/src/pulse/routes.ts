import type { FastifyInstance } from 'fastify';
import { registerDraftRoutes } from '../drafts.js';
import { listRunReceipts, getRunReceipt, undoRunReceipt } from './run-history.js';
import {
  publishMetrics,
  sanitizeAudience,
} from './create-service.js';
import {
  executeDeletes,
  followTargets,
  getExistingMetrics,
  getFollowersDetail,
  getFollowState,
  getFollowTargets,
  listUserGroupIds,
  unfollowTargets,
  type FollowTargetOperation,
} from './manage-service.js';
import { getSession, getSessionContext, type TableauSession } from '@pulse-metric-studio/core';
import { DATE_FORK_BATCH_SIZE, resolveTimeframe } from '@pulse-metric-studio/shared';
import { dimensionalForkHttpStatus, pulseDimensionalForkService } from './dimensional-fork-service.js';
import {
  canonicalizeForkPlanRequest,
  forkPlanHttpStatus,
  PulseForkPlanError,
  pulseForkPlanService,
  type PulseForkPlanRequestV1,
  type PulseForkPlanResult,
  type PulseForkPlanService,
} from './fork-plan-service.js';

// Serialize legacy chunks so a terminated chunk cannot start another mutation batch.
const LEGACY_FORK_CHUNK_CONCURRENCY = 1;

export interface LegacyPulseForkRequest {
  sourceMetricId: string;
  timeframeKey: string;
  customDays?: number;
}

interface LegacyPulseForkGroup {
  key: string;
  timeframeKey: string;
  customDays?: number;
  label: string;
  requests: Array<{ sourceMetricId: string; index: number }>;
}

interface PreparedLegacyForkChunk {
  groupKey: string;
  plan: PulseForkPlanRequestV1;
}

function requireSession() {
  const s = getSession();
  if (!s) {
    const err = new Error('Not connected to Tableau') as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  return s;
}

export function registerPulseRoutes(
  app: FastifyInstance,
  dependencies: { forkPlanService?: Pick<PulseForkPlanService, 'forkMetrics'> } = {},
): void {

  registerDraftRoutes(app);
  app.get('/api/pulse/runs', async (req) => ({ runs: listRunReceipts(requireSession(), (req.query as { datasourceLuid?: string }).datasourceLuid) }));
  app.get('/api/pulse/runs/:runId', async (req) => getRunReceipt(requireSession(), (req.params as { runId: string }).runId));
  app.post('/api/pulse/runs/:runId/undo', async (req) => undoRunReceipt(requireSession(), (req.params as { runId: string }).runId));

  const forkPlanService = dependencies.forkPlanService ?? pulseForkPlanService;

  app.get('/api/pulse/status', async () => ({
    enabled: true,
    module: 'pulse',
  }));

  app.post('/api/pulse/metrics/create', async (req) => {
    const session = requireSession();
    const body = req.body as {
      payloads?: unknown[];
      withGroupFollow?: boolean;
      groupName?: string;
      digestAudience?: string;
      datasourceLuid?: string;
      datasourceName?: string;
    };
    if (!Array.isArray(body.payloads) || body.payloads.length === 0) {
      throw app.httpErrors.badRequest('payloads must be a non-empty array');
    }
    if (!body.datasourceLuid) throw app.httpErrors.badRequest('datasourceLuid is required');

    const connectionId = getSessionContext(session)?.connectionId;
    if (!connectionId) throw app.httpErrors.unauthorized('Reconnect before publishing.');
    return publishMetrics(session, connectionId, {
      payloads: body.payloads,
      withGroupFollow: body.withGroupFollow === true,
      groupName: body.groupName,
      digestAudience: body.digestAudience ? sanitizeAudience(body.digestAudience) : undefined,
      datasourceLuid: body.datasourceLuid,
      datasourceName: body.datasourceName ?? body.datasourceLuid,
    });
  });

  app.get('/api/pulse/existing-metrics', async (req) => {
    const session = requireSession();
    const { datasourceLuid } = req.query as { datasourceLuid?: string };
    if (!datasourceLuid) throw app.httpErrors.badRequest('datasourceLuid query parameter is required');
    return getExistingMetrics(session, datasourceLuid);
  });

  app.get('/api/pulse/dimensions', async (req) => {
    const session = requireSession();
    const query = (req.query ?? {}) as Record<string, unknown>;
    return pulseDimensionalForkService.listEligibleDimensions(session, repeatedQueryValues(query.sourceMetricId));
  });

  app.get('/api/pulse/dimensions/:fieldId/count', async (req) => {
    const session = requireSession();
    const { fieldId } = req.params as { fieldId?: string };
    const query = (req.query ?? {}) as Record<string, unknown>;
    return pulseDimensionalForkService.countDimensionMembers(session, {
      sourceMetricIds: repeatedQueryValues(query.sourceMetricId),
      fieldId: String(fieldId ?? ''),
    });
  });

  app.get('/api/pulse/dimensions/:fieldId/values', async (req) => {
    const session = requireSession();
    const { fieldId } = req.params as { fieldId?: string };
    const query = (req.query ?? {}) as Record<string, unknown>;
    return pulseDimensionalForkService.listDimensionValues(session, {
      sourceMetricIds: repeatedQueryValues(query.sourceMetricId),
      fieldId: String(fieldId ?? ''),
      search: typeof query.search === 'string' ? query.search : undefined,
      all: query.all === '1' || query.all === 'true',
    });
  });

  app.post('/api/pulse/metrics/fork-dimensional', async (req, reply) => {
    const session = requireSession();
    const summary = await pulseDimensionalForkService.forkMetrics(session, req.body);
    const statusCode = dimensionalForkHttpStatus(summary);
    if (statusCode === 502) {
      return reply.code(statusCode).send({
        errorCode: 'PULSE_DIMENSIONAL_PROVIDER_FAILURE',
        error: 'Tableau failed every dimensional fork request.',
        ...summary,
      });
    }
    if (statusCode === 422) {
      return reply.code(statusCode).send({
        errorCode: 'PULSE_DIMENSIONAL_SOURCE_FAILURE',
        error: 'Every source metric is incompatible with this dimensional fork.',
        ...summary,
      });
    }
    return reply.code(statusCode).send(summary);
  });

  app.post('/api/pulse/metrics/fork', async (req, reply) => {
    const session = requireSession();
    const summary = await forkPlanService.forkMetrics(session, req.body);
    return reply.code(forkPlanHttpStatus(summary)).send(summary);
  });

  app.post('/api/pulse/follow-state', async (req) => {
    const session = requireSession();
    const body = req.body as { metricIds?: string[]; selectedGroupId?: string };
    if (!Array.isArray(body.metricIds)) throw app.httpErrors.badRequest('metricIds array required');
    const selectedGroupId = String(body.selectedGroupId ?? '').trim();
    let groups: Array<{ id: string; name: string }> = [];
    let groupContextUnavailable = false;
    if (!selectedGroupId) {
      try {
        groups = await listUserGroupIds(session, session.userId);
      } catch {
        groupContextUnavailable = true;
      }
    }
    return getFollowState(
      session,
      session.userId,
      groups.map((g) => g.id),
      body.metricIds,
      { selectedGroupId: selectedGroupId || undefined, groupContextUnavailable },
    );
  });

  app.get('/api/pulse/groups', async () => {
    const session = requireSession();
    return { groups: await listUserGroupIds(session, session.userId) };
  });

  app.get('/api/pulse/follow-targets', async () => {
    const session = requireSession();
    // No server-side search: REST API 3.27 rejects `name:has:` (400065). The
    // client loads the full inventory once and filters locally.
    return getFollowTargets(session);
  });

  app.post('/api/pulse/follow', async (req) => {
    const session = requireSession();
    const operations = requireFollowOperations(app, req.body);
    return { results: await followTargets(session, { operations }) };
  });

  app.post('/api/pulse/unfollow', async (req) => {
    const session = requireSession();
    const operations = requireFollowOperations(app, req.body);
    return { results: await unfollowTargets(session, { operations }) };
  });

  app.post('/api/pulse/followers-detail', async (req) => {
    const session = requireSession();
    const body = req.body as { metricIds?: string[] };
    if (!Array.isArray(body.metricIds)) throw app.httpErrors.badRequest('metricIds array required');
    return { details: await getFollowersDetail(session, body.metricIds) };
  });

  app.post('/api/pulse/fork', async (req) => {
    const session = requireSession();
    const body = req.body as { forks?: Array<{ sourceMetricId?: string; timeframeKey?: string; customDays?: number }> };
    if (!Array.isArray(body.forks) || body.forks.length === 0) {
      throw app.httpErrors.badRequest('forks with sourceMetricId and timeframeKey required');
    }
    if (body.forks.some((fork) => !fork?.sourceMetricId || !fork?.timeframeKey)) {
      throw app.httpErrors.badRequest('every fork requires sourceMetricId and timeframeKey');
    }
    const forks = body.forks as Array<{ sourceMetricId: string; timeframeKey: string; customDays?: number }>;
    return executeLegacyPulseForks(session, forks, forkPlanService);
  });

  app.post('/api/pulse/delete', async (req) => {
    const session = requireSession();
    const body = req.body as {
      entries?: Array<{ definitionId?: string; metricIds?: string[]; name?: string }>;
    };
    const entries = (body.entries ?? [])
      .map((e) => ({
        definitionId: e.definitionId,
        metricIds: Array.isArray(e.metricIds) ? e.metricIds : [],
        name: e.name ?? '',
      }))
      .filter((e) => e.definitionId || e.metricIds.length > 0);
    if (entries.length === 0) throw app.httpErrors.badRequest('entries required');

    // Undo window support: delete the whole run recorded in the audit ledger
    return executeDeletes(session, entries);
  });
}

export async function executeLegacyPulseForks(
  session: TableauSession,
  forks: LegacyPulseForkRequest[],
  forkPlanService: Pick<PulseForkPlanService, 'forkMetrics'>,
): Promise<{ outcomes: Array<Record<string, unknown>> }> {
  const { groups, chunks } = prepareLegacyForkChunks(forks);
  let terminated = false;
  const completed = await mapWithConcurrency(
    chunks,
    LEGACY_FORK_CHUNK_CONCURRENCY,
    async (chunk) => {
      if (!terminated) {
        try {
          const summary = await forkPlanService.forkMetrics(session, chunk.plan);
          terminated = summary.terminated === true;
          return { groupKey: chunk.groupKey, summary };
        } catch (error) {
          // This chunk never returned mutation receipts. Preserve prior chunks and
          // stop future work rather than replacing the whole batch with an error.
          terminated = true;
          return { groupKey: chunk.groupKey, summary: { results: chunk.plan.sourceMetricIds.map((sourceMetricId): PulseForkPlanResult => ({
            sourceMetricId, status: 'failed', creationStatus: 'unknown', requestedSpecification: {},
            error: `Fork receipt unavailable: ${error instanceof Error ? error.message : String(error)}`,
          })) } };
        }
      }
      return { groupKey: chunk.groupKey, summary: { results: chunk.plan.sourceMetricIds.map((sourceMetricId): PulseForkPlanResult => ({
        sourceMetricId, status: 'failed', creationStatus: 'not_attempted', requestedSpecification: {},
        error: 'Not sent because an earlier fork batch terminated. Reconnect before retrying.',
      })) } };
    },
  );

  const resultsByGroup = new Map<string, Map<string, PulseForkPlanResult>>();
  for (const { groupKey, summary } of completed) {
    let results = resultsByGroup.get(groupKey);
    if (!results) {
      results = new Map<string, PulseForkPlanResult>();
      resultsByGroup.set(groupKey, results);
    }
    for (const result of summary.results) results.set(result.sourceMetricId, result);
  }

  return {
    outcomes: groups
      .flatMap((group) => group.requests.map((request) => {
        const result = resultsByGroup.get(group.key)?.get(request.sourceMetricId);
        return {
          index: request.index,
          sourceMetricId: request.sourceMetricId,
          definitionId: null,
          derivedMetricId: result?.metricId ?? null,
          created: result?.creationStatus === 'created',
          creationStatus: result?.creationStatus,
          status: result?.status ?? 'failed',
          reconciliationStatus: result?.reconciliationStatus,
          requestedSpecification: result?.requestedSpecification,
          label: group.label,
          ...(result?.error
            ? { error: result.error }
            : result
              ? {}
              : { error: 'The canonical fork service returned no result for this source metric.' }),
        };
      }))
      .sort((left, right) => left.index - right.index)
      .map(({ index: _index, ...outcome }) => outcome),
  };
}

function prepareLegacyForkChunks(
  forks: LegacyPulseForkRequest[],
): { groups: LegacyPulseForkGroup[]; chunks: PreparedLegacyForkChunk[] } {
  if (!Array.isArray(forks) || forks.length === 0) {
    throw new PulseForkPlanError('forks with sourceMetricId and timeframeKey required');
  }

  const groupsByKey = new Map<string, LegacyPulseForkGroup>();
  for (const [index, fork] of forks.entries()) {
    if (!fork || typeof fork.sourceMetricId !== 'string' || typeof fork.timeframeKey !== 'string') {
      throw new PulseForkPlanError('every fork requires sourceMetricId and timeframeKey');
    }
    const sourceMetricId = fork.sourceMetricId.trim();
    const timeframeKey = fork.timeframeKey.trim();
    const key = `${timeframeKey}\u0000${fork.customDays ?? ''}`;
    let group = groupsByKey.get(key);
    if (!group) {
      const timeframe = resolveTimeframe(timeframeKey, fork.customDays);
      if (!timeframe) throw new PulseForkPlanError(`Unknown or invalid timeframe ${timeframeKey}.`);
      group = {
        key,
        timeframeKey,
        ...(fork.customDays === undefined ? {} : { customDays: fork.customDays }),
        label: timeframe.label,
        requests: [],
      };
      groupsByKey.set(key, group);
    }
    group.requests.push({ sourceMetricId, index });
  }

  const groups = [...groupsByKey.values()];
  const chunks: PreparedLegacyForkChunk[] = [];
  for (const group of groups) {
    const sourceMetricIds = [...new Set(group.requests.map((request) => request.sourceMetricId))];
    for (let index = 0; index < sourceMetricIds.length; index += DATE_FORK_BATCH_SIZE) {
      const plan = canonicalizeForkPlanRequest({
        version: 1,
        sourceMetricIds: sourceMetricIds.slice(index, index + DATE_FORK_BATCH_SIZE),
        timeframe: {
          key: group.timeframeKey,
          ...(group.customDays === undefined ? {} : { customDays: group.customDays }),
        },
        clauses: [],
      });
      chunks.push({ groupKey: group.key, plan });
    }
  }
  return { groups, chunks };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await worker(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return results;
}

function requireFollowOperations(app: FastifyInstance, body: unknown): FollowTargetOperation[] {
  const candidate = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { operations?: unknown }).operations
    : undefined;
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw app.httpErrors.badRequest('operations array required');
  }
  const operations: FollowTargetOperation[] = [];
  for (const entry of candidate) {
    const operation = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry as { metricId?: unknown; target?: unknown }
      : null;
    const target = operation?.target && typeof operation.target === 'object' && !Array.isArray(operation.target)
      ? operation.target as { id?: unknown; kind?: unknown }
      : null;
    if (
      typeof operation?.metricId !== 'string'
      || operation.metricId.trim().length === 0
      || typeof target?.id !== 'string'
      || target.id.trim().length === 0
      || (target.kind !== 'GROUP' && target.kind !== 'USER')
    ) {
      throw app.httpErrors.badRequest('every operation requires an exact metricId and a GROUP or USER target');
    }
    operations.push({
      metricId: operation.metricId,
      target: { id: target.id, kind: target.kind },
    });
  }
  return operations;
}

export function repeatedQueryValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  return value === undefined || value === null ? [] : [String(value)];
}
