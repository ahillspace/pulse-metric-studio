import type { PulseInventoryResponse } from "@pulse-metric-studio/shared";

type InventoryFailure = PulseInventoryResponse["failures"][number];

const STAGE_LABELS: Record<InventoryFailure["stage"], string> = {
  parse_definition: "Reading definitions",
  list_metrics: "Listing metrics",
  get_metric: "Reading metrics",
  parse_metric: "Reading metrics",
};

function failureCause(failure: InventoryFailure): string {
  const { status, kind } = failure.diagnostic;
  if (status === 429) return "Tableau is throttling requests (HTTP 429)";
  if (status) return `HTTP ${status}`;
  if (kind === "network") return "network error";
  return "unexpected response";
}

/** Names each failed provider request, grouped by what failed and why. */
export function InventoryFailures({ inventory }: { inventory: PulseInventoryResponse }) {
  const { failures } = inventory;
  if (!failures.length) return null;
  const names = new Map(inventory.definitions.map((definition) => [definition.definitionId, definition.name]));
  const groups = new Map<string, InventoryFailure[]>();
  for (const failure of failures) {
    const key = `${STAGE_LABELS[failure.stage]} failed: ${failureCause(failure)}`;
    groups.set(key, [...(groups.get(key) ?? []), failure]);
  }
  return (
    <div className="warning-banner" role="status">
      Inventory is partial. {failures.length} provider{" "}
      {failures.length === 1 ? "request" : "requests"} failed. Reload to retry.
      <ul className="inventory-failures">
        {[...groups].map(([summary, entries]) => (
          <li key={summary}>
            <details>
              <summary>
                {summary} ({entries.length})
              </summary>
              <ul>
                {entries.map((failure, index) => (
                  <li key={`${failure.definitionId}-${failure.metricId ?? ""}-${index}`}>
                    {names.get(failure.definitionId) ?? failure.definitionId}: {failure.diagnostic.message}
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
