import {
  resolveTimeframe,
  timeframeLabelForMeasurementPeriod,
  type TimeframeSpec,
} from '@pulse-metric-studio/shared';
import type { TableauSession } from '@pulse-metric-studio/core';
import { TableauError, apiPath, getJson, isPastEndError } from '@pulse-metric-studio/core';
import {
  batchCreateGroupSubscriptions,
  batchCreateUserSubscriptions,
  batchGetFollowerCounts,
  deleteDefinition,
  deleteMetric,
  deleteSubscription,
  getOrCreatePulseMetric,
  getPulseDefinition,
  getPulseMetric,
  getTableauUserName,
  listDefinitionsInventory,
  listMetricsForDefinition,
  listTableauGroups,
  listTableauUsers,
  listSubscriptionsForMetric,
  type FollowerCountBatchResult,
  type PulseDefinition,
  type PulseDefinitionInventory,
  type PulseExactMetric,
  type SubscriptionRecord,
} from './pulse-client.js';
import {
  metricDefinitionId,
  metricSpecification,
  reconcileMetricOwnership,
  type MetricReconciliationResult,
} from './reconciliation.js';
import {
  boundedProviderDiagnostic,
  diagnosticMessage,
  type PulseProviderDiagnostic,
} from './provider-diagnostics.js';

const PROVIDER_CONCURRENCY = 5;
const DEFINITION_CACHE_TTL_MS = 15_000;
const MAX_DEFINITION_CACHE_ENTRIES = 8;
const NAME_CACHE_TTL_MS = 5 * 60_000;
const MAX_NAME_CACHE_ENTRIES = 512;
export const FOLLOW_OPERATION_BATCH_LIMIT = 200;

export interface DefinitionNode {
  definitionId: string;
  name: string;
  description: string;
  measure: string;
  aggregation: string;
  timeDimension: string;
  metrics: MetricVariant[];
  inventoryStatus: 'complete' | 'partial' | 'unavailable';
}

export interface MetricVariant {
  metricId: string;
  name: string;
  measurementPeriod: unknown;
  timeframeLabel: string;
  filters: unknown[];
  comparison: unknown;
  isDefault: boolean | null;
  isScoped: boolean;
  scopedState: 'default' | 'filtered' | 'variant' | 'unknown';
  specification: Record<string, unknown>;
}

export interface InventoryFailure {
  definitionId: string;
  metricId?: string;
  stage: 'parse_definition' | 'list_metrics' | 'get_metric' | 'parse_metric';
  diagnostic: PulseProviderDiagnostic;
}

export interface ExistingMetricsResult {
  definitions: DefinitionNode[];
  totalScanned: number;
  truncated: boolean;
  failures: InventoryFailure[];
}

export interface PulseManageDependencies {
  listDefinitions(session: TableauSession): Promise<PulseDefinitionInventory>;
  listMetrics(session: TableauSession, definitionId: string): Promise<Array<{
    id?: string;
    metadata?: { id?: string; name?: string };
    is_default?: boolean;
  }>>;
  getMetric(session: TableauSession, metricId: string): Promise<PulseExactMetric>;
  getDefinition(session: TableauSession, definitionId: string): Promise<PulseDefinition>;
  getOrCreate(
    session: TableauSession,
    input: { definitionId: string; specification: Record<string, unknown> },
  ): Promise<{ metricId: string | null; created: boolean }>;
  reconcile(
    session: TableauSession,
    input: { metricId: string; definitionId: string; datasourceLuid: string },
  ): Promise<MetricReconciliationResult>;
  listSubscriptions(session: TableauSession, metricId: string): Promise<SubscriptionRecord[]>;
  createGroupSubscriptions(
    session: TableauSession,
    items: Array<{ metricId: string; groupId: string }>,
  ): Promise<Array<{ metricId: string; targetId: string; ok: boolean; alreadyExists: boolean; error?: string }>>;
  createUserSubscriptions(
    session: TableauSession,
    items: Array<{ metricId: string; userId: string }>,
  ): Promise<Array<{ metricId: string; targetId: string; ok: boolean; alreadyExists: boolean; error?: string }>>;
  deleteSubscription(session: TableauSession, subscriptionId: string): Promise<void>;
  followerCounts(session: TableauSession, metricIds: string[]): Promise<FollowerCountBatchResult>;
  getUserName(session: TableauSession, userId: string): Promise<string | null>;
  listGroups(session: TableauSession): Promise<Array<{ id: string; name: string }>>;
  listUsers(session: TableauSession): Promise<Array<{ id: string; name: string }>>;
}

const defaultDependencies: PulseManageDependencies = {
  listDefinitions: listDefinitionsInventory,
  listMetrics: listMetricsForDefinition,
  getMetric: getPulseMetric,
  getDefinition: getPulseDefinition,
  getOrCreate: getOrCreatePulseMetric,
  reconcile: reconcileMetricOwnership,
  listSubscriptions: listSubscriptionsForMetric,
  createGroupSubscriptions: batchCreateGroupSubscriptions,
  createUserSubscriptions: batchCreateUserSubscriptions,
  deleteSubscription,
  followerCounts: batchGetFollowerCounts,
  getUserName: getTableauUserName,
  listGroups: listTableauGroups,
  listUsers: listTableauUsers,
};

interface DefinitionCacheEntry {
  inventory: PulseDefinitionInventory;
  expiresAt: number;
}

interface NameCacheEntry {
  name: string | null;
  expiresAt: number;
}

const definitionCache = new Map<string, DefinitionCacheEntry>();
const nameCache = new Map<string, NameCacheEntry>();

export async function getExistingMetrics(
  session: TableauSession,
  datasourceLuid: string,
  dependencies: PulseManageDependencies = defaultDependencies,
): Promise<ExistingMetricsResult> {
  const inventory = dependencies === defaultDependencies
    ? await cachedDefinitionInventory(session, dependencies)
    : await dependencies.listDefinitions(session);
  const failures: InventoryFailure[] = [];
  const matching: PulseDefinition[] = [];
  for (const [index, candidate] of inventory.definitions.entries()) {
    const inventoryId = `inventory-record-${index + 1}`;
    if (!isRecord(candidate)) {
      failures.push({
        definitionId: inventoryId,
        stage: 'parse_definition',
        diagnostic: { message: 'Pulse definition inventory record must be an object.' },
      });
      continue;
    }
    const definition = candidate as PulseDefinition;
    const metadata = isRecord(definition.metadata) ? definition.metadata : undefined;
    const definitionId = stringValue(metadata?.id);
    if (!definitionId) {
      failures.push({
        definitionId: inventoryId,
        stage: 'parse_definition',
        diagnostic: { message: 'Pulse definition inventory record has no definition identifier.' },
      });
      continue;
    }
    const specification = isRecord(definition.specification) ? definition.specification : undefined;
    const datasource = isRecord(specification?.datasource) ? specification.datasource : undefined;
    const definitionDatasourceLuid = stringValue(datasource?.id);
    if (!definitionDatasourceLuid) {
      failures.push({
        definitionId,
        stage: 'parse_definition',
        diagnostic: { message: 'Pulse definition inventory record has no datasource identifier.' },
      });
      continue;
    }
    if (definitionDatasourceLuid === datasourceLuid) matching.push(definition);
  }

  const nodes = await mapWithConcurrency(matching, PROVIDER_CONCURRENCY, async (definition) => {
    const definitionId = String(definition.metadata?.id ?? '').trim();
    if (!definitionId) return null;
    let summaries: Awaited<ReturnType<PulseManageDependencies['listMetrics']>>;
    try {
      summaries = await dependencies.listMetrics(session, definitionId);
    } catch (error) {
      if (error instanceof TableauError && error.kind === 'auth') throw error;
      failures.push({ definitionId, stage: 'list_metrics', diagnostic: boundedProviderDiagnostic(error) });
      return definitionNode(definition, definitionId, [], 'unavailable');
    }

    const variants = await mapWithConcurrency(summaries, PROVIDER_CONCURRENCY, async (summary) => {
      const summaryRecord = isRecord(summary) ? summary : undefined;
      const summaryMetadata = isRecord(summaryRecord?.metadata) ? summaryRecord.metadata : undefined;
      const metricId = stringValue(summaryRecord?.id ?? summaryMetadata?.id);
      if (!metricId) {
        failures.push({
          definitionId,
          stage: 'parse_metric',
          diagnostic: { message: 'Pulse metric inventory record has no metric identifier.' },
        });
        return null;
      }
      let metric: PulseExactMetric;
      try {
        metric = await dependencies.getMetric(session, metricId);
      } catch (error) {
        if (error instanceof TableauError && error.kind === 'auth') throw error;
        failures.push({ definitionId, metricId, stage: 'get_metric', diagnostic: boundedProviderDiagnostic(error) });
        return null;
      }
      try {
        const returnedMetricId = pulseMetricId(metric);
        if (returnedMetricId && returnedMetricId !== metricId) {
          throw new Error(`Exact metric endpoint returned ${returnedMetricId} for ${metricId}.`);
        }
        const returnedDefinitionId = metricDefinitionId(metric);
        if (!returnedDefinitionId || returnedDefinitionId !== definitionId) {
          throw new Error(`Exact metric ${metricId} belongs to definition ${returnedDefinitionId || 'unknown'}.`);
        }
        return exactMetricVariant(metricId, summaryRecord as Parameters<typeof exactMetricVariant>[1], metric);
      } catch (error) {
        failures.push({ definitionId, metricId, stage: 'parse_metric', diagnostic: boundedProviderDiagnostic(error) });
        return null;
      }
    });
    const metrics = variants.filter((variant): variant is MetricVariant => variant !== null);
    return definitionNode(
      definition,
      definitionId,
      metrics,
      summaries.length === metrics.length ? 'complete' : 'partial',
    );
  });

  return {
    definitions: nodes.filter((node): node is DefinitionNode => node !== null),
    totalScanned: inventory.definitions.length,
    truncated: inventory.truncated,
    failures: failures.sort(compareInventoryFailures),
  };
}

function definitionNode(
  definition: PulseDefinition,
  definitionId: string,
  metrics: MetricVariant[],
  inventoryStatus: DefinitionNode['inventoryStatus'],
): DefinitionNode {
  return {
    definitionId,
    name: definition.metadata?.name ?? definitionId,
    description: definition.metadata?.description ?? '',
    measure: definition.specification?.basic_specification?.measure?.field ?? '?',
    aggregation: String(definition.specification?.basic_specification?.measure?.aggregation ?? '')
      .replace(/^AGGREGATION_/, '')
      .replaceAll('_', ' '),
    timeDimension: definition.specification?.basic_specification?.time_dimension?.field ?? '?',
    metrics,
    inventoryStatus,
  };
}

function exactMetricVariant(
  metricId: string,
  summary: { metadata?: { name?: string }; is_default?: boolean },
  metric: PulseExactMetric,
): MetricVariant {
  const specification = metricSpecification(metric);
  if (!specification) throw new Error('Exact metric response has no specification.');
  if (specification.filters !== undefined && !Array.isArray(specification.filters)) {
    throw new Error('Exact metric specification filters must be an array.');
  }
  const filters = structuredClone((specification.filters ?? []) as unknown[]);
  const measurementPeriod = structuredClone(specification.measurement_period ?? null);
  const comparison = structuredClone(specification.comparison ?? null);
  const isDefault = typeof metric.is_default === 'boolean'
    ? metric.is_default
    : typeof summary.is_default === 'boolean'
      ? summary.is_default
      : null;
  const scopedState: MetricVariant['scopedState'] = filters.length > 0
    ? 'filtered'
    : isDefault === true
      ? 'default'
      : isDefault === false
        ? 'variant'
        : 'unknown';
  return {
    metricId,
    name: metric.metadata?.name ?? summary.metadata?.name ?? metricId,
    measurementPeriod,
    timeframeLabel: timeframeLabelForMeasurementPeriod(measurementPeriod),
    filters,
    comparison,
    isDefault,
    isScoped: filters.length > 0,
    scopedState,
    specification: structuredClone(specification),
  };
}

export async function cachedDefinitionInventory(
  session: TableauSession,
  dependencies: PulseManageDependencies,
): Promise<PulseDefinitionInventory> {
  const now = Date.now();
  const key = definitionCacheKey(session);
  const cached = definitionCache.get(key);
  if (cached && cached.expiresAt > now) {
    touch(definitionCache, key, cached);
    return structuredClone(cached.inventory);
  }
  const inventory = await dependencies.listDefinitions(session);
  definitionCache.set(key, { inventory: structuredClone(inventory), expiresAt: now + DEFINITION_CACHE_TTL_MS });
  while (definitionCache.size > MAX_DEFINITION_CACHE_ENTRIES) {
    const oldest = definitionCache.keys().next().value as string | undefined;
    if (!oldest) break;
    definitionCache.delete(oldest);
  }
  return inventory;
}

export function invalidatePulseDefinitionInventory(session: TableauSession): void {
  definitionCache.delete(definitionCacheKey(session));
}

function definitionCacheKey(session: TableauSession): string {
  return `${session.serverUrl}\u0000${session.siteId}\u0000${session.userId}`;
}

export interface MetricAvailability {
  status: 'available' | 'partial' | 'unavailable';
  relationshipStatus: 'available' | 'partial' | 'unavailable';
  followerCountStatus: 'available' | 'unavailable';
  diagnostics: PulseProviderDiagnostic[];
}

export interface FollowStateResult {
  userFollowsByMetricId: Record<string, boolean>;
  groupFollowsByMetricId: Record<string, boolean>;
  /**
   * Distinct GROUP follower ids per metric, taken straight from the metric's
   * subscription list (membership-agnostic, exactly like the followers modal).
   * Set only when the subscription list loaded; the row summary aggregates these
   * to report the true number of groups following, not just "a group I belong to
   * follows".
   */
  groupFollowerIdsByMetricId: Record<string, string[]>;
  /**
   * Distinct USER follower ids per metric, taken straight from the metric's
   * subscription list (membership-agnostic, mirroring groupFollowerIdsByMetricId).
   * Set only when the subscription list loaded; the row summary aggregates these
   * to report the true number of individuals following, not just "I follow".
   */
  userFollowerIdsByMetricId: Record<string, string[]>;
  followerCountsByMetricId: Record<string, number>;
  availabilityByMetricId: Record<string, MetricAvailability>;
  selectedGroupId: string | null;
  groupContextUnavailable: boolean;
  errors: string[];
}

export async function getFollowState(
  session: TableauSession,
  userId: string,
  userGroupIds: string[],
  metricIds: string[],
  options: { selectedGroupId?: string; groupContextUnavailable?: boolean } = {},
  dependencies: PulseManageDependencies = defaultDependencies,
): Promise<FollowStateResult> {
  const uniqueMetricIds = canonicalIds(metricIds);
  const selectedGroupId = String(options.selectedGroupId ?? '').trim();
  const result: FollowStateResult = {
    userFollowsByMetricId: {},
    groupFollowsByMetricId: {},
    groupFollowerIdsByMetricId: {},
    userFollowerIdsByMetricId: {},
    followerCountsByMetricId: {},
    availabilityByMetricId: {},
    selectedGroupId: selectedGroupId || null,
    groupContextUnavailable: options.groupContextUnavailable === true,
    errors: [],
  };
  if (uniqueMetricIds.length === 0) return result;

  let countResult: FollowerCountBatchResult;
  try {
    countResult = await dependencies.followerCounts(session, uniqueMetricIds);
  } catch (error) {
    if (error instanceof TableauError && error.kind === 'auth') throw error;
    const message = diagnosticMessage(boundedProviderDiagnostic(error));
    countResult = {
      countsByMetricId: {},
      errorsByMetricId: Object.fromEntries(uniqueMetricIds.map((metricId) => [metricId, { message }])),
    };
  }
  Object.assign(result.followerCountsByMetricId, countResult.countsByMetricId);

  const subscriptionResults = await mapWithConcurrency(uniqueMetricIds, PROVIDER_CONCURRENCY, async (metricId) => {
    try {
      return { metricId, subscriptions: await dependencies.listSubscriptions(session, metricId) };
    } catch (error) {
      if (error instanceof TableauError && error.kind === 'auth') throw error;
      return { metricId, subscriptions: null, diagnostic: boundedProviderDiagnostic(error) };
    }
  });

  const groupIds = new Set(selectedGroupId ? [selectedGroupId] : canonicalIds(userGroupIds));
  for (const entry of subscriptionResults) {
    const diagnostics: PulseProviderDiagnostic[] = [];
    const countError = countResult.errorsByMetricId[entry.metricId];
    if (countError) diagnostics.push(countError);
    if (entry.diagnostic) diagnostics.push(entry.diagnostic);
    if (result.groupContextUnavailable) diagnostics.push({ message: 'Tableau group context is unavailable.' });
    const hasUnknownFollowerType = entry.subscriptions?.some(
      (subscription) => subscription.follower.type === 'UNKNOWN',
    ) === true;
    if (hasUnknownFollowerType) {
      diagnostics.push({ message: 'Tableau returned a follower with an unsupported follower type.' });
    }

    if (entry.subscriptions) {
      const userFollows = entry.subscriptions.some(
        (subscription) => subscription.follower.type === 'USER' && subscription.follower.id === userId,
      );
      const groupFollows = entry.subscriptions.some(
        (subscription) => subscription.follower.type === 'GROUP' && groupIds.has(subscription.follower.id),
      );
      if (userFollows || !hasUnknownFollowerType) {
        result.userFollowsByMetricId[entry.metricId] = userFollows;
      }
      if (!result.groupContextUnavailable && (groupFollows || !hasUnknownFollowerType)) {
        result.groupFollowsByMetricId[entry.metricId] = groupFollows;
      }
      // Distinct group followers for the row summary. This is independent of the
      // current user's group membership, so a group the user is not in still
      // counts, and the count updates as followers are added or removed.
      result.groupFollowerIdsByMetricId[entry.metricId] = [...new Set(
        entry.subscriptions
          .filter((subscription) => subscription.follower.type === 'GROUP')
          .map((subscription) => subscription.follower.id),
      )];
      // Distinct individual (USER) followers for the row summary, mirroring the
      // group list. Independent of whether the current user is one of them, so
      // the count reflects every person following, not just "I follow".
      result.userFollowerIdsByMetricId[entry.metricId] = [...new Set(
        entry.subscriptions
          .filter((subscription) => subscription.follower.type === 'USER')
          .map((subscription) => subscription.follower.id),
      )];
    }

    const subscriptionAvailable = entry.subscriptions !== null;
    const countAvailable = !countError;
    const relationshipStatus: MetricAvailability['relationshipStatus'] = !subscriptionAvailable
      ? 'unavailable'
      : result.groupContextUnavailable || hasUnknownFollowerType
        ? 'partial'
        : 'available';
    const followerCountStatus: MetricAvailability['followerCountStatus'] = countAvailable
      ? 'available'
      : 'unavailable';
    const status: MetricAvailability['status'] = relationshipStatus === 'available' && countAvailable
      ? 'available'
      : relationshipStatus !== 'unavailable' || countAvailable
        ? 'partial'
        : 'unavailable';
    result.availabilityByMetricId[entry.metricId] = {
      status,
      relationshipStatus,
      followerCountStatus,
      diagnostics,
    };
    result.errors.push(...diagnostics.map((diagnostic) => `${entry.metricId}: ${diagnosticMessage(diagnostic)}`));
  }
  return result;
}

export async function listUserGroupIds(session: TableauSession, userId: string): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = [];
  let pageNumber = 1;
  const pageSize = 1000;
  for (;;) {
    let data: unknown;
    try {
      data = await getJson<unknown>(
        session,
        apiPath(session, `/sites/${encodeURIComponent(session.siteId)}/users/${encodeURIComponent(userId)}/groups?pageSize=${pageSize}&pageNumber=${pageNumber}`),
      );
    } catch (error) {
      if (isPastEndError(error)) break;
      throw error;
    }
    if (!isRecord(data)) throw new Error('Unsupported Tableau user-groups response shape.');
    let groupsRaw: unknown;
    if (Object.hasOwn(data, 'groups')) {
      if (!isRecord(data.groups)) throw new Error('Unsupported Tableau user-groups response shape.');
      groupsRaw = data.groups.group;
    } else if (Object.hasOwn(data, 'group')) {
      groupsRaw = data.group;
    } else {
      throw new Error('Unsupported Tableau user-groups response shape.');
    }
    const groups = recordCollection(groupsRaw, 'Tableau user-groups');
    out.push(...groups.map((group) => {
      const id = stringValue(group.id ?? group.luid);
      const name = stringValue(group.name);
      if (!id || !name) throw new Error('Unsupported Tableau user-groups record shape.');
      return { id, name };
    }));
    if (groups.length < pageSize) break;
    pageNumber++;
  }
  return out;
}

export interface ListTarget {
  id: string;
  name?: string;
  kind: 'GROUP' | 'USER';
}

export interface FollowTargetOperation {
  metricId: string;
  target: { id: string; kind: 'GROUP' | 'USER' };
}

export type FollowTargetOperationStatus =
  | 'followed'
  | 'already_followed'
  | 'unfollowed'
  | 'not_followed'
  | 'failed';

export interface FollowTargetOperationResult {
  metricId: string;
  targetId: string;
  targetKind: 'GROUP' | 'USER';
  status: FollowTargetOperationStatus;
  ok: boolean;
  error?: string;
}

export function buildFollowTargets(groups: Array<{ id: string; name: string }>, users: Array<{ id: string; name: string }>): ListTarget[] {
  return [
    ...groups.map((group) => ({ ...group, kind: 'GROUP' as const })),
    ...users.map((user) => ({ ...user, kind: 'USER' as const })),
  ].sort((left, right) => String(left.name ?? '').localeCompare(String(right.name ?? '')));
}

export async function followTargets(
  session: TableauSession,
  input: { operations: FollowTargetOperation[] },
  dependencies: PulseManageDependencies = defaultDependencies,
): Promise<FollowTargetOperationResult[]> {
  const operations = canonicalFollowOperations(input.operations);
  const results = new Map<string, FollowTargetOperationResult>();
  const subscriptionsByMetricId = new Map<string, SubscriptionRecord[] | null>();
  const metricIds = [...new Set(operations.map((operation) => operation.metricId))];

  await mapWithConcurrency(metricIds, PROVIDER_CONCURRENCY, async (metricId) => {
    try {
      subscriptionsByMetricId.set(metricId, await dependencies.listSubscriptions(session, metricId));
    } catch (error) {
      if (error instanceof TableauError && error.kind === 'auth') throw error;
      subscriptionsByMetricId.set(metricId, null);
    }
  });

  const pending = operations.filter((operation) => {
    const subscriptions = subscriptionsByMetricId.get(operation.metricId);
    const alreadyFollowed = subscriptions?.some((subscription) => (
      subscription.follower.id === operation.target.id
      && subscription.follower.type === operation.target.kind
    ));
    if (!alreadyFollowed) return true;
    results.set(followOperationKey(operation), operationResult(operation, 'already_followed', true));
    return false;
  });

  for (const kind of ['GROUP', 'USER'] as const) {
    const kindOperations = pending.filter((operation) => operation.target.kind === kind);
    for (let index = 0; index < kindOperations.length; index += FOLLOW_OPERATION_BATCH_LIMIT) {
      const batch = kindOperations.slice(index, index + FOLLOW_OPERATION_BATCH_LIMIT);
      try {
        const created = kind === 'GROUP'
          ? await dependencies.createGroupSubscriptions(
            session,
            batch.map((operation) => ({ metricId: operation.metricId, groupId: operation.target.id })),
          )
          : await dependencies.createUserSubscriptions(
            session,
            batch.map((operation) => ({ metricId: operation.metricId, userId: operation.target.id })),
          );
        const createdByKey = new Map(created.map((result) => [
          followOperationKeyParts(result.metricId, kind, result.targetId),
          result,
        ]));
        for (const operation of batch) {
          const createdResult = createdByKey.get(followOperationKey(operation));
          if (!createdResult) {
            results.set(followOperationKey(operation), operationResult(
              operation,
              'failed',
              false,
              'Tableau returned no result for this metric and target.',
            ));
          } else if (createdResult.ok) {
            results.set(followOperationKey(operation), operationResult(
              operation,
              createdResult.alreadyExists ? 'already_followed' : 'followed',
              true,
            ));
          } else {
            results.set(followOperationKey(operation), operationResult(
              operation,
              'failed',
              false,
              createdResult.error ?? 'Tableau rejected the follow request.',
            ));
          }
        }
      } catch (error) {
        if (error instanceof TableauError && error.kind === 'auth') throw error;
        const message = diagnosticMessage(boundedProviderDiagnostic(error));
        for (const operation of batch) {
          results.set(followOperationKey(operation), operationResult(operation, 'failed', false, message));
        }
      }
    }
  }

  return operations.map((operation) => results.get(followOperationKey(operation))
    ?? operationResult(operation, 'failed', false, 'The follow operation did not produce a result.'));
}

export async function unfollowTargets(
  session: TableauSession,
  input: { operations: FollowTargetOperation[] },
  dependencies: PulseManageDependencies = defaultDependencies,
): Promise<FollowTargetOperationResult[]> {
  const operations = canonicalFollowOperations(input.operations);
  const operationsByMetricId = new Map<string, FollowTargetOperation[]>();
  for (const operation of operations) {
    const metricOperations = operationsByMetricId.get(operation.metricId) ?? [];
    metricOperations.push(operation);
    operationsByMetricId.set(operation.metricId, metricOperations);
  }
  const metricResults = await mapWithConcurrency([...operationsByMetricId], PROVIDER_CONCURRENCY, async ([metricId, metricOperations]) => {
    try {
      const subscriptions = await dependencies.listSubscriptions(session, metricId);
      return mapWithConcurrency(metricOperations, PROVIDER_CONCURRENCY, async (operation) => {
        const matches = subscriptions.filter((subscription) => (
          subscription.follower.id === operation.target.id
          && subscription.follower.type === operation.target.kind
        ));
        if (matches.length === 0) return operationResult(operation, 'not_followed', true);
        if (matches.some((subscription) => !subscription.id)) {
          return operationResult(
            operation,
            'failed',
            false,
            'A matching subscription has no deletable subscription identifier.',
          );
        }
        try {
          await mapWithConcurrency(matches, PROVIDER_CONCURRENCY, async (subscription) => {
            await dependencies.deleteSubscription(session, subscription.id!);
          });
          return operationResult(operation, 'unfollowed', true);
        } catch (error) {
          if (error instanceof TableauError && error.kind === 'auth') throw error;
          return operationResult(operation, 'failed', false, diagnosticMessage(boundedProviderDiagnostic(error)));
        }
      });
    } catch (error) {
      if (error instanceof TableauError && error.kind === 'auth') throw error;
      const message = diagnosticMessage(boundedProviderDiagnostic(error));
      return metricOperations.map((operation) => operationResult(operation, 'failed', false, message));
    }
  });
  const resultsByKey = new Map(metricResults.flat().map((result) => [
    followOperationKeyParts(result.metricId, result.targetKind, result.targetId),
    result,
  ]));
  return operations.map((operation) => resultsByKey.get(followOperationKey(operation))
    ?? operationResult(operation, 'failed', false, 'The unfollow operation did not produce a result.'));
}

export interface FollowersDetail {
  metricId: string;
  followers: Array<{ id: string; name: string; type: 'USER' | 'GROUP' | 'UNKNOWN' }>;
  status: 'available' | 'partial' | 'unavailable';
  diagnostics: PulseProviderDiagnostic[];
  errors: string[];
}

export async function getFollowersDetail(
  session: TableauSession,
  metricIds: string[],
  dependencies: PulseManageDependencies = defaultDependencies,
): Promise<FollowersDetail[]> {
  const uniqueMetricIds = canonicalIds(metricIds);
  const loaded = await mapWithConcurrency(uniqueMetricIds, PROVIDER_CONCURRENCY, async (metricId) => {
    try {
      return { metricId, subscriptions: await dependencies.listSubscriptions(session, metricId) };
    } catch (error) {
      if (error instanceof TableauError && error.kind === 'auth') throw error;
      return { metricId, subscriptions: null, diagnostic: boundedProviderDiagnostic(error) };
    }
  });

  const followerKeys = new Map<string, { id: string; type: SubscriptionRecord['follower']['type']; name?: string }>();
  for (const entry of loaded) {
    for (const subscription of entry.subscriptions ?? []) {
      const follower = subscription.follower;
      followerKeys.set(`${follower.type}\u0000${follower.id}`, follower);
    }
  }
  const entries = [...followerKeys.entries()];
  const resolvedNames = new Map<string, { name: string; diagnostic?: PulseProviderDiagnostic }>();

  // Group names come from a single site-group listing (Tableau REST has no
  // query-single-group endpoint), resolved once and cached for every group
  // follower across the requested metrics.
  const groupIdsToResolve = [...new Set(
    entries.filter(([, follower]) => !follower.name && follower.type === 'GROUP').map(([, follower]) => follower.id),
  )];
  let groupNames = new Map<string, string>();
  let groupResolutionDiagnostic: PulseProviderDiagnostic | undefined;
  if (groupIdsToResolve.length > 0) {
    try {
      groupNames = await cachedGroupNames(session, groupIdsToResolve, dependencies);
    } catch (error) {
      if (error instanceof TableauError && error.kind === 'auth') throw error;
      groupResolutionDiagnostic = boundedProviderDiagnostic(error);
    }
  }

  await mapWithConcurrency(entries, PROVIDER_CONCURRENCY, async ([key, follower]) => {
    if (follower.name) {
      resolvedNames.set(key, { name: follower.name });
      return;
    }
    if (follower.type === 'GROUP') {
      const name = groupNames.get(follower.id);
      if (name) {
        resolvedNames.set(key, { name });
      } else {
        resolvedNames.set(key, {
          name: follower.id,
          diagnostic: groupResolutionDiagnostic
            ?? { message: `Group ${follower.id} was not found in the site group listing.` },
        });
      }
      return;
    }
    if (follower.type === 'USER') {
      try {
        const name = await cachedUserName(session, follower.id, dependencies);
        resolvedNames.set(key, { name: name ?? follower.id });
      } catch (error) {
        if (error instanceof TableauError && error.kind === 'auth') throw error;
        resolvedNames.set(key, { name: follower.id, diagnostic: boundedProviderDiagnostic(error) });
      }
      return;
    }
    resolvedNames.set(key, {
      name: follower.id,
      diagnostic: { message: `Follower ${follower.id} has an unsupported follower type.` },
    });
  });

  return loaded.map((entry) => {
    if (!entry.subscriptions) {
      const diagnostic = entry.diagnostic ?? { message: 'Follower details are unavailable.' };
      return {
        metricId: entry.metricId,
        followers: [],
        status: 'unavailable' as const,
        diagnostics: [diagnostic],
        errors: [diagnosticMessage(diagnostic)],
      };
    }
    const diagnostics: PulseProviderDiagnostic[] = [];
    const followers = entry.subscriptions.map((subscription) => {
      const follower = subscription.follower;
      const resolved = resolvedNames.get(`${follower.type}\u0000${follower.id}`);
      if (resolved?.diagnostic) diagnostics.push(resolved.diagnostic);
      return { id: follower.id, name: resolved?.name ?? follower.name ?? follower.id, type: follower.type };
    });
    return {
      metricId: entry.metricId,
      followers: deduplicateFollowers(followers),
      status: diagnostics.length > 0 ? 'partial' as const : 'available' as const,
      diagnostics,
      errors: diagnostics.map(diagnosticMessage),
    };
  });
}

async function cachedUserName(
  session: TableauSession,
  userId: string,
  dependencies: PulseManageDependencies,
): Promise<string | null> {
  const now = Date.now();
  const key = nameCacheKey(session, 'USER', userId);
  const cached = nameCache.get(key);
  if (cached && cached.expiresAt > now) {
    touch(nameCache, key, cached);
    return cached.name;
  }
  const name = await dependencies.getUserName(session, userId);
  nameCache.set(key, { name, expiresAt: now + NAME_CACHE_TTL_MS });
  evictNameCache();
  return name;
}

/**
 * Resolve group ids to names, hitting the cache first and falling back to a
 * single site-group listing for the remaining ids. Returns only the ids that
 * resolved to a name; unknown ids are cached as misses so a follower that
 * vanished from the site does not re-list on every request.
 */
async function cachedGroupNames(
  session: TableauSession,
  groupIds: string[],
  dependencies: PulseManageDependencies,
): Promise<Map<string, string>> {
  const now = Date.now();
  const resolved = new Map<string, string>();
  const missing: string[] = [];
  for (const id of groupIds) {
    const key = nameCacheKey(session, 'GROUP', id);
    const cached = nameCache.get(key);
    if (cached && cached.expiresAt > now) {
      touch(nameCache, key, cached);
      if (cached.name) resolved.set(id, cached.name);
    } else {
      missing.push(id);
    }
  }
  if (missing.length > 0) {
    const groups = await dependencies.listGroups(session);
    const byId = new Map(groups.map((group) => [group.id, group.name]));
    for (const id of missing) {
      const name = byId.get(id) ?? null;
      nameCache.set(nameCacheKey(session, 'GROUP', id), { name, expiresAt: now + NAME_CACHE_TTL_MS });
      if (name) resolved.set(id, name);
    }
    evictNameCache();
  }
  return resolved;
}

function nameCacheKey(session: TableauSession, type: 'USER' | 'GROUP', id: string): string {
  return `${session.serverUrl}\u0000${session.siteId}\u0000${type}\u0000${id}`;
}

function evictNameCache(): void {
  while (nameCache.size > MAX_NAME_CACHE_ENTRIES) {
    const oldest = nameCache.keys().next().value as string | undefined;
    if (!oldest) break;
    nameCache.delete(oldest);
  }
}

export interface FollowTargetInventory {
  targets: ListTarget[];
  errors: string[];
}

/**
 * Merge the full site group and user inventory into a single follow-target list.
 * REST API 3.27 rejects server-side `name:has:` filtering (400065), so there is
 * no `search` here: the picker loads the whole inventory once and filters
 * locally. Both listings are exhaustive - the whole directory is always returned
 * so every group and user is selectable.
 */
export async function getFollowTargets(
  session: TableauSession,
  dependencies: PulseManageDependencies = defaultDependencies,
): Promise<FollowTargetInventory> {
  const errors: string[] = [];
  const [groupsResult, usersResult] = await Promise.allSettled([
    dependencies.listGroups(session),
    dependencies.listUsers(session),
  ]);

  let groups: Array<{ id: string; name: string }> = [];
  if (groupsResult.status === 'fulfilled') {
    groups = groupsResult.value;
  } else {
    rethrowIfAuth(groupsResult.reason);
    errors.push(`Group inventory unavailable: ${diagnosticMessage(boundedProviderDiagnostic(groupsResult.reason))}`);
  }

  let users: Array<{ id: string; name: string }> = [];
  if (usersResult.status === 'fulfilled') {
    users = usersResult.value;
  } else {
    rethrowIfAuth(usersResult.reason);
    errors.push(`User inventory unavailable: ${diagnosticMessage(boundedProviderDiagnostic(usersResult.reason))}`);
  }

  return { targets: buildFollowTargets(groups, users), errors };
}

function rethrowIfAuth(error: unknown): void {
  if (error instanceof TableauError && error.kind === 'auth') throw error;
}

export interface ForkItem {
  sourceMetricId: string;
  timeframeKey: string;
  customDays?: number;
}

export interface ForkOutcome {
  sourceMetricId: string;
  definitionId: string | null;
  derivedMetricId: string | null;
  created: boolean;
  creationStatus?: 'created' | 'existing' | 'unknown' | 'not_attempted';
  status: 'created' | 'existing' | 'failed';
  label: string;
  requestedSpecification?: Record<string, unknown>;
  reconciliationStatus?: MetricReconciliationResult['status'];
  exactMetricResolved?: boolean;
  inventoryVisible?: boolean;
  ownershipVerified?: boolean;
  diagnostic?: PulseProviderDiagnostic;
  error?: string;
}

export async function forkMetrics(
  session: TableauSession,
  forks: ForkItem[],
  dependencies: PulseManageDependencies = defaultDependencies,
): Promise<ForkOutcome[]> {
  const plans = new Map<string, { item: ForkItem; timeframe: TimeframeSpec; measurementPeriod: Record<string, unknown> }>();
  const rejected: ForkOutcome[] = [];
  for (const item of forks) {
    const sourceMetricId = String(item.sourceMetricId ?? '').trim();
    const timeframe = resolveTimeframe(item.timeframeKey, item.customDays);
    if (!sourceMetricId || !timeframe) {
      rejected.push({
        sourceMetricId,
        definitionId: null,
        derivedMetricId: null,
        created: false,
        status: 'failed',
        label: item.timeframeKey,
        error: `Unknown or invalid timeframe ${item.timeframeKey}`,
      });
      continue;
    }
    const measurementPeriod = timeframeMeasurementPeriod(timeframe);
    const key = `${sourceMetricId}\u0000${JSON.stringify(measurementPeriod)}`;
    plans.set(key, { item: { ...item, sourceMetricId }, timeframe, measurementPeriod });
  }

  const orderedPlans = [...plans.values()].sort((left, right) => {
    const metricOrder = left.item.sourceMetricId.localeCompare(right.item.sourceMetricId);
    return metricOrder || JSON.stringify(left.measurementPeriod).localeCompare(JSON.stringify(right.measurementPeriod));
  });
  let terminated = false;
  const outcomes = await mapWithConcurrency(orderedPlans, PROVIDER_CONCURRENCY, async (plan): Promise<ForkOutcome> => {
    const base = {
      sourceMetricId: plan.item.sourceMetricId,
      definitionId: null,
      derivedMetricId: null,
      created: false,
      status: 'failed' as const,
      label: plan.timeframe.label,
    };
    if (terminated) return { ...base, creationStatus: 'not_attempted', error: 'Not sent because the Tableau session ended. Reconnect before retrying.' };
    let confirmed: Partial<ForkOutcome> = {};
    let mutationStarted = false;
    try {
      const source = await dependencies.getMetric(session, plan.item.sourceMetricId);
      const returnedMetricId = pulseMetricId(source);
      if (returnedMetricId && returnedMetricId !== plan.item.sourceMetricId) {
        throw new Error(`Exact metric endpoint returned ${returnedMetricId} for ${plan.item.sourceMetricId}.`);
      }
      const sourceSiteId = source.site_id ?? source.site?.id;
      if (sourceSiteId && sourceSiteId !== session.siteId) {
        throw new Error(`Exact source metric belongs to site ${sourceSiteId}, not ${session.siteId}.`);
      }
      const definitionId = metricDefinitionId(source);
      const sourceSpecification = metricSpecification(source);
      if (!definitionId) throw new Error('Exact source metric has no definition identifier.');
      if (!sourceSpecification) throw new Error('Exact source metric has no specification.');
      const definition = await dependencies.getDefinition(session, definitionId);
      const datasourceLuid = definition.specification?.datasource?.id;
      if (!datasourceLuid) throw new Error(`Definition ${definitionId} has no datasource identifier.`);

      const specification = structuredClone(sourceSpecification);
      delete specification.datasource;
      specification.measurement_period = structuredClone(plan.measurementPeriod);
      if (terminated) return { ...base, creationStatus: 'not_attempted', error: 'Not sent because the Tableau session ended. Reconnect before retrying.' };
      mutationStarted = true;
      const response = await dependencies.getOrCreate(session, { definitionId, specification });
      if (response.metricId) confirmed = { definitionId, derivedMetricId: response.metricId, created: response.created, creationStatus: response.created ? 'created' : 'existing', requestedSpecification: specification, reconciliationStatus: 'failed' };
      if (!response.metricId) throw new Error('Tableau returned no metric identifier.');
      const reconciliation = await dependencies.reconcile(session, {
        metricId: response.metricId,
        definitionId,
        datasourceLuid,
      });
      const creationStatus = response.created ? 'created' as const : 'existing' as const;
      const reconciliationFailed = reconciliation.status === 'ownership_mismatch'
        || reconciliation.status === 'failed';
      return {
        sourceMetricId: plan.item.sourceMetricId,
        definitionId,
        derivedMetricId: response.metricId,
        created: response.created,
        creationStatus,
        status: reconciliationFailed ? 'failed' : creationStatus,
        label: plan.timeframe.label,
        requestedSpecification: specification,
        reconciliationStatus: reconciliation.status,
        exactMetricResolved: reconciliation.exactMetricResolved,
        inventoryVisible: reconciliation.inventoryVisible,
        ownershipVerified: reconciliation.ownershipVerified,
        ...(reconciliation.diagnostic ? { diagnostic: reconciliation.diagnostic } : {}),
        ...(reconciliationFailed
          ? { error: reconciliation.diagnostic
            ? diagnosticMessage(reconciliation.diagnostic)
            : 'Metric reconciliation failed.' }
          : {}),
      };
    } catch (error) {
      if (error instanceof TableauError && error.kind === 'auth') terminated = true;
      const diagnostic = boundedProviderDiagnostic(error);
      return { ...base, creationStatus: mutationStarted ? 'unknown' : 'not_attempted', ...confirmed, diagnostic, error: diagnosticMessage(diagnostic) };
    }
  });
  return [...outcomes, ...rejected].sort((left, right) => (
    left.sourceMetricId.localeCompare(right.sourceMetricId) || left.label.localeCompare(right.label)
  ));
}

export function timeframeMeasurementPeriod(timeframe: TimeframeSpec): Record<string, unknown> {
  return {
    granularity: timeframe.granularity,
    range: timeframe.range,
    ...(timeframe.lastXPeriod ? { last_x_period: structuredClone(timeframe.lastXPeriod) } : {}),
  };
}

export interface DeletePlanEntry {
  definitionId?: string;
  metricIds: string[];
  name: string;
}

/** Injectable delete client, so the invalidation contract is unit-testable. */
export interface ExecuteDeletesDependencies {
  deleteDefinition: typeof deleteDefinition;
  deleteMetric: typeof deleteMetric;
}

export interface DeleteOutcome {
  definitionId?: string;
  metricId?: string;
  status: 'deleted' | 'already_absent' | 'failed';
  error?: string;
}

export async function executeDeletes(
  session: TableauSession,
  entries: DeletePlanEntry[],
  deps: ExecuteDeletesDependencies = { deleteDefinition, deleteMetric },
): Promise<{ definitionsDeleted: number; metricsDeleted: number; failures: string[]; outcomes: DeleteOutcome[] }> {
  const failures: string[] = [];
  const outcomes: DeleteOutcome[] = [];
  let definitionsDeleted = 0;
  const deletingDefinitionIds = new Set(entries.filter((entry) => entry.definitionId).map((entry) => entry.definitionId!));

  for (const entry of entries.filter((candidate) => candidate.definitionId)) {
    try {
      await deps.deleteDefinition(session, entry.definitionId!);
      definitionsDeleted++;
      outcomes.push({ definitionId: entry.definitionId!, status: 'deleted' });
    } catch (error) {
      if (error instanceof TableauError && error.status === 404) {
        definitionsDeleted++;
        outcomes.push({ definitionId: entry.definitionId!, status: 'already_absent' });
        continue;
      }
      outcomes.push({ definitionId: entry.definitionId!, status: 'failed', error: diagnosticMessage(boundedProviderDiagnostic(error)) });
      failures.push(`definition ${entry.definitionId} (${entry.name}): ${diagnosticMessage(boundedProviderDiagnostic(error))}`);
    }
  }
  const metricEntries = entries
    .flatMap((entry) => entry.metricIds.map((metricId) => ({ definitionId: entry.definitionId, metricId })))
    .filter((entry) => !deletingDefinitionIds.has(entry.definitionId ?? ''));
  const metricResults = await mapWithConcurrency(metricEntries, PROVIDER_CONCURRENCY, async (entry) => {
    try {
      await deps.deleteMetric(session, entry.metricId);
      outcomes.push({ metricId: entry.metricId, status: 'deleted' });
      return true;
    } catch (error) {
      if (error instanceof TableauError && error.status === 404) {
        outcomes.push({ metricId: entry.metricId, status: 'already_absent' });
        return true;
      }
      outcomes.push({ metricId: entry.metricId, status: 'failed', error: diagnosticMessage(boundedProviderDiagnostic(error)) });
      failures.push(`metric ${entry.metricId}: ${diagnosticMessage(boundedProviderDiagnostic(error))}`);
      return false;
    }
  });
  const metricsDeleted = metricResults.filter(Boolean).length;

  // An exact metric is part of its definition's cached inventory, so a
  // metric-only delete must invalidate the inventory too - otherwise the next
  // getExistingMetrics call (within the cache TTL) returns the stale list still
  // containing the deleted metric, and the UI looks like the delete did nothing.
  if (definitionsDeleted > 0 || metricsDeleted > 0) invalidatePulseDefinitionInventory(session);

  return {
    definitionsDeleted,
    metricsDeleted,
    failures,
    outcomes,
  };
}

export function clearPulseManageCaches(): void {
  definitionCache.clear();
  nameCache.clear();
}

function canonicalIds(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))].sort();
}

function canonicalFollowOperations(operations: FollowTargetOperation[]): FollowTargetOperation[] {
  const seen = new Set<string>();
  return operations.filter((operation) => {
    if (!operation.metricId || !operation.target.id) return false;
    const key = followOperationKey(operation);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function followOperationKey(operation: FollowTargetOperation): string {
  return followOperationKeyParts(operation.metricId, operation.target.kind, operation.target.id);
}

function followOperationKeyParts(metricId: string, targetKind: 'GROUP' | 'USER', targetId: string): string {
  return `${metricId}\u0000${targetKind}\u0000${targetId}`;
}

function operationResult(
  operation: FollowTargetOperation,
  status: FollowTargetOperationStatus,
  ok: boolean,
  error?: string,
): FollowTargetOperationResult {
  return {
    metricId: operation.metricId,
    targetId: operation.target.id,
    targetKind: operation.target.kind,
    status,
    ok,
    ...(error ? { error } : {}),
  };
}

function deduplicateFollowers<T extends { id: string; type: string }>(followers: T[]): T[] {
  const seen = new Set<string>();
  return followers.filter((follower) => {
    const key = `${follower.type}\u0000${follower.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

function touch<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function recordCollection(value: unknown, label: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (isRecord(value)) return [value];
  if (Array.isArray(value) && value.every(isRecord)) return value;
  throw new Error(`Unsupported ${label} response shape.`);
}

function pulseMetricId(metric: PulseExactMetric): string {
  return String(metric.id ?? metric.metadata?.id ?? '').trim();
}

function compareInventoryFailures(left: InventoryFailure, right: InventoryFailure): number {
  return left.definitionId.localeCompare(right.definitionId)
    || String(left.metricId ?? '').localeCompare(String(right.metricId ?? ''))
    || left.stage.localeCompare(right.stage);
}
