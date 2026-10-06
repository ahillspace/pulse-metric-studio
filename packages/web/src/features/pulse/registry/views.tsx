import { useEffect, useMemo, useRef, useState } from "react";
import type {
  PulseDefinitionNode as DefinitionNode,
  PulseMetricVariant as MetricVariant,
} from "@pulse-metric-studio/shared";
import type { FollowState, FollowersDetail } from "./view-types";
import { useRegistry } from "./controller";
import { followStateLabel } from "../follow-state";
import {
  selectionState,
  timeframeScopeSignature,
  timeframeScopeFamilyMetricIds,
  type PulseRegistryMetric,
} from "../fork-plan";
import {
  forkRegistryActionCounts,
  registryActionCounts,
  registryActionOutcome,
  registryActionLabel,
  summarizeRegistryTargets,
  registryTargetHeadline,
  type RegistryActionResults,
} from "../registry-actions";
import { Modal } from "../components/ui";

export function MetricRow({
  definition,
  variant,
  metric,
  selectedMetricIds,
  allMetrics,
  highlighted,
  onSelectionChange,
  onToggleTimeframeFamily,
  onPreview,
  previewed = false,
}: {
  definition: DefinitionNode;
  variant: MetricVariant;
  metric: PulseRegistryMetric;
  selectedMetricIds: string[];
  allMetrics: PulseRegistryMetric[];
  highlighted: boolean;
  onPreview?: () => void;
  previewed?: boolean;
  onSelectionChange: (checked: boolean) => void;
  onToggleTimeframeFamily: (metric: PulseRegistryMetric) => void;
}) {
  const followState = useRegistry((state) => state.followState);
  const signature = timeframeScopeSignature(metric);
  const familyIds = timeframeScopeFamilyMetricIds(allMetrics, signature);
  const familySelection = selectionState(selectedMetricIds, familyIds);
  const userFollow = Boolean(
    followState?.userFollowsByMetricId[variant.metricId],
  );
  const groupFollow = Boolean(
    followState?.groupFollowsByMetricId[variant.metricId],
  );
  const scoped = variant.isScoped || Boolean(variant.filters?.length);

  return (
    <div
      className={`variant-row pulse-metric-row ${highlighted ? "pulse-metric-highlight" : ""}`}
    >
      <input
        className="metric-source-checkbox"
        type="checkbox"
        aria-label={`Select ${metric.name} - ${variant.timeframeLabel}`}
        checked={selectedMetricIds.includes(variant.metricId)}
        onChange={(event) => onSelectionChange(event.target.checked)}
      />
      <span
        className={`follow-dot ${userFollow ? "me" : groupFollow ? "group" : ""}`}
        aria-hidden="true"
      />
      <span className="pulse-follow-label">
        {followStateLabel(followState, variant.metricId)}
      </span>
      <button
        className="tf-label pulse-timeframe-button"
        type="button"
        aria-pressed={familySelection.checked}
        title={(() => {
          const scope = scoped ? "identically filtered " : "unfiltered ";
          const verb = familySelection.checked ? "Clear" : "Select";
          return `${verb} all ${familyIds.length} ${scope}${variant.timeframeLabel} metric${familyIds.length === 1 ? "" : "s"} across definitions`;
        })()}
        onClick={() => onToggleTimeframeFamily(metric)}
      >
        {variant.timeframeLabel}
      </button>
      {scoped && <span className="pulse-scope-label">Scoped</span>}
      <span className="pulse-metric-name">{metric.name}</span>
      {onPreview && (
        <button
          className="btn small pulse-registry-icon"
          type="button"
          aria-label={`Preview ${metric.name}`}
          title="Preview metric"
          aria-pressed={previewed}
          onClick={onPreview}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M2 10s3-6 8-6 8 6 8 6-3 6-8 6-8-6-8-6Z" />
            <circle cx="10" cy="10" r="2.5" />
          </svg>
        </button>
      )}
      <CopyIdButton metricId={variant.metricId} />
    </div>
  );
}

export function SelectionCheckbox({
  label,
  state,
  onChange,
}: {
  label: string;
  state: ReturnType<typeof selectionState>;
  onChange: (checked: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = state.indeterminate;
  }, [state.indeterminate]);
  return (
    <input
      ref={inputRef}
      className="metric-source-checkbox"
      type="checkbox"
      aria-label={label}
      checked={state.checked}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

export function FollowerBadges({
  definition,
  onAudit,
}: {
  definition: DefinitionNode;
  onAudit: () => void;
}) {
  const followState = useRegistry((state) => state.followState);
  const loading = useRegistry((state) => state.followLoading);
  const summary = summarizeFollowerRelationships(
    definition.metrics.map((metric) => metric.metricId),
    followState,
  );
  return (
    <button
      className="metric-id-btn"
      type="button"
      aria-label={`View followers for ${cleanName(definition.name)}`}
      onClick={onAudit}
    >
      {loading &&
      !definition.metrics.some(
        (metric) => followState?.availabilityByMetricId?.[metric.metricId],
      )
        ? "Loading followers..."
        : `${summary.user} people / ${summary.groups} groups`}
    </button>
  );
}

export interface DistinctFollowerCounts {
  individuals: number;
  groups: number;
  individualsUnavailable: boolean;
  groupsUnavailable: boolean;
}

/**
 * Count DISTINCT individuals (USERs) and DISTINCT groups following across a set
 * of metrics, taken from the same membership-agnostic subscription data the
 * followers modal uses. A follower present on several of the metrics counts
 * once. When a metric's relationship data is unavailable the corresponding
 * "unavailable" flag is set so the caller can degrade gracefully instead of
 * reporting a confident but wrong zero.
 */
export function countDistinctFollowers(
  metricIds: string[],
  followState: FollowState | null,
): DistinctFollowerCounts {
  if (!followState) {
    return {
      individuals: 0,
      groups: 0,
      individualsUnavailable: true,
      groupsUnavailable: true,
    };
  }
  const userFollowerIds = new Set<string>();
  const groupFollowerIds = new Set<string>();
  let individualsUnavailable = false;
  let groupsUnavailable = false;
  for (const metricId of metricIds) {
    const userIds = followState.userFollowerIdsByMetricId?.[metricId];
    const groupIds = followState.groupFollowerIdsByMetricId?.[metricId];
    const availability = followState.availabilityByMetricId?.[metricId];
    const relationship =
      availability?.followerIdsStatus ??
      availability?.relationshipStatus ??
      availability?.status;
    const relationshipUnavailable =
      relationship !== undefined && relationship !== "available";
    if (userIds) for (const id of userIds) userFollowerIds.add(id);
    if (
      !userIds ||
      (availability?.followerIdsStatus && relationshipUnavailable)
    )
      individualsUnavailable = true;
    if (groupIds) for (const id of groupIds) groupFollowerIds.add(id);
    if (
      !groupIds ||
      (availability?.followerIdsStatus && relationshipUnavailable)
    )
      groupsUnavailable = true;
  }
  return {
    individuals: userFollowerIds.size,
    groups: groupFollowerIds.size,
    individualsUnavailable,
    groupsUnavailable,
  };
}

export function summarizeFollowerRelationships(
  metricIds: string[],
  followState: FollowState | null,
): { user: string; groups: string } {
  if (!followState) return { user: "unavailable", groups: "unavailable" };
  const counts = countDistinctFollowers(metricIds, followState);
  return {
    user: formatRelationshipCount(
      counts.individuals,
      counts.individualsUnavailable,
    ),
    groups: formatRelationshipCount(counts.groups, counts.groupsUnavailable),
  };
}

function formatRelationshipCount(count: number, unavailable: boolean): string {
  if (!unavailable) return String(count);
  return count > 0 ? `at least ${count}` : "unavailable";
}

function CopyIdButton({ metricId }: { metricId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="metric-id-btn"
      type="button"
      title={metricId}
      aria-label={`Copy metric ID ${metricId}`}
      onClick={() => {
        void navigator.clipboard.writeText(metricId).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "Copied" : "Copy ID"}
    </button>
  );
}

/**
 * Concise, non-alarming headline lines for a results batch. Follow/unfollow are
 * summarized per target ("Group Sales now follows 13 of 13 metrics"); fork and
 * delete get a single roll-up. Already-followed and existing are successes, so
 * an idempotent re-follow never reads as a failure.
 */
export function registryResultHeadlines(
  results: RegistryActionResults,
): string[] {
  if (results.kind === "follow" || results.kind === "unfollow") {
    return summarizeRegistryTargets(results.items).map((summary) =>
      registryTargetHeadline(results.kind as "follow" | "unfollow", summary),
    );
  }
  if (results.kind === "fork") {
    const forkCounts = forkRegistryActionCounts(results.items);
    const parts = [`${forkCounts.created} created`];
    if (forkCounts.existing > 0)
      parts.push(`${forkCounts.existing} already existed`);
    if (forkCounts.pendingVisibility > 0)
      parts.push(`${forkCounts.pendingVisibility} pending visibility`);
    if (forkCounts.ownershipMismatch > 0)
      parts.push(`${forkCounts.ownershipMismatch} ownership mismatch`);
    if (forkCounts.failed > 0) parts.push(`${forkCounts.failed} failed`);
    if (forkCounts.unknown > 0)
      parts.push(`${forkCounts.unknown} outcome unknown`);
    if (forkCounts.notAttempted > 0)
      parts.push(`${forkCounts.notAttempted} not sent`);
    return [`${parts.join(", ")}.`];
  }
  const counts = registryActionCounts(results.items);
  const parts: string[] = [];
  if (counts.removed > 0) parts.push(`${counts.removed} removed`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.unknown > 0) parts.push(`${counts.unknown} outcome unknown`);
  if (counts.not_attempted > 0) parts.push(`${counts.not_attempted} not sent`);
  return [`${parts.length > 0 ? parts.join(", ") : "Nothing removed"}.`];
}

export function RegistryResultsModal({
  results,
  onDismiss,
}: {
  results: RegistryActionResults;
  onDismiss: () => void;
}) {
  const outcome = registryActionOutcome(results.items);
  const headlines = registryResultHeadlines(results);
  return (
    <Modal
      title={results.title}
      outcome={outcome}
      onClose={onDismiss}
      actions={
        <button className="btn primary" type="button" onClick={onDismiss}>
          Done
        </button>
      }
    >
      {results.summary && (
        <p className="warning-banner" role="alert">
          {results.summary}
        </p>
      )}
      <div className="pulse-results-headline" role="status">
        {headlines.map((headline, index) => (
          <div key={index} className={outcome === "fail" ? "err" : ""}>
            {headline}
          </div>
        ))}
      </div>
      <details className="pulse-results-detail">
        <summary>Per-metric detail ({results.items.length})</summary>
        <ul className="result-list">
          {results.items.map((item) => (
            <li
              key={item.key}
              className={item.status === "failed" ? "err" : ""}
            >
              <strong>{item.metricLabel}</strong>
              {item.targetLabel ? ` - ${item.targetLabel}` : ""}:{" "}
              {registryActionLabel(results.kind, item)}
              {item.detail ? ` - ${item.detail}` : ""}
            </li>
          ))}
        </ul>
      </details>
    </Modal>
  );
}

export function deletionBlastRadius(counts: DistinctFollowerCounts): {
  summary: string;
  note: string | null;
} {
  const fullyUnavailable =
    counts.individuals === 0 &&
    counts.groups === 0 &&
    counts.individualsUnavailable &&
    counts.groupsUnavailable;
  if (fullyUnavailable) {
    return {
      summary: "Follower reach is unavailable for the selected metrics.",
      note: null,
    };
  }
  const summary = `${counts.individuals} individual${counts.individuals === 1 ? "" : "s"} and ${counts.groups} group${counts.groups === 1 ? "" : "s"} follow the selected metrics.`;
  const note =
    counts.individualsUnavailable || counts.groupsUnavailable
      ? "Some follower data is unavailable, so the true reach may be higher."
      : null;
  return { summary, note };
}

export function FollowersList({ definition }: { definition: DefinitionNode }) {
  const [details, setDetails] = useState<FollowersDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const variantById = useMemo(
    () =>
      new Map(definition.metrics.map((metric) => [metric.metricId, metric])),
    [definition],
  );
  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setError(null);
    void useRegistry
      .getState()
      .loadFollowers(definition.metrics.map((metric) => metric.metricId))
      .then((response) => {
        if (!cancelled) setDetails(response.details);
      })
      .catch((loadError) => {
        if (!cancelled)
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
      });
    return () => {
      cancelled = true;
    };
  }, [definition]);

  if (error)
    return (
      <div className="dimension-fork-error" role="alert">
        Followers are unavailable: {error}
      </div>
    );
  if (!details)
    return (
      <div className="empty-note" role="status">
        Loading followers...
      </div>
    );
  return (
    <ul className="result-list pulse-followers-list">
      {details.map((detail) => {
        const friendlyName = forkFriendlyName(
          variantById.get(detail.metricId),
          definition.name,
          detail.metricId,
        );
        const lines = followerDetailLines(detail);
        return (
          <li key={detail.metricId} className="pulse-follower-metric">
            <div className="pulse-follower-metric-head">
              <strong>{cleanName(friendlyName)}</strong>
              <CopyLuidButton luid={detail.metricId} />
            </div>
            <ul className="result-list pulse-follower-lines">
              {lines.map((line) => (
                <li key={line.key} className={line.error ? "err" : undefined}>
                  {line.text}
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

function CopyLuidButton({ luid }: { luid: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="metric-id-btn"
      type="button"
      title={luid}
      aria-label={`Copy LUID ${luid}`}
      onClick={() => {
        void navigator.clipboard.writeText(luid).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "Copied" : "Copy LUID"}
    </button>
  );
}

export interface FollowerDetailItem {
  key: string;
  text: string;
  error: boolean;
}

/**
 * Follower lines for a single metric, WITHOUT the raw metric LUID prefix - the
 * friendly name and a Copy LUID control lead the group in the modal instead.
 */
export function followerDetailLines(
  detail: FollowersDetail,
): FollowerDetailItem[] {
  const items: FollowerDetailItem[] = detail.followers.map(
    (follower, index) => ({
      key: `${detail.metricId}-${follower.id}-${index}`,
      text: `${follower.type === "GROUP" ? "Group" : follower.type === "USER" ? "User" : "Unknown"} - ${follower.name || follower.id}`,
      error: false,
    }),
  );
  const diagnostics = [
    ...detail.errors,
    ...(detail.diagnostics ?? []).map((diagnostic) => diagnostic.message),
  ].filter((message, index, all) => message && all.indexOf(message) === index);
  const incomplete =
    detail.status === "partial" ||
    detail.status === "unavailable" ||
    diagnostics.length > 0;

  if (incomplete) {
    const availability =
      detail.status === "partial" || detail.followers.length > 0
        ? "partial"
        : "unavailable";
    items.push({
      key: `${detail.metricId}-diagnostic`,
      text: `Follower details are ${availability}${diagnostics.length > 0 ? ` - ${diagnostics.join("; ")}` : ""}`,
      error: true,
    });
  } else if (detail.followers.length === 0) {
    items.push({
      key: `${detail.metricId}-empty`,
      text: "No followers yet",
      error: false,
    });
  }

  return items;
}

/**
 * Friendly label for a metric (default or fork) shown in the followers modal.
 * A fork is a derived metric produced by a dimensional filter (and/or a distinct
 * timeframe) on a source metric, so the scheme is:
 *   - dimensional fork:  "<source name> - <field>: <values>"  (e.g. "Average Win Rate - Region: West")
 *   - timeframe variant: "<source name> - <timeframe label>"
 *   - otherwise:         "<source name>"
 * A bare LUID is never the only label.
 */
export function forkFriendlyName(
  variant:
    { name?: string; timeframeLabel?: string; filters?: unknown[] } | undefined,
  definitionName: string,
  metricId: string,
): string {
  // Unnamed metrics fall back to their LUID as `name` upstream, so a name that
  // is just the metric id is not a real name - lead with the definition name
  // instead, never the raw LUID.
  const base = metricDisplayName(variant?.name, definitionName, metricId);
  const summary = dimensionalFilterSummary(variant?.filters ?? []);
  if (summary) return `${base} - ${summary}`;
  const timeframe = variant?.timeframeLabel?.trim();
  if (timeframe) return `${base} - ${timeframe}`;
  return base;
}

function dimensionalFilterSummary(filters: unknown[]): string {
  return filters
    .map((filter) => {
      if (!filter || typeof filter !== "object") return "";
      const record = filter as Record<string, unknown>;
      const field = typeof record.field === "string" ? record.field.trim() : "";
      if (!field) return "";
      const values = Array.isArray(record.categorical_values)
        ? record.categorical_values
            .map((value) =>
              value && typeof value === "object"
                ? String(
                    (value as Record<string, unknown>).string_value ?? "",
                  ).trim()
                : "",
            )
            .filter(Boolean)
        : [];
      return values.length > 0 ? `${field}: ${values.join(", ")}` : field;
    })
    .filter(Boolean)
    .join("; ");
}

export function metricDisplayName(
  name: string | undefined,
  definitionName: string,
  metricId: string,
): string {
  const isIdentity = (value: string) =>
    value === metricId ||
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
  const candidate = [name, definitionName]
    .map((value) => value?.trim())
    .find((value) => value && !isIdentity(value));
  return candidate ? cleanName(candidate) : "Metric name unavailable";
}

export function flattenMetrics(
  definitions: DefinitionNode[],
): PulseRegistryMetric[] {
  return definitions.flatMap((definition) =>
    definition.metrics.map((metric) => ({
      metricId: metric.metricId,
      definitionId: definition.definitionId,
      name: metricDisplayName(metric.name, definition.name, metric.metricId),
      timeframeLabel: metric.timeframeLabel,
      measurementPeriod: metric.measurementPeriod ?? null,
      ...(metric.filters ? { filters: metric.filters } : {}),
      ...(metric.comparison !== undefined
        ? { comparison: metric.comparison }
        : {}),
      ...(metric.specification ? { specification: metric.specification } : {}),
      ...(metric.isDefault !== undefined
        ? { isDefault: metric.isDefault }
        : {}),
      ...(metric.scopedState !== undefined
        ? { scopedState: metric.scopedState }
        : {}),
    })),
  );
}

export function getForkDisabledReason(input: {
  selectedCount: number;
  hasChanges: boolean;
  dimensionsUnresolved: boolean;
  busy: boolean;
}): string | null {
  if (input.busy) return "A registry action is in progress.";
  if (input.selectedCount === 0)
    return "Select at least one exact source metric.";
  if (!input.hasChanges)
    return "Stage a target timeframe or at least one dimension clause.";
  if (input.dimensionsUnresolved)
    return "Wait for dimension compatibility to finish.";
  return null;
}

export function cleanName(name: string): string {
  return name.replace(/calculation_[a-z0-9]+/gi, "(calc)");
}

/**
 * Readable preview header for a source metric: its name (or the definition name
 * when the metric is unnamed and falls back to its LUID upstream) plus the
 * effective timeframe. Never leads with a raw LUID.
 */
export function previewSourceLabel(
  name: string | undefined,
  definitionName: string,
  metricId: string,
  timeframeLabel: string,
): string {
  const base = metricDisplayName(name, definitionName, metricId);
  const timeframe = timeframeLabel.trim();
  return timeframe ? `${base} - ${timeframe}` : base;
}

export function safeDomId(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, "_");
}
