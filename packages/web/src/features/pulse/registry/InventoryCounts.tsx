import type { PulseInventoryResponse } from "@pulse-metric-studio/shared";
import { useRegistry } from "./controller";

export function inventoryCounts(inventory: PulseInventoryResponse) {
  return {
    definitions: inventory.definitions.length,
    metrics: inventory.definitions.reduce((count, definition) => count + definition.metrics.length, 0),
    partial: inventory.truncated || inventory.failures.length > 0 || inventory.definitions.some((definition) => definition.inventoryStatus !== "complete"),
  };
}

export function InventoryCounts() {
  const { context, inventory, loading, error } = useRegistry();
  if (!context) return null;
  const counts = inventory && inventoryCounts(inventory);
  return <span className="pulse-inventory-counts" role="status" aria-live="polite" title={error ?? (counts?.partial ? "Some inventory could not be loaded." : undefined)}>
    {counts ? `${counts.definitions} definitions · ${counts.metrics} metrics${counts.partial ? " (partial)" : ""}${loading ? " · updating" : error ? " · refresh failed" : ""}` : error ? "Counts unavailable" : "Loading counts..."}
  </span>;
}
