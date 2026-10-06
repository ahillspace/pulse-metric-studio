import type {
  FollowTargetOperation,
  FollowTargetOperationResult,
} from "./registry/view-types";
import type { RegistryActionItem } from "./registry-actions";

export interface FollowTargetChoice {
  id: string;
  kind: "GROUP" | "USER";
  label: string;
  /**
   * Text the local filter matches against, when it differs from `label`. The
   * current user carries their real display name here so a search on that name
   * matches even though the visible label appends a " (you)" decoration.
   */
  searchText?: string;
}

/**
 * Fallback follow-target row for the current user, used ONLY when they are
 * absent from the fetched site inventory. They render like every other user -
 * their real display name - with a " (you)" suffix, and stay searchable by the
 * real name via `searchText`. When the name is unavailable we fall back to a
 * minimal but still selectable "You" row.
 */
export function currentUserFollowTarget(
  currentUserId: string,
  currentUserName?: string,
): FollowTargetChoice | null {
  if (!currentUserId) return null;
  const name = (currentUserName ?? "").trim();
  return name
    ? {
        id: currentUserId,
        kind: "USER",
        label: `${name} (you)`,
        searchText: name,
      }
    : { id: currentUserId, kind: "USER", label: "You" };
}

/**
 * Split the fetched inventory into the current-user row and everyone else. The
 * current user is kept IN the inventory (never filtered out), so their real
 * username shows and stays searchable; we only decorate the visible label with
 * a " (you)" suffix and keep the real name in `searchText`. When the current
 * user is genuinely absent from the inventory we synthesize a minimal row from
 * `currentUserName` (else "You") so the option is still available.
 */
export function resolveCurrentUserFollowTarget(
  targets: FollowTargetChoice[],
  currentUserId: string,
  currentUserName?: string,
): { currentUser: FollowTargetChoice | null; others: FollowTargetChoice[] } {
  const others = targets.filter(
    (target) => !(target.kind === "USER" && target.id === currentUserId),
  );
  if (!currentUserId) return { currentUser: null, others };
  const inventoryRow = targets.find(
    (target) => target.kind === "USER" && target.id === currentUserId,
  );
  const currentUser = inventoryRow
    ? {
        ...inventoryRow,
        label: `${inventoryRow.label} (you)`,
        searchText: inventoryRow.searchText ?? inventoryRow.label,
      }
    : currentUserFollowTarget(currentUserId, currentUserName);
  return { currentUser, others };
}

/** Case-insensitive substring match over a target's label and search text. */
export function followTargetMatchesQuery(
  target: FollowTargetChoice,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const haystack = `${target.label} ${target.searchText ?? ""}`.toLowerCase();
  return haystack.includes(needle);
}

export function buildFollowTargetOperations(
  metrics: Array<{ id: string }>,
  targets: Array<{ id: string; kind: "GROUP" | "USER" }>,
): FollowTargetOperation[] {
  const seen = new Set<string>();
  return metrics.flatMap((metric) =>
    targets.flatMap((target) => {
      const operation = {
        metricId: metric.id,
        target: { id: target.id, kind: target.kind },
      };
      const key = followTargetOperationKey(operation);
      if (seen.has(key)) return [];
      seen.add(key);
      return [operation];
    }),
  );
}

export function reconcileFollowTargetResults(
  kind: "follow" | "unfollow",
  operations: FollowTargetOperation[],
  results: FollowTargetOperationResult[],
  labels: {
    metricLabels: ReadonlyMap<string, string>;
    targetLabels: ReadonlyMap<string, string>;
  },
  missingDetail = "The server returned no result for this metric and target.",
): { items: RegistryActionItem[]; retryOperations: FollowTargetOperation[] } {
  const returned = new Map(
    results.map((result) => [followTargetResultKey(result), result]),
  );
  const retryOperations: FollowTargetOperation[] = [];
  const items = operations.map((operation) => {
    const result = returned.get(followTargetOperationKey(operation));
    const status = registryStatus(kind, result);
    if (status === "failed" || status === "not_attempted")
      retryOperations.push(operation);
    return {
      key: `${kind}:${operation.metricId}:${operation.target.kind}:${operation.target.id}`,
      metricId: operation.metricId,
      metricLabel:
        labels.metricLabels.get(operation.metricId) ?? operation.metricId,
      targetLabel:
        labels.targetLabels.get(
          targetLabelKey(operation.target.kind, operation.target.id),
        ) ?? operation.target.id,
      status,
      ...(!result
        ? { detail: missingDetail }
        : result.error
          ? { detail: result.error }
          : {}),
    } satisfies RegistryActionItem;
  });
  return { items, retryOperations };
}

/**
 * Select the active option from the search combobox. Only Enter selects: the
 * search field is a text input, so Space MUST insert a space and never toggle a
 * target (the old `' '` branch was the "spacebar selects a user while I type"
 * bug). Pointer clicks and keyboard-nav Enter are the only ways to toggle.
 */
export function handleFollowTargetSelectionKey<T>(
  event: { key: string; preventDefault: () => void },
  activeTarget: T | undefined,
  selectTarget: (target: T) => void,
): boolean {
  if (!activeTarget || event.key !== "Enter") return false;
  event.preventDefault();
  selectTarget(activeTarget);
  return true;
}

export function followTargetOperationKey(
  operation: FollowTargetOperation,
): string {
  return followTargetKeyParts(
    operation.metricId,
    operation.target.kind,
    operation.target.id,
  );
}

export function targetLabelKey(kind: "GROUP" | "USER", id: string): string {
  return `${kind}\u0000${id}`;
}

function followTargetResultKey(result: FollowTargetOperationResult): string {
  return followTargetKeyParts(
    result.metricId,
    result.targetKind,
    result.targetId,
  );
}

function followTargetKeyParts(
  metricId: string,
  targetKind: "GROUP" | "USER",
  targetId: string,
): string {
  return `${metricId}\u0000${targetKind}\u0000${targetId}`;
}

function registryStatus(
  kind: "follow" | "unfollow",
  result: FollowTargetOperationResult | undefined,
): RegistryActionItem["status"] {
  if (result?.status === "not_attempted" || result?.status === "unknown")
    return result.status;
  if (!result || !result.ok || result.status === "failed") return "failed";
  if (kind === "follow") {
    if (result.status === "followed") return "created";
    if (result.status === "already_followed") return "existing";
    return "failed";
  }
  if (result.status === "unfollowed") return "removed";
  if (result.status === "not_followed") return "not_followed";
  return "failed";
}
