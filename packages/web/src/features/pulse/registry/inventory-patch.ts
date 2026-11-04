import type { PulseInventoryResponse, PulseInventoryPatch } from "@pulse-metric-studio/shared";

/** Merge only backend-normalized rows; the snapshot remains the deletion authority. */
export function applyInventoryPatch(inventory: PulseInventoryResponse, patch: PulseInventoryPatch): PulseInventoryResponse {
  if (patch.lifetimeId !== inventory.lifetimeId) return inventory;
  if (patch.revision <= (inventory.revision ?? -1)) return inventory;
  if (patch.inventory) {
    const snapshot = patch.inventory;
    return snapshot.lifetimeId === patch.lifetimeId && snapshot.revision === patch.revision &&
      snapshot.snapshotId === patch.snapshotId && snapshot.viewId === patch.viewId ? snapshot : inventory;
  }
  const removedDefinitions = new Set(patch.removedDefinitionIds);
  const removedMetrics = new Set(patch.removedMetricIds);
  const definitions = inventory.definitions.filter(definition => !removedDefinitions.has(definition.definitionId))
    .map(definition => ({ ...definition, metrics: definition.metrics.filter(metric => !removedMetrics.has(metric.metricId)) }));
  for (const { definitionId, metric } of patch.upserts) {
    const destination = definitions.find(definition => definition.definitionId === definitionId);
    // A patch may only enrich definitions already established by this inventory.
    if (!destination) continue;
    for (const definition of definitions) definition.metrics = definition.metrics.filter(row => row.metricId !== metric.metricId);
    destination.metrics.push(metric);
  }
  const newer = (inventory.revision ?? 0) <= patch.revision;
  return { ...inventory, definitions, ...(newer ? { snapshotId: patch.snapshotId, viewId: patch.viewId, revision: patch.revision } : {}) };
}
