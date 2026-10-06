import type { PulseVariantResult } from "@pulse-metric-studio/shared";

export type RegistryActionKind = "fork" | "follow" | "unfollow" | "delete";
export type RegistryActionStatus =
  | "created"
  | "existing"
  | "removed"
  | "not_followed"
  | "pending"
  | "failed"
  | "unknown"
  | "not_attempted";

export interface RegistryActionItem {
  key: string;
  metricId: string;
  metricLabel: string;
  targetLabel?: string;
  status: RegistryActionStatus;
  resultMetricId?: string;
  creationStatus?: PulseVariantResult["creationStatus"];
  reconciliationStatus?: PulseVariantResult["reconciliationStatus"];
  requestedSpecification?: unknown;
  detail?: string;
}

export interface RegistryActionResults {
  kind: RegistryActionKind;
  title: string;
  items: RegistryActionItem[];
  finishedAt: number;
  summary?: string;
}

export interface ForkRegistryActionCounts {
  notAttempted: number;
  unknown: number;
  created: number;
  existing: number;
  visible: number;
  pendingVisibility: number;
  ownershipMismatch: number;
  failed: number;
}

export function registryActionCounts(
  items: RegistryActionItem[],
): Record<RegistryActionStatus, number> {
  const counts: Record<RegistryActionStatus, number> = {
    created: 0,
    existing: 0,
    removed: 0,
    not_followed: 0,
    pending: 0,
    failed: 0,
    unknown: 0,
    not_attempted: 0,
  };
  for (const item of items) counts[item.status] += 1;
  return counts;
}

export function forkRegistryActionCounts(
  items: RegistryActionItem[],
): ForkRegistryActionCounts {
  const counts: ForkRegistryActionCounts = {
    notAttempted: 0,
    unknown: 0,
    created: 0,
    existing: 0,
    visible: 0,
    pendingVisibility: 0,
    ownershipMismatch: 0,
    failed: 0,
  };
  for (const item of items) {
    if (item.creationStatus === "not_attempted") {
      counts.notAttempted += 1;
      continue;
    }
    if (item.creationStatus === "unknown") {
      counts.unknown += 1;
      continue;
    }
    if (item.creationStatus === "created") counts.created += 1;
    if (item.creationStatus === "existing") counts.existing += 1;
    if (item.reconciliationStatus === "visible") counts.visible += 1;
    else if (item.reconciliationStatus === "pending_visibility")
      counts.pendingVisibility += 1;
    else if (item.reconciliationStatus === "ownership_mismatch")
      counts.ownershipMismatch += 1;
    else if (item.reconciliationStatus === "failed" || item.status === "failed")
      counts.failed += 1;
  }
  return counts;
}

export function forkRegistryActionItem(
  result: PulseVariantResult,
  metricLabel: string,
  index: number,
): RegistryActionItem {
  const creationStatus =
    result.creationStatus ??
    (result.status === "created" || result.status === "existing"
      ? result.status
      : undefined);
  const reconciliationStatus =
    result.reconciliationStatus ??
    (result.status === "visible" ||
    result.status === "pending_visibility" ||
    result.status === "ownership_mismatch" ||
    result.status === "failed"
      ? result.status
      : undefined);
  const status: RegistryActionStatus =
    reconciliationStatus === "visible"
      ? creationStatus === "existing"
        ? "existing"
        : creationStatus === "created"
          ? "created"
          : "failed"
      : reconciliationStatus === "pending_visibility"
        ? "pending"
        : "failed";
  return {
    key: `fork:${result.sourceMetricId}:${result.metricId ?? index}`,
    metricId: result.sourceMetricId,
    metricLabel,
    status,
    ...(result.metricId ? { resultMetricId: result.metricId } : {}),
    ...(creationStatus ? { creationStatus } : {}),
    ...(reconciliationStatus ? { reconciliationStatus } : {}),
    ...(result.requestedSpecification !== undefined
      ? { requestedSpecification: result.requestedSpecification }
      : {}),
    ...(result.error ? { detail: result.error } : {}),
  };
}

export function registryActionLabel(
  kind: RegistryActionKind,
  item: RegistryActionItem,
): string {
  if (kind === "fork") {
    if (item.creationStatus === "not_attempted") return "not sent";
    if (item.creationStatus === "unknown") return "creation outcome unknown";
    const creation =
      item.creationStatus === "created"
        ? "created"
        : item.creationStatus === "existing"
          ? "already exists"
          : null;
    const reconciliation =
      item.reconciliationStatus === "visible"
        ? "visibility verified"
        : item.reconciliationStatus === "pending_visibility"
          ? "visibility pending"
          : item.reconciliationStatus === "ownership_mismatch"
            ? "ownership mismatch"
            : item.reconciliationStatus === "failed"
              ? "visibility verification failed"
              : "reconciliation status unavailable";
    return creation ? `${creation}; ${reconciliation}` : reconciliation;
  }
  if (item.status === "created")
    return kind === "follow" ? "followed" : "created";
  if (item.status === "existing")
    return kind === "follow" ? "already followed" : "already exists";
  if (item.status === "removed")
    return kind === "delete" ? "deleted" : "unfollowed";
  if (item.status === "not_followed") return "not followed";
  if (item.status === "pending") return "pending";
  if (item.status === "unknown") return "outcome unknown";
  if (item.status === "not_attempted") return "not sent";
  return "failed";
}

/**
 * Overall outcome of a batch of registry actions, for the results modal's
 * colored strip. `pending` items (e.g. a fork awaiting visibility) are not
 * failures, so a batch with no hard failures reads as success.
 */
export function registryActionOutcome(
  items: RegistryActionItem[],
): "success" | "mixed" | "fail" {
  if (items.length === 0) return "success";
  const failed = items.filter((item) =>
    ["failed", "unknown", "not_attempted"].includes(item.status),
  ).length;
  if (failed === 0) return "success";
  if (failed === items.length) return "fail";
  return "mixed";
}

export interface RegistryTargetSummary {
  targetLabel: string;
  total: number;
  created: number;
  existing: number;
  removed: number;
  notFollowed: number;
  failed: number;
  unknown?: number;
  notAttempted?: number;
}

/**
 * Group follow/unfollow results by the target (a user or group) they acted on,
 * so the results modal can say "Group Sales now follows 13 of 13 metrics"
 * per target rather than listing every metric. Preserves first-seen order.
 */
export function summarizeRegistryTargets(
  items: RegistryActionItem[],
): RegistryTargetSummary[] {
  const byTarget = new Map<string, RegistryTargetSummary>();
  for (const item of items) {
    const targetLabel = item.targetLabel ?? "";
    let summary = byTarget.get(targetLabel);
    if (!summary) {
      summary = {
        targetLabel,
        total: 0,
        created: 0,
        existing: 0,
        removed: 0,
        notFollowed: 0,
        failed: 0,
      };
      byTarget.set(targetLabel, summary);
    }
    summary.total += 1;
    if (item.status === "created") summary.created += 1;
    else if (item.status === "existing") summary.existing += 1;
    else if (item.status === "removed") summary.removed += 1;
    else if (item.status === "not_followed") summary.notFollowed += 1;
    else if (item.status === "failed") summary.failed += 1;
    else if (item.status === "unknown")
      summary.unknown = (summary.unknown ?? 0) + 1;
    else if (item.status === "not_attempted")
      summary.notAttempted = (summary.notAttempted ?? 0) + 1;
  }
  return [...byTarget.values()];
}

/**
 * One-line, non-alarming headline for a single follow/unfollow target. Both
 * "newly followed" and "already followed" count as success (following is
 * idempotent), so a target already following some metrics never reads as a
 * failure. Only genuine errors are surfaced, in parentheses.
 */
export function registryTargetHeadline(
  kind: "follow" | "unfollow",
  summary: RegistryTargetSummary,
): string {
  const label = summary.targetLabel || "Target";
  const metricWord = (count: number) =>
    `${count} of ${summary.total} metric${summary.total === 1 ? "" : "s"}`;
  if (kind === "follow") {
    const now = summary.created + summary.existing;
    const extra: string[] = [];
    if (summary.existing > 0)
      extra.push(`${summary.existing} already followed`);
    if (summary.failed > 0) extra.push(`${summary.failed} failed`);
    if (summary.unknown) extra.push(`${summary.unknown} outcomes unknown`);
    if (summary.notAttempted) extra.push(`${summary.notAttempted} not sent`);
    return `${label} now follows ${metricWord(now)}${extra.length ? ` (${extra.join(", ")})` : ""}`;
  }
  const removed = summary.removed;
  const extra: string[] = [];
  if (summary.notFollowed > 0)
    extra.push(`${summary.notFollowed} were not followed`);
  if (summary.failed > 0) extra.push(`${summary.failed} failed`);
  if (summary.unknown) extra.push(`${summary.unknown} outcomes unknown`);
  if (summary.notAttempted) extra.push(`${summary.notAttempted} not sent`);
  return `${label} unfollowed ${metricWord(removed)}${extra.length ? ` (${extra.join(", ")})` : ""}`;
}

export async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const size = Math.max(1, Math.floor(concurrency));
  for (let index = 0; index < values.length; index += size) {
    results.push(
      ...(await Promise.all(values.slice(index, index + size).map(operation))),
    );
  }
  return results;
}
