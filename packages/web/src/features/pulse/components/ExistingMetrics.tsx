import { useEffect, useMemo, useState } from "react";
import { activeEditor, contextMatches, useAuthor } from "../author/controller";
import { useConnection } from "../connections/controller";
import { useRegistry } from "../registry/controller";
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
} from "../registry/views";
import { VariantDialog } from "../registry/VariantDialog";
import { FollowTargetModal } from "./FollowTargetModal";
import { BusyLabel, Modal } from "./ui";
import { createPreviewController } from "../registry/preview-controller";
import { MetricPreview } from "../registry/MetricPreview";

export {
  countDistinctFollowers,
  deletionBlastRadius,
  followerDetailLines,
  forkFriendlyName,
  previewSourceLabel,
  summarizeFollowerRelationships,
  registryResultHeadlines,
} from "../registry/views";

export function ExistingMetrics({ visible = true }: { visible?: boolean }) {
  const entry = useAuthor(activeEditor);
  const session = useConnection((state) => state.session);
  const registry = useRegistry();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [onlyFollowed, setOnlyFollowed] = useState(false);
  const [plan, setPlan] = useState<{ selectedMetricIds: string[] }>({
    selectedMetricIds: [],
  });
  const [followOpen, setFollowOpen] = useState(false);
  const [followersOf, setFollowersOf] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [variantsOpen, setVariantsOpen] = useState(false);
  const context = entry?.record.context ?? null;
  const connected = Boolean(context && contextMatches(context, session));
  const contextKey = JSON.stringify(context);
  useEffect(() => {
    useRegistry.getState().setContext(context, entry?.record.datasourceName);
    setPlan({ selectedMetricIds: [] });
    setExpanded(new Set());
    setFollowOpen(false);
    setFollowersOf(null);
    setQuery("");
    setOnlyFollowed(false);
    setVariantsOpen(false);
  }, [contextKey, connected]);
  useEffect(() => {
    if (visible && context && connected)
      void useRegistry.getState().ensureLoaded();
  }, [visible, contextKey, connected]);
  const existing = registry.inventory;
  const [usePreview] = useState(() => createPreviewController());
  const preview = usePreview();
  const previewScope = useMemo(
    () =>
      connected &&
      context &&
      session &&
      existing &&
      !registry.loading &&
      !registry.busy
        ? { context, siteContentUrl: session.siteContentUrl }
        : null,
    [contextKey, connected, session, existing, registry.loading, registry.busy],
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
  const visibleDefinitions = (existing?.definitions ?? [])
    .map((definition) => ({
      ...definition,
      metrics: definition.metrics.filter(
        (metric) =>
          !onlyFollowed ||
          metricIsFollowed(registry.followState, metric.metricId),
      ),
    }))
    .filter(
      (definition) =>
        (!onlyFollowed || definition.metrics.length > 0) &&
        `${definition.name} ${definition.measure}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    );
  const displayedDefinitions = visibleDefinitions;
  const displayedIds = displayedDefinitions.flatMap((definition) =>
    definition.metrics.map((metric) => metric.metricId),
  );
  const registrySelection = selectionState(
    selectedMetricIds,
    displayedIds,
  );
  const selectedSources = plan.selectedMetricIds
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
    }));
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
  if (!entry)
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
          onClick={() => void registry.load()}
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
          {selectedSources.length > 0 && (
            <>
              <button
                className="btn small"
                disabled={Boolean(registry.busy)}
                onClick={() => setFollowOpen(true)}
              >
                Follow / Unfollow
              </button>
              <button
                className="btn small danger"
                disabled={Boolean(registry.busy)}
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
          <button
            className="btn small pulse-registry-create"
            disabled={Boolean(registry.busy) || !allMetrics.length}
            aria-haspopup="dialog"
            onClick={() => setVariantsOpen(true)}
          >
            Create variants
          </button>
        </div>
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
        {Boolean(existing?.failures.length) && (
          <p className="warning-banner" role="status">
            Inventory is partial. {existing!.failures.length} provider{" "}
            {existing!.failures.length === 1 ? "request" : "requests"}
            failed.
          </p>
        )}
        {registry.followState?.errors.length ? (
          <p className="warning-banner" role="status">
            Some follow information is unavailable. Unknown relationships are
            not shown as confirmed zero.
          </p>
        ) : null}
        {registry.loading && !existing && (
          <p role="status">Loading Tableau definitions...</p>
        )}
        {!registry.loading && existing && visibleDefinitions.length === 0 && (
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
            metrics={allMetrics}
            selectedMetricIds={plan.selectedMetricIds}
            busy={Boolean(registry.busy)}
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
                      disabled={Boolean(registry.busy)}
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
          results={registry.results}
          onDismiss={registry.dismissResults}
        />
      )}
      {followOpen && (
        <FollowTargetModal
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
              <button
                className="btn danger"
                disabled={
                  !registry.deletePlan ||
                  registry.deleteLoading ||
                  registry.busy === "delete"
                }
                onClick={() => void registry.executeDelete()}
              >
                <BusyLabel busy={registry.busy === "delete"} idle="Delete reviewed resources" active="Deleting..." />
              </button>
            </>
          }
        >
          {registry.deleteLoading && (
            <p role="status">Checking exact deletion effects in Tableau...</p>
          )}
          {registry.deleteError && (
            <p className="warning-banner" role="alert">
              {registry.deleteError}
            </p>
          )}
          {registry.deletePlan && (
            <>
              <p>
                Delete exactly these reviewed resources from{" "}
                {entry.record.datasourceName}:
              </p>
              <ul>
                {registry.deletePlan.targets.map((target) => (
                  <li key={`${target.kind}-${target.id}`}>
                    <strong>{target.name}</strong> -{" "}
                    {target.kind === "definition"
                      ? `definition and its ${target.affectedMetricIds.length} ${target.affectedMetricIds.length === 1 ? "metric" : "metrics"}; associated subscriptions are removed`
                      : "individual metric"}
                    {!!target.affectedMetrics?.length && (
                      <ul>
                        {target.affectedMetrics.map((metric) => (
                          <li key={metric.id}>
                            {metric.name}
                            <span className="section-hint">
                              {" "}
                              ·{" "}
                              {metric.followerCount === null
                                ? "Followers unavailable"
                                : `${metric.followerCount} ${metric.followerCount === 1 ? "follower" : "followers"}`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
              {registry.deletePlan.warnings.map((warning) => (
                <p className="warning-banner" key={warning}>
                  {warning}
                </p>
              ))}
              <p>
                Changed deletion effects require a new review. This action
                cannot be undone by the app.
              </p>
            </>
          )}
        </Modal>
      )}
    </section>
  );
}
