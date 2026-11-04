import { randomUUID } from 'node:crypto';
import { getSessionContext, logTableauEvent, withTableauOperation, getFieldCatalogAcquiredAt, fieldCatalogCacheTtlMs, type TableauSession } from '@pulse-metric-studio/core';

import type { DatasourceCatalog } from '@pulse-metric-studio/shared';
import type { PulseDefinition, PulseExactMetric } from './pulse-client.js';
import { metricDefinitionId, metricSpecification } from './metric-facts.js';
import { mapWithConcurrency } from '../application/registry-collections.js';
import { PulseApplicationError } from '../application/errors.js';
import { getInventorySourceFacts } from '../application/inventory-snapshots.js';

const TTL = 60_000;
export interface SourceContextInput { snapshotId?: string; sourceContextId?: string }
export interface SourceDependencies {
  getMetric(session: TableauSession, id: string): Promise<PulseExactMetric>;
  getDefinition(session: TableauSession, id: string): Promise<PulseDefinition>;
  getCatalog(session: TableauSession, id: string): Promise<DatasourceCatalog>;
}
export interface ResolvedSource {
  metricId: string; definitionId: string; datasourceLuid: string;
  allowedDimensions: Set<string>; specification: Record<string, unknown>;
  definition: PulseDefinition; metric: PulseExactMetric; acquiredAt: number; hasAllowedDimensions: boolean;
}
export interface SourceContext {
  id: string; scopeKey: string; sources: ResolvedSource[]; failures: Array<{ metricId: string; error: unknown }>; expiresAt: number;
  catalog?: DatasourceCatalog; catalogExpiresAt?: number; catalogRequest?: Promise<DatasourceCatalog>;
}
interface SourceEntry {
  id: string; ids: string[]; scopeKey: string; context?: SourceContext; pending?: Promise<SourceContext>;
}
interface Store { owner: ReturnType<typeof getSessionContext>; coordinates: string; entries: Map<string, SourceEntry> }
const stores = new WeakMap<TableauSession, Map<object, Store>>();
export const defaultSourceNamespace = {};
function currentCoordinates(session: TableauSession): string { return JSON.stringify([session.serverUrl, session.siteId, session.userId]); }
export async function resolveSourceContext(session: TableauSession, sourceIds: string[], input: SourceContextInput, dependencies: SourceDependencies, namespace: object): Promise<SourceContext> {
  const owner = getSessionContext(session), coordinates = currentCoordinates(session);
  const sessionStores = stores.get(session) ?? new Map<object, Store>(); stores.set(session, sessionStores);
  let store = sessionStores.get(namespace);
  if (!store || store.owner !== owner || store.coordinates !== coordinates) { store = { owner, coordinates, entries: new Map() }; sessionStores.set(namespace, store); }
  const ids = [...new Set(sourceIds)].sort();
  let seeded: ReturnType<typeof getInventorySourceFacts> | undefined;
  if (input.snapshotId) try { seeded = getInventorySourceFacts(session, input.snapshotId, ids); }
  catch (error) { if (!(error instanceof PulseApplicationError) || error.code !== 'delete_snapshot_unavailable') throw error; }
  // Local mutation snapshots share a view, so refreshed source facts survive create/delete patches.
  // An explicit inventory refresh establishes a new view and cannot inherit this context.
  const scopeKey = seeded?.viewId ?? input.snapshotId ?? '';
  const key = JSON.stringify([ids, scopeKey]);
  const verify = () => { if (owner !== getSessionContext(session) || coordinates !== currentCoordinates(session)) throw new Error('The Tableau session changed while source context was loading.'); };
  if (input.sourceContextId) {
    // Handle identity is available before acquisition settles; unrelated pending entries never block lookup.
    const matched = [...store.entries.values()].find(entry => entry.id === input.sourceContextId);
    if (!matched) throw new Error('Source context is unavailable for this session. Refresh metrics and retry.');
    if (JSON.stringify(matched.ids) !== JSON.stringify(ids)) throw new Error('Source context does not match selected metrics.');
  }
  const retained = store.entries.get(key);
  if (retained?.pending) { const context = await retained.pending; verify(); logTableauEvent({ event: 'tableau.dimension_context', cacheHit: true }); return context; }
  const previous = retained?.context;
  const freshSources = new Map(previous?.sources.filter(source => source.acquiredAt + TTL > Date.now()).map(source => [source.metricId, source]));
  if (previous && ids.every(id => freshSources.has(id))) { verify(); logTableauEvent({ event: 'tableau.dimension_context', cacheHit: true }); return previous; }
  // Failed acquisitions are never reusable facts. Keep good facts at their original age and retry only missing sources.
  const entry: SourceEntry = retained ?? { id: randomUUID(), ids, scopeKey };
  logTableauEvent({ event: 'tableau.dimension_context', cacheHit: false });
  const promise = (async (): Promise<SourceContext> => {
    const definitionPromises = new Map<string, Promise<PulseDefinition>>();
    const outcomes = await mapWithConcurrency(ids, 5, async metricId => {
      try {
      const cached = freshSources.get(metricId);
      if (cached) return cached;
      const fact = seeded?.facts.get(metricId), fresh = fact && fact.acquiredAt + TTL > Date.now();
      const metric = fresh ? fact.metric : await withTableauOperation('dimensions_source', () => dependencies.getMetric(session, metricId));
      const returnedId = String(metric.id ?? metric.metadata?.id ?? '');
      if (returnedId && returnedId !== metricId) throw new Error(`Exact metric endpoint returned ${returnedId} for ${metricId}.`);
      const siteId = metric.site_id ?? metric.site?.id;
      if (siteId && siteId !== session.siteId) throw new Error('Source metric belongs to a different site.');
      const definitionId = metricDefinitionId(metric), specification = metricSpecification(metric);
      if (!definitionId || !specification) throw new Error('Source metric requires a definition identifier and specification.');
      if (specification.filters !== undefined && !Array.isArray(specification.filters)) throw new Error('Source metric specification filters must be an array.');
      let definitionPromise = definitionPromises.get(definitionId);
      if (!definitionPromise) { definitionPromise = fresh ? Promise.resolve(fact.definition) : withTableauOperation('dimensions_source', () => dependencies.getDefinition(session, definitionId)); definitionPromises.set(definitionId, definitionPromise); }
      const definition = await definitionPromise;
      const returnedDefinitionId = String(definition.metadata?.id ?? '');
      if (returnedDefinitionId && returnedDefinitionId !== definitionId) throw new Error('Source definition identity does not match.');
      const datasourceLuid = String(definition.specification?.datasource?.id ?? '');
      if (!datasourceLuid || (seeded && datasourceLuid !== seeded.owner.datasourceLuid)) throw new Error('Source definition does not belong to the captured datasource.');
      const allowed = definition.extension_options?.allowed_dimensions;
      return { metricId, definitionId, datasourceLuid, definition: structuredClone(definition), metric: structuredClone(metric), allowedDimensions: new Set(Array.isArray(allowed) ? allowed.filter((value): value is string => typeof value === 'string') : []), hasAllowedDimensions: Array.isArray(allowed), specification: structuredClone(specification), acquiredAt: fresh ? fact.acquiredAt : Date.now() };
      } catch (error) { return { metricId, error }; }
    });
    const sources = outcomes.filter((outcome): outcome is ResolvedSource => !('error' in outcome));
    const failures = outcomes.filter((outcome): outcome is { metricId: string; error: unknown } => 'error' in outcome);
    verify();
    if (new Set(sources.map(source => source.datasourceLuid)).size > 1) throw new Error('Selected source metrics must use the same datasource.');
    return { id: entry.id, scopeKey, sources, failures, expiresAt: Math.min(Date.now() + TTL, ...sources.map(source => source.acquiredAt + TTL)), ...(previous?.catalog ? { catalog: previous.catalog, catalogExpiresAt: previous.catalogExpiresAt } : {}) };
  })();
  entry.pending = promise.then(context => {
    // Retain successful facts only, while returning this attempt's failures to its callers.
    entry.context = context.failures.length ? { ...context, failures: [] } : context;
    return context;
  }).finally(() => { entry.pending = undefined; });
  store.entries.delete(key); store.entries.set(key, entry);
  while (store.entries.size > 8) store.entries.delete(store.entries.keys().next().value!);
  try { return await entry.pending; } catch (error) { if (store.entries.get(key) === entry) store.entries.delete(key); throw error; }
}
export async function resolveSourceCatalog(session: TableauSession, context: SourceContext, dependencies: SourceDependencies): Promise<DatasourceCatalog> {
  if (context.catalog && Math.min(context.expiresAt, context.catalogExpiresAt ?? 0) > Date.now()) return structuredClone(context.catalog);
  if (!context.catalogRequest) {
    const owner = getSessionContext(session), coordinates = currentCoordinates(session);
    context.catalogRequest = (async () => {
      const missing = new Map<string, Promise<PulseDefinition>>();
      for (const source of context.sources.filter(source => !source.hasAllowedDimensions)) {
        let pending = missing.get(source.definitionId);
        if (!pending) { pending = withTableauOperation('dimensions_source', () => dependencies.getDefinition(session, source.definitionId)); missing.set(source.definitionId, pending); }
        const definition = await pending;
        const allowed = definition.extension_options?.allowed_dimensions;
        if ((definition.metadata?.id && definition.metadata.id !== source.definitionId) || definition.specification?.datasource?.id !== source.datasourceLuid || !Array.isArray(allowed)) throw new Error('Source definition has no matching allowed_dimensions catalog.');
        source.allowedDimensions = new Set(allowed.filter((value): value is string => typeof value === 'string'));
        source.hasAllowedDimensions = true;
      }
      return withTableauOperation('dimensions_catalog', () => dependencies.getCatalog(session, context.sources[0]!.datasourceLuid));
    })().then(catalog => {
      if (owner !== getSessionContext(session) || coordinates !== currentCoordinates(session)) throw new Error('The Tableau session changed while source catalog was loading.');
      const provenance = getFieldCatalogAcquiredAt(session, context.sources[0]!.datasourceLuid);
      context.catalog = structuredClone(catalog); context.catalogExpiresAt = (provenance ?? Date.now()) + fieldCatalogCacheTtlMs(catalog);
      return catalog;
    }).finally(() => { context.catalogRequest = undefined; });
  }
  return structuredClone(await context.catalogRequest);
}
