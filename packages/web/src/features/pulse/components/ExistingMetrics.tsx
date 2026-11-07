import { memo, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { activeEditor, contextMatches, useAuthor } from "../author/controller";
import { useConnection } from "../connections/controller";
import { registryScopeKey, useRegistry } from "../registry/controller";
import { metricIsFollowed } from "../follow-state";
import {
  reconcileMetricSelection,
  selectionState,
  setMetricSelection,
  timeframeScopeFamilies,
  timeframeScopeSignature,
  type PulseRegistryMetric,
} from "../fork-plan";
import {
  MetricRow,
  SelectionCheckbox,
  FollowerBadges,
  RegistryResultsModal,
  FollowersList,
  flattenMetrics,
  cleanName,
  previewSourceLabel,
  reviewedMetricLabel,
  reviewedDefinitionLabel,
  ReviewedResourceId,
  ReviewedMetricFollowers,
} from "../registry/views";
import { JobProgress } from "../jobs/JobProgress";
import { CooldownBanner } from "../registry/CooldownBanner";
import { VariantDialog } from "../registry/VariantDialog";
import { InventoryFailures } from "../registry/InventoryFailures";
import { FollowTargetModal } from "./FollowTargetModal";
import { BusyLabel, Modal } from "./ui";
import { createPreviewController, requestMetricPreview } from "../registry/preview-controller";
import { MetricPreview } from "../registry/MetricPreview";
import { sessionOwnerKey } from "../shell/session-events";

export {
  countDistinctFollowers,
  deletionBlastRadius,
  followerDetailLines,
  forkFriendlyName,
  previewSourceLabel,
  summarizeFollowerRelationships,
  registryResultHeadlines,
} from "../registry/views";

export const ExistingMetrics = memo(function ExistingMetrics({ visible = true }: { visible?: boolean }) {
  const context = useAuthor(useShallow((state) => activeEditor(state)?.record.context ?? null));
  const datasourceName = useAuthor((state) => activeEditor(state)?.record.datasourceName ?? "");
  const session = useConnection((state) => state.session);
  const registry = useRegistry(useShallow((state) => ({
    inventory: state.inventory, followState: state.followState,
    pendingProviderOperations: state.pendingProviderOperations, loading: state.loading, followLoading: state.followLoading, error: state.error,
    cooldown: state.cooldown, pollCooldown: state.pollCooldown, job: state.job, cancelJob: state.cancelJob,
    busy: state.busy, results: state.results, createdMetricIds: state.createdMetricIds,
    deletePlan: state.deletePlan, deleteLoading: state.deleteLoading,
    deleteError: state.deleteError, deleteOverridable: state.deleteOverridable,
    mutationAvailable: state.mutationAvailable, refresh: state.refresh, fork: state.fork,
    previewDelete: state.previewDelete, executeDelete: state.executeDelete,
    reviewDeleteAnyway: state.reviewDeleteAnyway, cancelDelete: state.cancelDelete,
    dismissResults: state.dismissResults, loadMoreFollowState: state.loadMoreFollowState,
  })));
  useEffect(() => {
    if (!registry.pendingProviderOperations && !registry.busy && !registry.cooldown) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await registry.pollCooldown();
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [Boolean(registry.pendingProviderOperations || registry.busy || registry.cooldown), sessionOwnerKey(session)]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [onlyFollowed, setOnlyFollowed] = useState(false);
  const [plan, setPlan] = useState<{ selectedMetricIds: string[] }>({
    selectedMetricIds: [],
  });
  const [followOpen, setFollowOpen] = useState(false);
  const [followersOf, setFollowersOf] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [variantsOpen, setVariantsOpen] = useState(false);
  const connected = Boolean(context && contextMatches(context, session));
  const contextKey = JSON.stringify([context, sessionOwnerKey(session)]);
  useEffect(() => {
    setPlan({ selectedMetricIds: [] });
    setExpanded(new Set());
    setFollowOpen(false);
    setFollowersOf(null);
    setQuery("");
    setOnlyFollowed(false);
    setVariantsOpen(false);
  }, [contextKey, connected]);
  useEffect(() => {
    const state = useRegistry.getState();
    if (visible && context && connected && registryScopeKey(state.context, state.owner) === registryScopeKey(context, session))
      void state.ensureLoaded();
  }, [visible, contextKey, connected]);
  useEffect(() => {
    if (registry.deleteLoading || registry.deletePlan || registry.busy === "delete")
      setFollowersOf(null);
  }, [registry.deleteLoading, registry.deletePlan, registry.busy]);
  const existing = registry.inventory;
  const [usePreview] = useState(() => createPreviewController((context, metricId, owner) =>
    useRegistry.getState().trackProviderOperation(() => requestMetricPreview(context, metricId, owner), owner)));
  const preview = usePreview();
  const previewScope = useMemo(
    () =>
      connected &&
      context &&
      session &&
      existing &&
      !registry.loading
        ? { context, owner: session, siteContentUrl: session.siteContentUrl }
        : null,
    [contextKey, connected, session?.siteContentUrl, Boolean(existing), registry.loading],
  );
  useEffect(() => {
    usePreview.getState().setScope(previewScope);
    return () => usePreview.getState().setScope(null);
  }, [previewScope, usePreview]);
  const previewVisible = Boolean(
    previewScope && preview.scope === previewScope && preview.metric,
  );

  const allMetrics = useMemo(
    () => flattenMetrics(existing?.definitions ?? []),
    [existing],
  );
  const metricById = useMemo(
    () => new Map(allMetrics.map((metric) => [metric.metricId, metric])),
    [allMetrics],
  );
  const selectedMetricIds = useMemo(
    () => new Set(plan.selectedMetricIds),
    [plan.selectedMetricIds],
  );
  const timeframeFamilies = useMemo(
    () => timeframeScopeFamilies(allMetrics),
    [allMetrics],
  );
  const familySelectionByMetricId = useMemo(() => {
    const states = new Map<string, ReturnType<typeof selectionState>>();
    for (const ids of timeframeFamilies.values()) {
      const state = selectionState(selectedMetricIds, ids);
      for (const id of ids) states.set(id, state);
    }
    return states;
  }, [timeframeFamilies, selectedMetricIds]);
  const createdMetricIds = useMemo(
    () => new Set(registry.createdMetricIds),
    [registry.createdMetricIds],
  );
  const definitionById = useMemo(
    () =>
      new Map(
        (existing?.definitions ?? []).map((definition) => [
          definition.definitionId,
          definition,
        ]),
      ),
    [existing],
  );
  useEffect(() => {
    setPlan((current) => ({
      ...current,
      selectedMetricIds: reconcileMetricSelection(
        current.selectedMetricIds,
        allMetrics.map((metric) => metric.metricId),
      ),
    }));
  }, [allMetrics]);
  const visibilityFollowState = onlyFollowed ? registry.followState : null;
  const displayedDefinitions = useMemo(() => (existing?.definitions ?? [])
    .map((definition) => onlyFollowed ? {
      ...definition,
      metrics: definition.metrics.filter((metric) => metricIsFollowed(visibilityFollowState, metric.metricId)),
    } : definition)
    .filter(
      (definition) =>
        (!onlyFollowed || definition.metrics.length > 0) &&
        `${definition.name} ${definition.measure}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    ), [existing, onlyFollowed, visibilityFollowState, query]);
  const expandedKey = JSON.stringify([...expanded].sort());
  const inventoryViewId = existing?.viewId ?? existing?.snapshotId;
  // Capture demand at an explicit expansion/filter change, including when counts
  // are still pending. A later local patch must not silently inspect new rows.
  const capturedDetailIdsKey = useMemo(() => JSON.stringify((onlyFollowed ? allMetrics : allMetrics.filter((metric) => expanded.has(metric.definitionId)))
    .map((metric) => metric.metricId).sort()), [onlyFollowed, inventoryViewId, expandedKey]);
  // Local removals retire demand immediately; additions wait for explicit demand.
  const detailIdsKey = useMemo(() => JSON.stringify((JSON.parse(capturedDetailIdsKey) as string[])
    .filter(id => metricById.has(id))), [capturedDetailIdsKey, metricById]);
  const canLoadMoreFollowDetails = (JSON.parse(detailIdsKey) as string[])
    .some(id => registry.followState?.availabilityByMetricId?.[id]?.canLoadMore === true);
  useEffect(() => {
    const state = useRegistry.getState();
    if (visible && connected && !registry.loading && !registry.followLoading &&
      registryScopeKey(state.context, state.owner) === registryScopeKey(context, session))
      void useRegistry.getState().ensureFollowState(JSON.parse(detailIdsKey) as string[]);
  }, [visible, contextKey, connected, detailIdsKey, registry.loading, registry.followLoading, inventoryViewId]);
  const displayedIds = useMemo(() => displayedDefinitions.flatMap((definition) =>
    definition.metrics.map((metric) => metric.metricId),
  ), [displayedDefinitions]);
  const registrySelection = selectionState(
    selectedMetricIds,
    displayedIds,
  );
  const selectedSources = useMemo(() => plan.selectedMetricIds
    .map((id) => metricById.get(id))
    .filter((metric): metric is PulseRegistryMetric => Boolean(metric))
    .map((metric) => ({
      id: metric.metricId,
      label: previewSourceLabel(
        metric.name,
        definitionById.get(metric.definitionId)?.name ?? metric.name,
        metric.metricId,
        metric.timeframeLabel ?? "",
      ),
    })), [plan.selectedMetricIds, metricById, definitionById]);
  const allDisplayedExpanded =
    displayedDefinitions.length > 0 &&
    displayedDefinitions.every((definition) =>
      expanded.has(definition.definitionId),
    );
  const toggleFamily = (metric: PulseRegistryMetric) => {
    const ids = timeframeFamilies.get(timeframeScopeSignature(metric)) ?? [];
    const selected = familySelectionByMetricId.get(metric.metricId)!;
    setPlan((current) => ({
      ...current,
      selectedMetricIds: setMetricSelection(
        current.selectedMetricIds,
        ids,
        !selected.checked,
      ),
    }));
    if (!selected.checked) {
      const selectedIds = new Set(ids);
      setExpanded(
        (current) =>
          new Set([
            ...current,
            ...allMetrics
              .filter((item) => selectedIds.has(item.metricId))
              .map((item) => item.definitionId),
          ]),
      );
      setQuery("");
      setOnlyFollowed(false);
    }
  };
  if (!context)
    return (
      <section className="panel">
        <div className="panel-body">
          Choose a datasource to inspect its published metrics.
        </div>
      </section>
    );
  if (!connected)
    return (
      <section className="panel">
        <div className="panel-body">
          Connect to Tableau to view existing metrics.
        </div>
        {registry.results && !followOpen && (
          <RegistryResultsModal
            cooldown={registry.cooldown}
            results={registry.results}
            onDismiss={registry.dismissResults}
          />
        )}
      </section>
    );
  const followerDefinition = followersOf
    ? definitionById.get(followersOf)
    : null;
  return (
    <section
      className="panel"
      id="registry-panel"
      aria-labelledby="registry-heading"
    >
      <div className="pulse-registry-toolbar">
        <h2 className="pulse-registry-heading" id="registry-heading">
          Definitions <span>{existing?.definitions.length ?? 0}</span>
        </h2>
        <label className="pulse-registry-search">
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="m13 13 4 4" />
          </svg>
          <input
            type="search"
            aria-label="Find definitions"
            placeholder="Search definitions..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="pulse-native-checkbox">
          <input
            type="checkbox"
            checked={onlyFollowed}
            onChange={(event) => setOnlyFollowed(event.target.checked)}
          />
          Following
        </label>
        <button
          className="btn small"
          onClick={() =>
            setExpanded(
              new Set(
                allDisplayedExpanded
                  ? []
                  : displayedDefinitions.map(
                      (definition) => definition.definitionId,
                    ),
              ),
            )
          }
        >
          {allDisplayedExpanded ? "Collapse all" : "Expand all"}
        </button>
        <button
          className="btn small pulse-registry-icon"
          aria-label="Refresh metrics"
          title="Refresh metrics"
          disabled={registry.loading}
          onClick={() => void registry.refresh()}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M16 7a6 6 0 1 0 .2 5M16 3v4h-4" />
          </svg>
        </button>
      </div>
      <div className="panel-body">
        <div className="pulse-registry-actionbar">
          <SelectionCheckbox
            label="Select displayed metrics"
            state={registrySelection}
            onChange={(checked) =>
              setPlan((current) => ({
                ...current,
                selectedMetricIds: setMetricSelection(
                  current.selectedMetricIds,
                  displayedIds,
                  checked,
                ),
              }))
            }
          />
          <span className="pulse-registry-count" role="status">
            {selectedSources.length
              ? `${selectedSources.length} selected`
              : `${allMetrics.length} ${allMetrics.length === 1 ? "metric" : "metrics"}`}
          </span>
          <button
            className="btn small"
            disabled={Boolean(registry.busy) || Boolean(registry.cooldown) || !registry.mutationAvailable || !allMetrics.length}
            aria-haspopup="dialog"
            onClick={() => setVariantsOpen(true)}
          >
            Create variants
          </button>
          {selectedSources.length > 0 && (
            <>
              <button
                className="btn small"
                disabled={Boolean(registry.busy) || Boolean(registry.cooldown) || !registry.mutationAvailable}
                onClick={() => setFollowOpen(true)}
              >
                Follow / Unfollow
              </button>
              <button
                className="btn small danger"
                disabled={Boolean(registry.busy) || Boolean(registry.cooldown) || !registry.mutationAvailable}
                onClick={() =>
                  void registry.previewDelete(plan.selectedMetricIds, [
                    ...new Set(
                      plan.selectedMetricIds
                        .map((id) => metricById.get(id))
                        .filter((metric) => metric?.isDefault === true)
                        .map((metric) => metric!.definitionId),
                    ),
                  ])
                }
              >
                Delete selected
              </button>
              <button
                className="btn small"
                onClick={() =>
                  setPlan((current) => ({ ...current, selectedMetricIds: [] }))
                }
              >
                Clear
              </button>
            </>
          )}
        </div>
        <CooldownBanner cooldown={registry.cooldown} />
        {registry.error && (
          <p className="warning-banner" role="alert">
            Metric Manager unavailable: {registry.error}
          </p>
        )}
        {existing?.truncated && (
          <p className="warning-banner" role="status">
            Inventory is truncated. Coverage is incomplete; other definitions
            can exist beyond this returned subset.
          </p>
        )}
        {existing && <InventoryFailures inventory={existing} />}
        {registry.followState?.errors.length ? (
          <p className="warning-banner" role="status">
            Some follow information is unavailable. Unknown relationships are
            not shown as confirmed zero.
          </p>
        ) : null}
        {canLoadMoreFollowDetails && <button className="btn small" disabled={registry.followLoading} onClick={() => void registry.loadMoreFollowState(JSON.parse(detailIdsKey) as string[])}>Load more follow details</button>}
        {onlyFollowed && allMetrics.some((metric) =>
          registry.followState?.availabilityByMetricId?.[metric.metricId]?.relationshipStatus === "not_requested") && (
          <p role="status">Loading follow details. Metrics with unknown follow state remain visible.</p>
        )}
        {registry.loading && !existing && (
          <p role="status">Loading Tableau definitions...</p>
        )}
        {!registry.loading && existing && displayedDefinitions.length === 0 && (
          <p className="empty-note">
            {existing.truncated || existing.failures.length
              ? "No matching definitions appear in the available subset."
              : onlyFollowed || query
                ? "No definitions match these filters."
                : "No existing Pulse definitions exist for this datasource."}
          </p>
        )}
        {variantsOpen && (
          <VariantDialog
            snapshotId={existing?.snapshotId}
            owner={session}
            metrics={allMetrics}
            selectedMetricIds={plan.selectedMetricIds}
            cooldown={registry.cooldown}
            job={registry.busy === "fork" ? registry.job : null}
            onCancelJob={() => void registry.cancelJob()}
            busy={Boolean(registry.busy) || !registry.mutationAvailable}
            onClose={() => setVariantsOpen(false)}
            onCreate={registry.fork}
          />
        )}
        <div
          className={`pulse-registry-content ${previewVisible ? "has-preview" : ""}`}
        >
          <div className="pulse-registry-list">
            {displayedDefinitions.map((definition) => {
              const variants = definition.metrics;
              const childIds = variants.map((metric) => metric.metricId);
              return (
                <div key={definition.definitionId} className="def-row">
                  <div className="def-head pulse-definition-head">
                    <SelectionCheckbox
                      label={`Select displayed metrics in ${definition.name}`}
                      state={selectionState(selectedMetricIds, childIds)}
                      onChange={(checked) =>
                        setPlan((current) => ({
                          ...current,
                          selectedMetricIds: setMetricSelection(
                            current.selectedMetricIds,
                            childIds,
                            checked,
                          ),
                        }))
                      }
                    />
                    <button
                      className="pulse-expand-button"
                      aria-expanded={expanded.has(definition.definitionId)}
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(definition.definitionId))
                            next.delete(definition.definitionId);
                          else next.add(definition.definitionId);
                          return next;
                        })
                      }
                    >
                      {cleanName(definition.name)}
                    </button>
                    <span
                      className="def-meta"
                      title={`${definition.aggregation}(${definition.measure})${definition.timeDimension ? ` - ${definition.timeDimension}` : ""}`}
                    >
                      {definition.metrics.length}{" "}
                      {definition.metrics.length === 1 ? "metric" : "metrics"}
                      {definition.inventoryStatus !== "complete"
                        ? ` - ${definition.inventoryStatus}`
                        : ""}
                    </span>
                    <FollowerBadges
                      definition={
                        definitionById.get(definition.definitionId) ??
                        definition
                      }
                      onAudit={() => setFollowersOf(definition.definitionId)}
                    />
                    <button
                      className="btn small danger pulse-registry-icon"
                      title={`Delete definition ${definition.name}`}
                      aria-label={`Delete definition ${definition.name}`}
                      disabled={Boolean(registry.busy) || Boolean(registry.cooldown) || !registry.mutationAvailable}
                      onClick={() =>
                        void registry.previewDelete(
                          [],
                          [definition.definitionId],
                        )
                      }
                    >
                      <svg viewBox="0 0 20 20" aria-hidden="true">
                        <path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6M12 8v6" />
                      </svg>
                    </button>
                  </div>
                  {expanded.has(definition.definitionId) && (
                    <div>
                      {variants.map((variant) => (
                        <MetricRow
                          key={variant.metricId}
                          variant={variant}
                          metric={metricById.get(variant.metricId)!}
                          selected={selectedMetricIds.has(variant.metricId)}
                          familySelection={familySelectionByMetricId.get(variant.metricId)!}
                          highlighted={createdMetricIds.has(
                            variant.metricId,
                          )}
                          onSelectionChange={(checked) =>
                            setPlan((current) => ({
                              ...current,
                              selectedMetricIds: setMetricSelection(
                                current.selectedMetricIds,
                                [variant.metricId],
                                checked,
                              ),
                            }))
                          }
                          onPreview={
                            previewScope
                              ? () =>
                                  void preview.show(
                                    metricById.get(variant.metricId)!,
                                  )
                              : undefined
                          }
                          previewed={
                            previewVisible &&
                            preview.metric?.metricId === variant.metricId
                          }
                          onToggleTimeframeFamily={toggleFamily}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {previewVisible && (
            <MetricPreview key={preview.metric!.metricId} state={preview} />
          )}
        </div>
      </div>
      {registry.results && !followOpen && (
        <RegistryResultsModal
          cooldown={registry.cooldown}
          results={registry.results}
          onDismiss={registry.dismissResults}
        />
      )}
      {followOpen && (
        <FollowTargetModal
          cooldown={registry.cooldown}
          metrics={selectedSources}
          currentUserId={session?.userId ?? ""}
          currentUserName={session?.userName}
          onClose={() => setFollowOpen(false)}
        />
      )}
      {followerDefinition && (
        <Modal
          title={`Followers - ${cleanName(followerDefinition.name)}`}
          onClose={() => setFollowersOf(null)}
        >
          <FollowersList definition={followerDefinition} />
        </Modal>
      )}
      {(registry.deletePlan ||
        registry.deleteLoading ||
        registry.deleteError) && (
        <Modal
          title="Review deletion"
          className="pulse-deletion-review"
          onClose={
            registry.busy === "delete" ? undefined : registry.cancelDelete
          }
          actions={
            <>
              <button
                className="btn"
                disabled={registry.busy === "delete"}
                onClick={registry.cancelDelete}
              >
                Cancel
              </button>
              {registry.deleteOverridable ? (
                <button
                  className="btn danger"
                  disabled={registry.deleteLoading}
                  onClick={() => void registry.reviewDeleteAnyway()}
                >
                  Review whole-definition deletion
                </button>
              ) : (
                <button
                  className="btn danger"
                  disabled={
                    !registry.deletePlan ||
                    registry.deleteLoading ||
                    registry.busy === "delete" || Boolean(registry.cooldown) || !registry.mutationAvailable
                  }
                  onClick={() => void registry.executeDelete()}
                >
                  <BusyLabel busy={registry.busy === "delete"} idle="Delete reviewed resources" active="Deleting..." />
                </button>
              )}
            </>
          }
        >
          {registry.busy === "delete" && registry.job?.throttled
            ? <JobProgress job={registry.job} onCancel={() => void registry.cancelJob()} />
            : <CooldownBanner cooldown={registry.cooldown} />}
          {registry.deleteLoading && (
            <p role="status">Preparing deletion from loaded metrics...</p>
          )}
          {registry.deleteError && (
            <p className="warning-banner" role="alert">
              {registry.deleteError}
              {registry.deleteOverridable &&
                " Refresh metrics to retry, or review the loaded definition with its incomplete inventory. Tableau deletes all metrics under that definition, including any not listed."}
            </p>
          )}
          {registry.deletePlan && (
            <>
              <p className="pulse-deletion-intro">
                Delete these resources from {datasourceName}:
              </p>
              <ul className="pulse-deletion-targets">
                {registry.deletePlan.targets.map((target) => {
                  const ownFollowers = target.kind === "metric"
                    ? target.affectedMetrics?.find((metric) => metric.id === target.id)
                    : undefined;
                  const children = target.kind === "definition" ? target.affectedMetrics ?? [] : [];
                  return (
                    <li key={`${target.kind}-${target.id}`}>
                      <div className="pulse-deletion-row">
                        <strong className="pulse-deletion-name">{target.kind === "metric"
                          ? reviewedMetricLabel(target.id, metricById, target.name)
                          : reviewedDefinitionLabel(target.id, definitionById, target.name)}</strong>
                        {ownFollowers && (
                          <ReviewedMetricFollowers
                            key={`${contextKey}-${registry.deletePlan!.previewFingerprint}-${target.id}`}
                            followerCount={ownFollowers.followerCount}
                          />
                        )}
                      </div>
                      <span className="pulse-deletion-kind">
                        {target.kind === "definition"
                          ? target.inventoryComplete
                            ? `definition and its ${target.affectedMetricIds.length} ${target.affectedMetricIds.length === 1 ? "metric" : "metrics"}; associated subscriptions are removed`
                            : `definition and every metric under it (inventory incomplete, ${target.affectedMetricIds.length} listed); associated subscriptions are removed`
                          : target.inventoryComplete
                            ? "individual metric"
                            : "individual metric, deleted by ID (inventory incomplete)"}
                      </span>
                      <ReviewedResourceId id={target.id} name={target.name} kind={target.kind} />
                      {children.length > 0 && (
                        <details className="pulse-deletion-children">
                          <summary>Show {children.length} {children.length === 1 ? "metric" : "metrics"}</summary>
                          <ul className="pulse-deletion-metrics">
                            {children.map((metric) => (
                              <li key={metric.id}>
                                <div className="pulse-deletion-row">
                                  <span className="pulse-deletion-name">{reviewedMetricLabel(metric.id, metricById, metric.name)}</span>
                                  <ReviewedMetricFollowers
                                    key={`${contextKey}-${registry.deletePlan!.previewFingerprint}-${metric.id}`}
                                    followerCount={metric.followerCount}
                                  />
                                </div>
                                <ReviewedResourceId id={metric.id} name={metric.name} kind="metric" />
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </li>
                  );
                })}
              </ul>
              {registry.deletePlan.warnings.map((warning) => (
                <p className="warning-banner" key={warning}>
                  {warning}
                </p>
              ))}
              <p className="pulse-deletion-footnote">
                Uses loaded metrics and follower counts. The app cannot undo a deletion.
              </p>
            </>
          )}
        </Modal>
      )}
    </section>
  );
});
