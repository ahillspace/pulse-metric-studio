import { randomUUID } from 'node:crypto';
import { getSessionContext, type TableauSession } from '@pulse-metric-studio/core';
import type { PulseDraftContext, PulseInventoryResponse, PulseInventoryPatch } from '@pulse-metric-studio/shared';
import type { PulseDefinition, PulseExactMetric } from '../pulse/pulse-client.js';
import { requirePulseOwner } from './context.js';
import { PulseApplicationError } from './errors.js';
import { getExistingMetrics } from './inventory.js';
import { defaultDependencies } from './registry-dependencies.js';

const MAX_SNAPSHOTS_PER_SESSION = 32;
export interface InventorySourceFact { definition: PulseDefinition; metric: PulseExactMetric; acquiredAt: number }
interface InventorySnapshot {
  owner: PulseDraftContext;
  sessionContext: ReturnType<typeof getSessionContext>;
  userId: string;
  inventory: PulseInventoryResponse;
  facts: Map<string, InventorySourceFact>;
}
interface Changes { upserts: PulseInventoryPatch['upserts']; removedMetricIds: string[]; removedDefinitionIds: string[] }
interface OwnerState { lifetimeId: string; readGeneration: number; revision: number; sequence: number; latest?: InventorySnapshot; journal: Array<{ sequence: number; changes: Changes }>; pendingReads: Map<string, number>; deletedMetrics: Map<string, number>; deletedDefinitions: Map<string, number>; activeMutations: Map<string, { sequence: number; count: number }> }
const snapshots = new WeakMap<TableauSession, Map<string, InventorySnapshot>>();
const owners = new WeakMap<TableauSession, { context: ReturnType<typeof getSessionContext>; coordinates: string; states: Map<string, OwnerState> }>();
function ownerKey(owner: PulseDraftContext): string { return JSON.stringify([owner.connectionId, owner.serverUrl, owner.siteId, owner.datasourceLuid]); }
function stateFor(session: TableauSession, owner: PulseDraftContext): OwnerState {
  const context = getSessionContext(session), coordinates = JSON.stringify([session.userId, session.serverUrl, session.siteId]);
  let retained = owners.get(session);
  if (!retained || retained.context !== context || retained.coordinates !== coordinates) {
    retained = { context, coordinates, states: new Map() }; owners.set(session, retained);
  }
  const key = ownerKey(owner); let state = retained.states.get(key);
  if (!state) { state = { lifetimeId: randomUUID(), readGeneration: 0, revision: 0, sequence: 0, journal: [], pendingReads: new Map(), deletedMetrics: new Map(), deletedDefinitions: new Map(), activeMutations: new Map() }; retained.states.set(key, state); }
  return state;
}
function retain(session: TableauSession, snapshot: InventorySnapshot): PulseInventoryResponse {
  const retained = snapshots.get(session) ?? new Map();
  retained.set(snapshot.inventory.snapshotId, snapshot);
  snapshots.set(session, retained);
  const states = owners.get(session)?.states;
  const pinned = new Set([...(states?.values() ?? [])].flatMap(state => [...state.activeMutations.keys()]));
  for (const id of retained.keys()) {
    if (retained.size <= MAX_SNAPSHOTS_PER_SESSION) break;
    if (!pinned.has(id)) retained.delete(id);
  }
  // A latest snapshot is retained only while the bounded snapshot set or an in-flight operation needs it.
  if (states) for (const [key, state] of states) {
    if (!state.pendingReads.size && !state.activeMutations.size && (!state.latest || !retained.has(state.latest.inventory.snapshotId))) states.delete(key);
  }
  return structuredClone(snapshot.inventory);
}
function apply(inventory: PulseInventoryResponse, changes: Changes): void {
  inventory.definitions = inventory.definitions.filter(definition => !changes.removedDefinitionIds.includes(definition.definitionId));
  for (const definition of inventory.definitions) {
    definition.metrics = definition.metrics.filter(metric => !changes.removedMetricIds.includes(metric.metricId));
    for (const upsert of changes.upserts.filter(entry => entry.definitionId === definition.definitionId)) {
      const index = definition.metrics.findIndex(metric => metric.metricId === upsert.metric.metricId);
      if (index < 0) definition.metrics.push(structuredClone(upsert.metric));
      else {
        const previous = definition.metrics[index]!;
        definition.metrics[index] = { ...structuredClone(upsert.metric), isDefault: upsert.metric.isDefault ?? previous.isDefault };
      }
    }
  }
}
export async function loadPulseInventory(session: TableauSession, datasourceLuid: string, options: { refresh?: boolean } = {}): Promise<PulseInventoryResponse> {
  const sessionContext = getSessionContext(session);
  const owner: PulseDraftContext = { connectionId: sessionContext?.connectionId ?? '', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid };
  requirePulseOwner(owner, session);
  const userId = session.userId, state = stateFor(session, owner), startedSequence = state.sequence;
  const generation = ++state.readGeneration;
  const readId = randomUUID(); state.pendingReads.set(readId, startedSequence);
  try {
  const facts = new Map<string, InventorySourceFact>();
  const result = await getExistingMetrics(session, datasourceLuid, defaultDependencies, { ...options, capture: (definition, metric, acquiredAt) => {
    const id = String(metric.id ?? metric.metadata?.id ?? '');
    facts.set(id, structuredClone({ definition, metric, acquiredAt }));
  } });
  requirePulseOwner(owner, session);
  if (getSessionContext(session) !== sessionContext || session.userId !== userId) throw refreshRequired();
  if (generation !== state.readGeneration && state.latest) return structuredClone(state.latest.inventory);
  const inventory: PulseInventoryResponse = { ...result, lifetimeId: state.lifetimeId, snapshotId: randomUUID(), viewId: randomUUID(), revision: ++state.revision };
  for (const entry of state.journal) if (entry.sequence > startedSequence) apply(inventory, entry.changes);
  // Merge original acquisition facts for local rows that a pending refresh could not yet list.
  for (const [id, fact] of state.latest?.facts ?? []) if (!facts.has(id) && inventory.definitions.some(definition => definition.metrics.some(metric => metric.metricId === id))) facts.set(id, structuredClone(fact));
  const snapshot = { owner: structuredClone(owner), sessionContext, userId, inventory, facts };
  state.latest = snapshot;
  return retain(session, snapshot);
  } finally {
    state.pendingReads.delete(readId); pruneJournal(state);
    if (!state.pendingReads.size && !state.activeMutations.size && (!state.latest || !snapshots.get(session)?.has(state.latest.inventory.snapshotId))) { const states = owners.get(session)?.states; if (states?.get(ownerKey(owner)) === state) states.delete(ownerKey(owner)); }
  }
}
function pruneJournal(state: OwnerState): void {
  const earliest = Math.min(...state.pendingReads.values());
  state.journal = state.journal.filter(entry => entry.sequence > earliest);
  const earliestMutation = Math.min(...[...state.activeMutations.values()].map(mutation => mutation.sequence));
  for (const [id, sequence] of state.deletedMetrics) if (sequence <= earliestMutation) state.deletedMetrics.delete(id);
  for (const [id, sequence] of state.deletedDefinitions) if (sequence <= earliestMutation) state.deletedDefinitions.delete(id);
}
export function resolveInventoryMutationBase(session: TableauSession, owner: PulseDraftContext, requestedSnapshotId: string): string | undefined {
  requirePulseOwner(owner, session);
  if (snapshots.get(session)?.has(requestedSnapshotId)) return ownedSnapshot(session, owner, requestedSnapshotId).inventory.snapshotId;
  const latest = stateFor(session, owner).latest;
  if (!latest) throw refreshRequired();
  return latest.inventory.snapshotId;
}
export function beginInventoryMutation(session: TableauSession, owner: PulseDraftContext, snapshotId: string): number {
  ownedSnapshot(session, owner, snapshotId);
  const state = stateFor(session, owner), active = state.activeMutations.get(snapshotId);
  if (active) active.count++;
  else state.activeMutations.set(snapshotId, { sequence: state.sequence, count: 1 });
  return state.sequence;
}
export function endInventoryMutation(session: TableauSession, owner: PulseDraftContext, snapshotId: string): void {
  const state = owners.get(session)?.states.get(ownerKey(owner));
  if (!state) return;
  const active = state.activeMutations.get(snapshotId);
  if (active && --active.count <= 0) state.activeMutations.delete(snapshotId);
  pruneJournal(state);
  if (state.latest) retain(session, state.latest);
}
function ownedSnapshot(session: TableauSession, owner: PulseDraftContext, snapshotId: string): InventorySnapshot {
  requirePulseOwner(owner, session);
  const snapshot = snapshots.get(session)?.get(snapshotId);
  if (!snapshot || snapshot.sessionContext !== getSessionContext(session) || snapshot.userId !== session.userId || snapshot.owner.connectionId !== owner.connectionId || snapshot.owner.serverUrl !== owner.serverUrl || snapshot.owner.siteId !== owner.siteId || snapshot.owner.datasourceLuid !== owner.datasourceLuid) throw refreshRequired();
  return snapshot;
}
export function getPulseInventorySnapshot(session: TableauSession, owner: PulseDraftContext, snapshotId: string): PulseInventoryResponse {
  return structuredClone(ownedSnapshot(session, owner, snapshotId).inventory);
}
export function getInventorySourceFacts(session: TableauSession, snapshotId: string, sourceIds: string[]): { owner: PulseDraftContext; viewId: string; facts: Map<string, InventorySourceFact> } {
  const snapshot = snapshots.get(session)?.get(snapshotId);
  if (!snapshot) throw refreshRequired();
  ownedSnapshot(session, snapshot.owner, snapshotId);
  return { owner: structuredClone(snapshot.owner), viewId: snapshot.inventory.viewId ?? snapshot.inventory.snapshotId, facts: new Map(sourceIds.flatMap(id => { const fact = snapshot.facts.get(id); return fact ? [[id, structuredClone(fact)] as const] : []; })) };
}
/** Local confirmed changes never mutate a reviewed snapshot and always rebase on the latest owned inventory. */
export function patchPulseInventory(session: TableauSession, owner: PulseDraftContext, baseSnapshotId: string, changes: Changes, admittedSequence?: number): PulseInventoryPatch | undefined {
  const base = ownedSnapshot(session, owner, baseSnapshotId), state = stateFor(session, owner), latest = state.latest ?? base;
  changes = structuredClone(changes);
  if (admittedSequence !== undefined) changes.upserts = changes.upserts.filter(upsert =>
    (state.deletedMetrics.get(upsert.metric.metricId) ?? -1) <= admittedSequence && (state.deletedDefinitions.get(upsert.definitionId) ?? -1) <= admittedSequence);
  const inventory = structuredClone(latest.inventory), facts = structuredClone(latest.facts);
  apply(inventory, changes);
  for (const id of changes.removedMetricIds) facts.delete(id);
  for (const [id, fact] of facts) if (changes.removedDefinitionIds.includes(String(fact.definition.metadata?.id ?? ''))) facts.delete(id);
  for (const upsert of changes.upserts) {
    const source = [...base.facts.values()].find(fact => fact.definition.metadata?.id === upsert.definitionId);
    if (source && inventory.definitions.some(definition => definition.definitionId === upsert.definitionId)) facts.set(upsert.metric.metricId, { definition: structuredClone(source.definition), metric: { id: upsert.metric.metricId, definition_id: upsert.definitionId, specification: structuredClone(upsert.metric.specification), ...(upsert.metric.isDefault === null ? {} : { is_default: upsert.metric.isDefault }) }, acquiredAt: source.acquiredAt });
  }
  inventory.snapshotId = randomUUID(); inventory.revision = ++state.revision;
  inventory.viewId ??= randomUUID();
  const sequence = ++state.sequence;
  for (const id of changes.removedMetricIds) state.deletedMetrics.set(id, sequence);
  for (const id of changes.removedDefinitionIds) state.deletedDefinitions.set(id, sequence);
  state.journal.push({ sequence, changes: structuredClone(changes) });
  pruneJournal(state);
  // This journal lives only for the active owner, with snapshots bounded independently.
  const snapshot = { ...latest, inventory, facts }; state.latest = snapshot; retain(session, snapshot);
  return { version: 1, lifetimeId: state.lifetimeId, inventory: structuredClone(inventory), baseSnapshotId: latest.inventory.snapshotId, snapshotId: inventory.snapshotId, viewId: inventory.viewId, revision: inventory.revision, ...structuredClone(changes) };
}
export function getInventoryView(session: TableauSession, snapshotId: string): { viewId: string; metricIds: string[] } {
  const retained = snapshots.get(session)?.get(snapshotId); if (!retained) throw refreshRequired();
  const snapshot = ownedSnapshot(session, retained.owner, snapshotId);
  return { viewId: snapshot.inventory.viewId ?? snapshot.inventory.snapshotId, metricIds: snapshot.inventory.definitions.flatMap(definition => definition.metrics.map(metric => metric.metricId)) };
}
function refreshRequired(): PulseApplicationError {
  return new PulseApplicationError('delete_snapshot_unavailable', 'The displayed inventory is no longer available. Refresh metrics and review the selection again.', 409);
}
