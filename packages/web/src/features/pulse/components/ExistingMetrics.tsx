import { useEffect, useMemo, useRef, useState } from 'react';
import { TIMEFRAMES } from '@pulse-metric-studio/shared';
import {
  api,
  type DefinitionNode,
  type FollowersDetail,
  type FollowState,
  type MetricVariant,
} from '../../../api/client';
import { useStore } from '../../../store';
import { followStateLabel, metricIsFollowed } from '../follow-state';
import {
  EMPTY_PULSE_FORK_PLAN,
  canonicalPlanPreview,
  dimensionClauseSummary,
  reconcileMetricSelection,
  selectionState,
  setMetricSelection,
  stableJson,
  timeframeScopeFamilyMetricIds,
  timeframeScopeSignature,
  type PulseForkPlanState,
  type PulseRegistryMetric,
} from '../fork-plan';
import {
  forkRegistryActionCounts,
  forkRegistryActionItem,
  mapWithConcurrency,
  registryActionLabel,
  registryActionCounts,
  registryActionOutcome,
  registryTargetHeadline,
  summarizeRegistryTargets,
  type RegistryActionItem,
  type RegistryActionResults,
} from '../registry-actions';
import { pulseDimensionalForkApi } from '../dimensional-fork-api';
import { DimensionalFork } from './DimensionalFork';
import { FollowTargetModal } from './FollowTargetModal';
import { Modal } from './ui';

const TIMEFRAME_GROUPS = [
  { label: 'Current / to date', keys: ['TODAY', 'THIS_WEEK', 'MONTH_TO_DATE', 'QUARTER_TO_DATE', 'YEAR_TO_DATE'] },
  { label: 'Last complete', keys: ['YESTERDAY', 'LAST_WEEK', 'LAST_MONTH', 'LAST_QUARTER', 'LAST_YEAR'] },
  { label: 'Rolling window', keys: ['LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS', 'LAST_60_DAYS', 'LAST_90_DAYS', 'ONE_YEAR_IN_MONTHS'] },
] as const;

export function ExistingMetrics() {
  const selectedDs = useStore((state) => state.selectedDs);
  const session = useStore((state) => state.session);
  const existing = useStore((state) => state.existing);
  const existingLoading = useStore((state) => state.existingLoading);
  const followState = useStore((state) => state.followState);
  const loadExisting = useStore((state) => state.loadExisting);
  const showToast = useStore((state) => state.showToast);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [onlyFollowed, setOnlyFollowed] = useState(false);
  const [plan, setPlan] = useState<PulseForkPlanState>(EMPTY_PULSE_FORK_PLAN);
  const [busyAction, setBusyAction] = useState<'fork' | 'delete' | null>(null);
  const [followOpen, setFollowOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [followersOf, setFollowersOf] = useState<DefinitionNode | null>(null);
  const [lastResults, setLastResults] = useState<RegistryActionResults | null>(null);
  const [highlightedMetricIds, setHighlightedMetricIds] = useState<Set<string>>(new Set());
  const [dimensionCompatibilityKey, setDimensionCompatibilityKey] = useState('');
  const selectedSourceContextKeyRef = useRef('');

  const allMetrics = useMemo(
    () => flattenMetrics(existing?.definitions ?? []),
    [existing],
  );
  const metricById = useMemo(
    () => new Map(allMetrics.map((metric) => [metric.metricId, metric])),
    [allMetrics],
  );
  const definitionById = useMemo(
    () => new Map((existing?.definitions ?? []).map((definition) => [definition.definitionId, definition])),
    [existing],
  );
  const allMetricIds = useMemo(() => allMetrics.map((metric) => metric.metricId), [allMetrics]);
  const inventoryKey = allMetricIds.join('\u0000');

  useEffect(() => {
    setExpanded(new Set());
    setOnlyFollowed(false);
    setPlan(EMPTY_PULSE_FORK_PLAN);
    setLastResults(null);
    setHighlightedMetricIds(new Set());
    setDimensionCompatibilityKey('');
  }, [selectedDs?.luid]);

  useEffect(() => {
    setPlan((current) => ({
      ...current,
      selectedMetricIds: reconcileMetricSelection(current.selectedMetricIds, allMetricIds),
    }));
    const definitionIds = new Set((existing?.definitions ?? []).map((definition) => definition.definitionId));
    setExpanded((current) => new Set([...current].filter((definitionId) => definitionIds.has(definitionId))));
  }, [inventoryKey]);

  const visibleDefinitions = useMemo(() => {
    const definitions = existing?.definitions ?? [];
    if (!onlyFollowed) return definitions;
    if (!followState) return [];
    return definitions
      .map((definition) => ({
        ...definition,
        metrics: definition.metrics.filter((metric) => metricIsFollowed(followState, metric.metricId)),
      }))
      .filter((definition) => definition.metrics.length > 0);
  }, [existing, followState, onlyFollowed]);

  if (!selectedDs) return null;

  const registrySelection = selectionState(plan.selectedMetricIds, allMetricIds);
  const selectedMetrics = plan.selectedMetricIds
    .map((metricId) => metricById.get(metricId))
    .filter((metric): metric is PulseRegistryMetric => Boolean(metric));
  const selectedSources = selectedMetrics.map((metric) => ({
    id: metric.metricId,
    // Never a raw LUID: previewSourceLabel falls back to the definition name
    // when the metric is unnamed (Tableau reports its LUID as the name upstream).
    label: previewSourceLabel(
      metric.name,
      definitionById.get(metric.definitionId)?.name ?? metric.name,
      metric.metricId,
      metric.timeframeLabel ?? '',
    ),
  }));
  const selectedSourceContextKey = selectedSources.map((source) => source.id).join('\u0000');
  selectedSourceContextKeyRef.current = selectedSourceContextKey;
  const deletionPlan = planDeletion(
    selectedMetrics,
    allMetrics,
    (metric) => forkFriendlyName(metric, definitionById.get(metric.definitionId)?.name ?? metric.name, metric.metricId),
    (definitionId) => definitionById.get(definitionId)?.name ?? definitionId,
    (definitionId) => definitionById.get(definitionId)?.inventoryStatus === 'complete',
  );
  const preview = canonicalPlanPreview(allMetrics, plan);
  const hasChanges = Boolean(plan.timeframe || plan.clauses.length > 0);
  const forkDisabledReason = getForkDisabledReason({
    selectedCount: plan.selectedMetricIds.length,
    hasChanges,
    dimensionsUnresolved: plan.clauses.length > 0 && dimensionCompatibilityKey !== selectedSourceContextKey,
    busy: Boolean(busyAction),
  });

  const setTimeframe = (key: string) => {
    if (!key) {
      setPlan((current) => ({ ...current, timeframe: null }));
      return;
    }
    const timeframe = TIMEFRAMES[key];
    if (timeframe) setPlan((current) => ({ ...current, timeframe: { key, label: timeframe.label } }));
  };

  const runFork = async () => {
    if (forkDisabledReason) return;
    setBusyAction('fork');
    try {
      const summary = await pulseDimensionalForkApi.forkPlan({
        version: 1,
        sourceMetricIds: plan.selectedMetricIds,
        ...(plan.timeframe
          ? { timeframe: { key: plan.timeframe.key } }
          : {}),
        clauses: plan.clauses.map((clause) => ({
          fieldId: clause.fieldId,
          selection: { mode: 'VALUES', exclude: clause.exclude, values: clause.values.map((value) => value.value) },
        })),
      });
      const items = summary.results.map((result, index) => {
        const source = metricById.get(result.sourceMetricId);
        const label = source
          ? previewSourceLabel(source.name, definitionById.get(source.definitionId)?.name ?? source.name, source.metricId, source.timeframeLabel ?? '')
          : result.sourceMetricId;
        return forkRegistryActionItem(result, label, index);
      });
      setLastResults({ kind: 'fork', title: 'Fork results', items, finishedAt: Date.now() });
      setHighlightedMetricIds(new Set(summary.results.map((result) => result.metricId).filter((id): id is string => Boolean(id))));
      if (summary.terminated) showToast('warning', 'Fork stopped because the Tableau session ended. Completed and in-flight results are shown; unsent work was not attempted.');
      if (summary.error) showToast(summary.failed === summary.attempted ? 'error' : 'warning', summary.error);
      if (summary.results.some((result) => result.creationStatus === 'created' || result.creationStatus === 'existing' || result.status === 'visible')) {
        await loadExisting();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setLastResults({
        kind: 'fork',
        title: 'Fork results',
        finishedAt: Date.now(),
        items: selectedMetrics.map((metric) => ({
          key: `fork:${metric.metricId}`,
          metricId: metric.metricId,
          metricLabel: previewSourceLabel(
            metric.name,
            definitionById.get(metric.definitionId)?.name ?? metric.name,
            metric.metricId,
            metric.timeframeLabel ?? '',
          ),
          status: 'failed',
          creationStatus: 'unknown',
          detail: `The request did not return a receipt. Inspect Tableau before retrying. ${detail}`,
        })),
      });
      showToast('error', `Fork failed: ${detail}`);
    } finally {
      setBusyAction(null);
    }
  };

  const runDelete = async () => {
    if (plan.selectedMetricIds.length === 0 || busyAction) return;
    setDeleteOpen(false);
    setBusyAction('delete');
    try {
      const items = await deleteSelectedMetrics(deletionPlan, api.deleteEntries);
      setLastResults({ kind: 'delete', title: 'Delete results', items, finishedAt: Date.now() });
      await loadExisting();
    } finally {
      setBusyAction(null);
    }
  };

  const toggleTimeframeFamily = (metric: PulseRegistryMetric) => {
    const signature = timeframeScopeSignature(metric);
    const familyMetricIds = timeframeScopeFamilyMetricIds(allMetrics, signature);
    const familySelection = selectionState(plan.selectedMetricIds, familyMetricIds);
    setPlan((current) => ({
      ...current,
      selectedMetricIds: setMetricSelection(current.selectedMetricIds, familyMetricIds, !familySelection.checked),
    }));
    if (!familySelection.checked) {
      const definitionIds = allMetrics
        .filter((candidate) => familyMetricIds.includes(candidate.metricId))
        .map((candidate) => candidate.definitionId);
      setExpanded((current) => new Set([...current, ...definitionIds]));
    }
  };

  return (
    <div className="panel" id="registry-panel">
      <div className="panel-header">
        <span className="panel-kicker">Registry</span>
        <div className="panel-title">Definitions</div>
        <div className="panel-actions pulse-registry-header-actions">
          {existing && (
            <span className="publish-counts">
              {existing.definitions.length} definitions - {allMetrics.length} metrics
            </span>
          )}
          <button className="btn small" type="button" disabled={existingLoading} onClick={() => void loadExisting()}>
            {existingLoading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>
      <div className="panel-body">
        <div className="pulse-registry-toolbar" aria-label="Registry controls">
          <button
            className="btn small"
            type="button"
            disabled={visibleDefinitions.length === 0}
            onClick={() => {
              const allExpanded = visibleDefinitions.every((definition) => expanded.has(definition.definitionId));
              setExpanded(allExpanded ? new Set() : new Set(visibleDefinitions.map((definition) => definition.definitionId)));
            }}
          >
            {visibleDefinitions.length > 0 && visibleDefinitions.every((definition) => expanded.has(definition.definitionId))
              ? 'Collapse all'
              : 'Expand all'}
          </button>
          <button
            className="btn small"
            type="button"
            disabled={allMetricIds.length === 0}
            onClick={() => setPlan((current) => ({
              ...current,
              selectedMetricIds: setMetricSelection(current.selectedMetricIds, allMetricIds, !registrySelection.checked),
            }))}
          >
            {registrySelection.checked ? 'Deselect all' : 'Select all'}
          </button>
          <label className="pulse-native-checkbox">
            <input type="checkbox" checked={onlyFollowed} onChange={(event) => setOnlyFollowed(event.target.checked)} />
            Only show metrics I follow
          </label>
          <span className="pulse-selected-count" role="status">{plan.selectedMetricIds.length} selected exact metrics</span>
          <div className="pulse-registry-toolbar-spacer" />
          <button
            className="btn small"
            type="button"
            disabled={plan.selectedMetricIds.length === 0 || Boolean(busyAction)}
            onClick={() => setFollowOpen(true)}
          >
            Follow / Unfollow
          </button>
          <button
            className="btn small danger"
            type="button"
            disabled={plan.selectedMetricIds.length === 0 || Boolean(busyAction)}
            onClick={() => setDeleteOpen(true)}
          >
            Delete selected
          </button>
        </div>

        {existing?.failures?.length ? (
          <div className="warning-banner" role="alert">
            Exact metric inventory is partial. {existing.failures.length} provider request{existing.failures.length === 1 ? '' : 's'} failed.
          </div>
        ) : null}
        {onlyFollowed && !followState && (
          <div className="warning-banner" role="alert">Follow state is unavailable, so followed metrics cannot be filtered.</div>
        )}
        {existingLoading && !existing && <div className="empty-note">Scanning site definitions...</div>}
        {!existingLoading && visibleDefinitions.length === 0 && (
          <div className="empty-note">
            {onlyFollowed ? 'No followed metrics are available in this registry.' : 'No existing Pulse definitions exist for this datasource.'}
          </div>
        )}

        <div className="pulse-registry-list">
          {visibleDefinitions.map((definition) => {
            const fullDefinition = definitionById.get(definition.definitionId) ?? definition;
            const childIds = fullDefinition.metrics.map((metric) => metric.metricId);
            const definitionSelection = selectionState(plan.selectedMetricIds, childIds);
            const bodyId = `pulse-definition-${safeDomId(definition.definitionId)}`;
            return (
              <div key={definition.definitionId} className="def-row">
                <div className="def-head pulse-definition-head">
                  <SelectionCheckbox
                    label={`Select all exact metrics in ${cleanName(definition.name)}`}
                    state={definitionSelection}
                    onChange={(checked) => setPlan((current) => ({
                      ...current,
                      selectedMetricIds: setMetricSelection(current.selectedMetricIds, childIds, checked),
                    }))}
                  />
                  <button
                    className="pulse-expand-button"
                    type="button"
                    aria-expanded={expanded.has(definition.definitionId)}
                    aria-controls={bodyId}
                    onClick={() => setExpanded((current) => {
                      const next = new Set(current);
                      if (next.has(definition.definitionId)) next.delete(definition.definitionId);
                      else next.add(definition.definitionId);
                      return next;
                    })}
                  >
                    <span aria-hidden="true">{expanded.has(definition.definitionId) ? '▼' : '▶'}</span>
                    <span className="def-name">{cleanName(definition.name)}</span>
                  </button>
                  <span className="def-meta">
                    {definition.metrics.length} variants - {definition.aggregation.toLowerCase()}({definition.measure}) - {definition.timeDimension}
                    {definition.inventoryStatus && definition.inventoryStatus !== 'complete' ? ` - inventory ${definition.inventoryStatus}` : ''}
                  </span>
                  <div className="pulse-registry-toolbar-spacer" />
                  <FollowerBadges definition={definition} onAudit={() => setFollowersOf(definition)} />
                </div>
                {expanded.has(definition.definitionId) && (
                  <div id={bodyId}>
                    {definition.metrics.map((variant) => (
                      <MetricRow
                        key={variant.metricId}
                        definition={definition}
                        variant={variant}
                        metric={metricById.get(variant.metricId)!}
                        selectedMetricIds={plan.selectedMetricIds}
                        allMetrics={allMetrics}
                        highlighted={highlightedMetricIds.has(variant.metricId)}
                        onSelectionChange={(checked) => setPlan((current) => ({
                          ...current,
                          selectedMetricIds: setMetricSelection(current.selectedMetricIds, [variant.metricId], checked),
                        }))}
                        onToggleTimeframeFamily={toggleTimeframeFamily}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {existing && allMetrics.length > 0 && (
          <section className="pulse-fork-planner" aria-labelledby="pulse-fork-planner-title">
            <div className="subpanel-title" id="pulse-fork-planner-title">Fork plan</div>
            <p className="section-hint">Stage an optional timeframe and zero or more dimension clauses. Tableau receives nothing until you select <strong>Fork</strong>.</p>
            <div className="pulse-timeframe-stage">
              <label>
                <span>Target timeframe</span>
                <select value={plan.timeframe?.key ?? ''} onChange={(event) => setTimeframe(event.target.value)}>
                  <option value="">Keep each source timeframe</option>
                  {TIMEFRAME_GROUPS.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.keys.map((key) => <option key={key} value={key}>{TIMEFRAMES[key]?.label ?? key}</option>)}
                    </optgroup>
                  ))}
                </select>
              </label>
              {plan.timeframe && (
                <button className="btn small" type="button" onClick={() => setTimeframe('')}>Clear timeframe</button>
              )}
            </div>

            <DimensionalFork
              sources={selectedSources}
              clauses={plan.clauses}
              onChange={(clauses) => setPlan((current) => ({ ...current, clauses }))}
              onCompatibilityResolved={(sourceContextKey, eligibleFieldIds) => {
                if (selectedSourceContextKeyRef.current !== sourceContextKey) return;
                setPlan((current) => {
                  const eligible = new Set(eligibleFieldIds);
                  const clauses = current.clauses.filter((clause) => eligible.has(clause.fieldId));
                  return clauses.length === current.clauses.length ? current : { ...current, clauses };
                });
                setDimensionCompatibilityKey(sourceContextKey);
              }}
            />

            <details className="pulse-fork-preview">
              <summary>Preview {preview.length} planned metric{preview.length === 1 ? '' : 's'}</summary>
              {preview.length === 0 ? (
                <div className="empty-note">Select at least one exact source metric.</div>
              ) : (
                <div className="pulse-preview-body">
                  {(plan.timeframe || plan.clauses.length > 0) && (
                    <div className="pulse-preview-changes" aria-label="Requested changes">
                      <span className="pulse-preview-changes-label">Requested changes</span>
                      {plan.timeframe && <span className="pill">{plan.timeframe.label}</span>}
                      {plan.clauses.map((clause) => (
                        <span className="pill" key={clause.fieldId} title={clause.table ? `${clause.fieldLabel} - ${clause.table}` : clause.fieldLabel}>
                          {clause.fieldLabel}: {dimensionClauseSummary(clause)}
                        </span>
                      ))}
                    </div>
                  )}
                  <ol className="pulse-preview-sources">
                    {preview.map((entry) => {
                      const metric = metricById.get(entry.sourceMetricId);
                      const definitionName = definitionById.get(entry.definitionId)?.name ?? entry.sourceName;
                      const timeframeLabel = plan.timeframe?.label ?? metric?.timeframeLabel ?? '';
                      const header = previewSourceLabel(metric?.name, definitionName, entry.sourceMetricId, timeframeLabel);
                      const json = stableJson({
                        sourceMetricId: entry.sourceMetricId,
                        sourceSpecification: entry.sourceSpecification,
                        requestedChanges: entry.requestedChanges,
                      });
                      return (
                        <li key={entry.sourceMetricId}>
                          <span className="pulse-preview-source-name">{header}</span>
                          <details className="pulse-result-specification">
                            <summary>Payload</summary>
                            <pre>{boundedText(json, 2800)}</pre>
                          </details>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              )}
            </details>

            <div className="pulse-final-fork-row">
              <div>
                <strong>{plan.selectedMetricIds.length}</strong> planned output metric{plan.selectedMetricIds.length === 1 ? '' : 's'}
                {forkDisabledReason && <div className="section-hint">{forkDisabledReason}</div>}
              </div>
              <button
                className="btn primary"
                type="button"
                disabled={Boolean(forkDisabledReason)}
                title={forkDisabledReason ?? undefined}
                onClick={() => void runFork()}
              >
                {busyAction === 'fork' ? 'Forking...' : 'Fork'}
              </button>
            </div>
          </section>
        )}

        {lastResults && <RegistryResultsModal results={lastResults} onDismiss={() => setLastResults(null)} />}
      </div>

      {followOpen && (
        <FollowTargetModal
          metrics={selectedSources}
          currentUserId={session?.userId ?? ''}
          currentUserName={session?.userName}
          onClose={() => setFollowOpen(false)}
          onResults={setLastResults}
          onComplete={() => void loadExisting()}
        />
      )}
      {deleteOpen && (
        <DeleteConfirmation
          deletionPlan={deletionPlan}
          followState={followState}
          busy={busyAction === 'delete'}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={() => void runDelete()}
        />
      )}
      {followersOf && (
        <Modal title={`Followers - ${cleanName(followersOf.name)}`} onClose={() => setFollowersOf(null)}>
          <FollowersList definition={followersOf} />
        </Modal>
      )}
    </div>
  );
}

function MetricRow({
  definition,
  variant,
  metric,
  selectedMetricIds,
  allMetrics,
  highlighted,
  onSelectionChange,
  onToggleTimeframeFamily,
}: {
  definition: DefinitionNode;
  variant: MetricVariant;
  metric: PulseRegistryMetric;
  selectedMetricIds: string[];
  allMetrics: PulseRegistryMetric[];
  highlighted: boolean;
  onSelectionChange: (checked: boolean) => void;
  onToggleTimeframeFamily: (metric: PulseRegistryMetric) => void;
}) {
  const followState = useStore((state) => state.followState);
  const signature = timeframeScopeSignature(metric);
  const familyIds = timeframeScopeFamilyMetricIds(allMetrics, signature);
  const familySelection = selectionState(selectedMetricIds, familyIds);
  const userFollow = Boolean(followState?.userFollowsByMetricId[variant.metricId]);
  const groupFollow = Boolean(followState?.groupFollowsByMetricId[variant.metricId]);
  const scoped = variant.isScoped || Boolean(variant.filters?.length);

  return (
    <div className={`variant-row pulse-metric-row ${highlighted ? 'pulse-metric-highlight' : ''}`}>
      <input
        className="metric-source-checkbox"
        type="checkbox"
        aria-label={`Select exact metric ${variant.name || variant.metricId} in ${definition.name}`}
        checked={selectedMetricIds.includes(variant.metricId)}
        onChange={(event) => onSelectionChange(event.target.checked)}
      />
      <span className={`follow-dot ${userFollow ? 'me' : groupFollow ? 'group' : ''}`} aria-hidden="true" />
      <span className="pulse-follow-label">
        {followStateLabel(followState, variant.metricId)}
      </span>
      <button
        className="tf-label pulse-timeframe-button"
        type="button"
        aria-pressed={familySelection.checked}
        title={(() => {
          const scope = scoped ? 'identically filtered ' : 'unfiltered ';
          const verb = familySelection.checked ? 'Clear' : 'Select';
          return `${verb} all ${familyIds.length} ${scope}${variant.timeframeLabel} metric${familyIds.length === 1 ? '' : 's'} across definitions`;
        })()}
        onClick={() => onToggleTimeframeFamily(metric)}
      >
        {variant.timeframeLabel}
      </button>
      {scoped && <span className="pulse-scope-label">Scoped</span>}
      <span className="pulse-metric-name">{variant.name || variant.metricId}</span>
      <CopyIdButton metricId={variant.metricId} />
    </div>
  );
}

function SelectionCheckbox({
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

function FollowerBadges({ definition, onAudit }: { definition: DefinitionNode; onAudit: () => void }) {
  const followState = useStore((state) => state.followState);
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
      Followers: individuals {summary.user}, groups {summary.groups}
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
    return { individuals: 0, groups: 0, individualsUnavailable: true, groupsUnavailable: true };
  }
  const userFollowerIds = new Set<string>();
  const groupFollowerIds = new Set<string>();
  let individualsUnavailable = false;
  let groupsUnavailable = false;
  for (const metricId of metricIds) {
    const userIds = followState.userFollowerIdsByMetricId?.[metricId];
    const groupIds = followState.groupFollowerIdsByMetricId?.[metricId];
    const availability = followState.availabilityByMetricId?.[metricId];
    const relationship = availability?.relationshipStatus ?? availability?.status;
    const relationshipUnavailable = relationship !== undefined && relationship !== 'available';
    if (userIds) for (const id of userIds) userFollowerIds.add(id);
    else if (relationshipUnavailable) individualsUnavailable = true;
    if (groupIds) for (const id of groupIds) groupFollowerIds.add(id);
    else if (relationshipUnavailable) groupsUnavailable = true;
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
  if (!followState) return { user: 'unavailable', groups: 'unavailable' };
  const counts = countDistinctFollowers(metricIds, followState);
  return {
    user: formatRelationshipCount(counts.individuals, counts.individualsUnavailable),
    groups: formatRelationshipCount(counts.groups, counts.groupsUnavailable),
  };
}

function formatRelationshipCount(count: number, unavailable: boolean): string {
  if (!unavailable) return String(count);
  return count > 0 ? `at least ${count}` : 'unavailable';
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
      {copied ? 'Copied' : 'Copy ID'}
    </button>
  );
}

/**
 * Concise, non-alarming headline lines for a results batch. Follow/unfollow are
 * summarized per target ("Group Sales now follows 13 of 13 metrics"); fork and
 * delete get a single roll-up. Already-followed and existing are successes, so
 * an idempotent re-follow never reads as a failure.
 */
export function registryResultHeadlines(results: RegistryActionResults): string[] {
  if (results.kind === 'follow' || results.kind === 'unfollow') {
    return summarizeRegistryTargets(results.items).map((summary) => registryTargetHeadline(results.kind as 'follow' | 'unfollow', summary));
  }
  if (results.kind === 'fork') {
    const forkCounts = forkRegistryActionCounts(results.items);
    const parts = [`${forkCounts.created} created`];
    if (forkCounts.existing > 0) parts.push(`${forkCounts.existing} already existed`);
    if (forkCounts.pendingVisibility > 0) parts.push(`${forkCounts.pendingVisibility} pending visibility`);
    if (forkCounts.ownershipMismatch > 0) parts.push(`${forkCounts.ownershipMismatch} ownership mismatch`);
    if (forkCounts.failed > 0) parts.push(`${forkCounts.failed} failed`);
    if (forkCounts.unknown > 0) parts.push(`${forkCounts.unknown} outcome unknown`);
    if (forkCounts.notAttempted > 0) parts.push(`${forkCounts.notAttempted} not sent`);
    return [`${parts.join(', ')}.`];
  }
  const counts = registryActionCounts(results.items);
  const parts: string[] = [];
  if (counts.removed > 0) parts.push(`${counts.removed} removed`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return [`${parts.length > 0 ? parts.join(', ') : 'Nothing removed'}.`];
}

function RegistryResultsModal({ results, onDismiss }: { results: RegistryActionResults; onDismiss: () => void }) {
  const outcome = registryActionOutcome(results.items);
  const headlines = registryResultHeadlines(results);
  return (
    <Modal
      title={results.title}
      outcome={outcome}
      onClose={onDismiss}
      actions={<button className="btn primary" type="button" onClick={onDismiss}>Done</button>}
    >
      <div className="pulse-results-headline" role="status">
        {headlines.map((headline, index) => (
          <div key={index} className={outcome === 'fail' ? 'err' : ''}>{headline}</div>
        ))}
      </div>
      <details className="pulse-results-detail">
        <summary>Per-metric detail ({results.items.length})</summary>
        <ul className="result-list">
          {results.items.map((item) => (
            <li key={item.key} className={item.status === 'failed' ? 'err' : ''}>
              <strong>{item.metricLabel}</strong>
              {item.targetLabel ? ` - ${item.targetLabel}` : ''}: {registryActionLabel(results.kind, item)}
              {item.detail ? ` - ${item.detail}` : ''}
              {item.resultMetricId && <div className="section-hint">Metric: {item.resultMetricId}</div>}
              {results.kind === 'fork' && item.requestedSpecification !== undefined && (
                <details className="pulse-result-specification">
                  <summary>Requested specification</summary>
                  <pre>{boundedText(stableJson(item.requestedSpecification), 2800)}</pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      </details>
    </Modal>
  );
}

export interface DeletionMetricEntry {
  metricId: string;
  friendlyName: string;
}

/**
 * A definition that must be deleted whole because the user selected its default
 * metric (Tableau will not delete a default metric on its own). Deleting the
 * definition cascades to every metric under it, so we carry the full list to
 * make the blast radius honest.
 */
export interface DeletionDefinitionCascade {
  inventoryComplete: boolean;
  definitionId: string;
  definitionName: string;
  /** All metric ids under this definition - every one is removed by the cascade. */
  metricIds: string[];
  /** Friendly names of every metric the cascade removes, for the warning. */
  removedMetricNames: string[];
}

export interface DeletionPlan {
  /** Non-default metrics that can be deleted individually. */
  individualMetrics: DeletionMetricEntry[];
  /** Definitions removed whole because a default metric was selected. */
  definitionCascades: DeletionDefinitionCascade[];
  /** Union of every metric id that will actually be removed (for blast radius). */
  removedMetricIds: string[];
}

/**
 * A definition's default metric cannot be deleted on its own (Tableau returns a
 * 400) - only deleting the whole definition removes it. Treat a metric as the
 * default when the inventory flags it as such by state or the explicit flag.
 */
export function isDefaultMetric(metric: Pick<PulseRegistryMetric, 'isDefault' | 'scopedState'>): boolean {
  return metric.scopedState === 'default' || metric.isDefault === true;
}

/**
 * Split the current selection into individual metric deletes and definition
 * cascades. A definition cascade is triggered ONLY when its default metric is
 * explicitly selected - selecting a fork never drags in its definition. Any
 * non-default metric whose definition is being cascaded is folded into that
 * cascade instead of being deleted twice.
 */
export function planDeletion(
  selectedMetrics: PulseRegistryMetric[],
  allMetrics: PulseRegistryMetric[],
  friendlyNameOf: (metric: PulseRegistryMetric) => string,
  definitionNameOf: (definitionId: string) => string,
  inventoryComplete: (definitionId: string) => boolean = () => false,
): DeletionPlan {
  const cascadeDefinitionIds = new Set(
    selectedMetrics.filter(isDefaultMetric).map((metric) => metric.definitionId),
  );
  const definitionCascades: DeletionDefinitionCascade[] = [...cascadeDefinitionIds].map((definitionId) => {
    const metricsUnder = allMetrics.filter((metric) => metric.definitionId === definitionId);
    return {
      definitionId,
      definitionName: definitionNameOf(definitionId),
      inventoryComplete: inventoryComplete(definitionId),
      metricIds: metricsUnder.map((metric) => metric.metricId),
      removedMetricNames: metricsUnder.map((metric) => friendlyNameOf(metric)),
    };
  });
  const individualMetrics: DeletionMetricEntry[] = selectedMetrics
    .filter((metric) => !isDefaultMetric(metric) && !cascadeDefinitionIds.has(metric.definitionId))
    .map((metric) => ({ metricId: metric.metricId, friendlyName: friendlyNameOf(metric) }));
  const removedMetricIds = [...new Set([
    ...definitionCascades.flatMap((cascade) => cascade.metricIds),
    ...individualMetrics.map((entry) => entry.metricId),
  ])];
  return { individualMetrics, definitionCascades, removedMetricIds };
}

function deletionActionLabel(plan: DeletionPlan): string {
  const parts: string[] = [];
  if (plan.individualMetrics.length > 0) {
    parts.push(`${plan.individualMetrics.length} metric${plan.individualMetrics.length === 1 ? '' : 's'}`);
  }
  if (plan.definitionCascades.length > 0) {
    parts.push(`${plan.definitionCascades.length} definition${plan.definitionCascades.length === 1 ? '' : 's'}`);
  }
  return parts.length > 0 ? `Delete ${parts.join(' + ')}` : 'Delete selected';
}

function DeleteConfirmation({
  deletionPlan,
  followState,
  busy,
  onCancel,
  onConfirm,
}: {
  deletionPlan: DeletionPlan;
  followState: ReturnType<typeof useStore.getState>['followState'];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Blast radius over EVERY metric that will actually be removed (individual
  // deletes plus every metric swept up by a definition cascade), deduped and
  // taken from the same subscription data the followers modal uses.
  const radius = deletionBlastRadius(countDistinctFollowers(deletionPlan.removedMetricIds, followState));
  const hasCascade = deletionPlan.definitionCascades.length > 0;
  const incomplete = deletionPlan.definitionCascades.some((cascade) => !cascade.inventoryComplete);
  const nothingSelected = deletionPlan.individualMetrics.length === 0 && !hasCascade;
  return (
    <Modal
      title="Delete selected metrics?"
      onClose={busy ? undefined : onCancel}
      actions={(
        <>
          <button className="btn" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
          <button className="btn danger" type="button" disabled={busy || nothingSelected || incomplete} onClick={onConfirm}>
            {busy ? 'Deleting...' : deletionActionLabel(deletionPlan)}
          </button>
        </>
      )}
    >
      <p>This permanently removes the following from Tableau Pulse. The app reports every result separately.</p>
      {deletionPlan.individualMetrics.length > 0 && (
        <ul className="result-list pulse-delete-list">
          {deletionPlan.individualMetrics.map((entry) => (
            <li key={entry.metricId}>{cleanName(entry.friendlyName)}</li>
          ))}
        </ul>
      )}
      {deletionPlan.definitionCascades.map((cascade) => (
        <div key={cascade.definitionId} className="pulse-delete-cascade section-hint warn" role="alert">
          {cascade.inventoryComplete ? <><strong>{cleanName(cascade.definitionName)}</strong> is being removed by its default metric, so the whole
          definition and its {cascade.metricIds.length} metric{cascade.metricIds.length === 1 ? '' : 's'} will be deleted:</> :
            <><strong>Inventory incomplete: {cleanName(cascade.definitionName)}</strong>. Deletion is blocked because additional metrics and follower reach are unknown. Cancel and refresh the registry before deleting this definition, or select only a known non-default metric. Known metrics:</>}
          <ul className="result-list pulse-delete-list">
            {cascade.removedMetricNames.map((name, index) => (
              <li key={`${cascade.definitionId}-${index}`}>{cleanName(name)}</li>
            ))}
          </ul>
        </div>
      ))}
      <div className="pulse-delete-blast-radius" role="status">
        <strong>Blast radius:</strong> {incomplete ? 'Unknown until a complete definition inventory is loaded.' : radius.summary}
        {!incomplete && radius.note && <div className="section-hint warn">{radius.note}</div>}
      </div>
    </Modal>
  );
}

/**
 * Human-readable blast-radius summary for the delete modal. Always shows the
 * distinct individual/group totals we have; when some follower data is
 * unavailable it appends a concise note instead of hiding the totals. Only when
 * NOTHING is known does it drop to a plain "unavailable" line, so a confident
 * but wrong "0 individuals and 0 groups" is never shown.
 */
export function deletionBlastRadius(
  counts: DistinctFollowerCounts,
): { summary: string; note: string | null } {
  const fullyUnavailable = counts.individuals === 0
    && counts.groups === 0
    && counts.individualsUnavailable
    && counts.groupsUnavailable;
  if (fullyUnavailable) {
    return { summary: 'Follower reach is unavailable for the selected metrics.', note: null };
  }
  const summary = `${counts.individuals} individual${counts.individuals === 1 ? '' : 's'} and ${counts.groups} group${counts.groups === 1 ? '' : 's'} follow the selected metrics.`;
  const note = counts.individualsUnavailable || counts.groupsUnavailable
    ? 'Some follower data is unavailable, so the true reach may be higher.'
    : null;
  return { summary, note };
}

type DeleteEntriesFn = (
  entries: Array<{ definitionId?: string; metricIds: string[]; name?: string }>,
) => Promise<{ definitionsDeleted: number; metricsDeleted: number; failures: string[] }>;

/**
 * Execute a delete plan: definition cascades (default metric selected -> delete
 * the whole definition) and individual metric deletes, each mapped to a registry
 * action item. Extracted from the component so the delete flow - payload shape,
 * per-entry success/failure, thrown errors - is unit-testable without a live
 * Tableau session.
 */
export async function deleteSelectedMetrics(
  plan: DeletionPlan,
  deleteEntries: DeleteEntriesFn,
): Promise<RegistryActionItem[]> {
  if (plan.definitionCascades.some((cascade) => !cascade.inventoryComplete)) {
    return [{ key: 'delete-incomplete', metricId: '', metricLabel: 'Selected definitions', status: 'failed', detail: 'Inventory incomplete. Refresh the registry before deleting a whole definition.' }];
  }
  const cascadeItems = await mapWithConcurrency(plan.definitionCascades, 5, async (cascade): Promise<RegistryActionItem> => {
    const label = `${cascade.definitionName} (definition + ${cascade.metricIds.length} metric${cascade.metricIds.length === 1 ? '' : 's'})`;
    try {
      const response = await deleteEntries([{ definitionId: cascade.definitionId, metricIds: cascade.metricIds, name: cascade.definitionName }]);
      const removed = response.definitionsDeleted === 1 && response.failures.length === 0;
      return {
        key: `delete-definition:${cascade.definitionId}`,
        metricId: cascade.definitionId,
        metricLabel: label,
        status: removed ? 'removed' : 'failed',
        ...(!removed ? { detail: response.failures.join('; ') || 'The definition was not deleted.' } : {}),
      };
    } catch (error) {
      return {
        key: `delete-definition:${cascade.definitionId}`,
        metricId: cascade.definitionId,
        metricLabel: label,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const metricItems = await mapWithConcurrency(plan.individualMetrics, 5, async (metric): Promise<RegistryActionItem> => {
    try {
      const response = await deleteEntries([{ metricIds: [metric.metricId], name: metric.friendlyName }]);
      const removed = response.metricsDeleted === 1 && response.failures.length === 0;
      return {
        key: `delete:${metric.metricId}`,
        metricId: metric.metricId,
        metricLabel: metric.friendlyName,
        status: removed ? 'removed' : 'failed',
        ...(!removed ? { detail: response.failures.join('; ') || 'The metric was not deleted.' } : {}),
      };
    } catch (error) {
      return {
        key: `delete:${metric.metricId}`,
        metricId: metric.metricId,
        metricLabel: metric.friendlyName,
        status: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  });
  return [...cascadeItems, ...metricItems];
}

function FollowersList({ definition }: { definition: DefinitionNode }) {
  const [details, setDetails] = useState<Awaited<ReturnType<typeof api.followersDetail>>['details'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const variantById = useMemo(
    () => new Map(definition.metrics.map((metric) => [metric.metricId, metric])),
    [definition],
  );
  useEffect(() => {
    let cancelled = false;
    setDetails(null);
    setError(null);
    void api.followersDetail(definition.metrics.map((metric) => metric.metricId))
      .then((response) => {
        if (!cancelled) setDetails(response.details);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
    return () => { cancelled = true; };
  }, [definition]);

  if (error) return <div className="dimension-fork-error" role="alert">Followers are unavailable: {error}</div>;
  if (!details) return <div className="empty-note" role="status">Loading followers...</div>;
  return (
    <ul className="result-list pulse-followers-list">
      {details.map((detail) => {
        const friendlyName = forkFriendlyName(variantById.get(detail.metricId), definition.name, detail.metricId);
        const lines = followerDetailLines(detail);
        return (
          <li key={detail.metricId} className="pulse-follower-metric">
            <div className="pulse-follower-metric-head">
              <strong>{cleanName(friendlyName)}</strong>
              <CopyLuidButton luid={detail.metricId} />
            </div>
            <ul className="result-list pulse-follower-lines">
              {lines.map((line) => (
                <li key={line.key} className={line.error ? 'err' : undefined}>{line.text}</li>
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
      {copied ? 'Copied' : 'Copy LUID'}
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
export function followerDetailLines(detail: FollowersDetail): FollowerDetailItem[] {
  const items: FollowerDetailItem[] = detail.followers.map((follower, index) => ({
    key: `${detail.metricId}-${follower.id}-${index}`,
    text: `${follower.type === 'GROUP' ? 'Group' : follower.type === 'USER' ? 'User' : 'Unknown'} - ${follower.name || follower.id}`,
    error: false,
  }));
  const diagnostics = [
    ...detail.errors,
    ...(detail.diagnostics ?? []).map((diagnostic) => diagnostic.message),
  ].filter((message, index, all) => message && all.indexOf(message) === index);
  const incomplete = detail.status === 'partial' || detail.status === 'unavailable' || diagnostics.length > 0;

  if (incomplete) {
    const availability = detail.status === 'partial' || detail.followers.length > 0 ? 'partial' : 'unavailable';
    items.push({
      key: `${detail.metricId}-diagnostic`,
      text: `Follower details are ${availability}${diagnostics.length > 0 ? ` - ${diagnostics.join('; ')}` : ''}`,
      error: true,
    });
  } else if (detail.followers.length === 0) {
    items.push({ key: `${detail.metricId}-empty`, text: 'No followers yet', error: false });
  }

  return items;
}

/**
 * Friendly label for a metric (default or fork) shown in the followers modal.
 * A fork is a derived metric produced by a dimensional filter (and/or a distinct
 * timeframe) on a source metric, so the scheme is:
 *   - dimensional fork:  "<source name> - <field>: <values>"  (e.g. "Average Win Rate - Region: West")
 *   - timeframe variant: "<source name> - <timeframe label>"
 *   - otherwise:         "<source name> - <short LUID>"
 * A bare LUID is never the only label.
 */
export function forkFriendlyName(
  variant: { name?: string; timeframeLabel?: string; filters?: unknown[] } | undefined,
  definitionName: string,
  metricId: string,
): string {
  // Unnamed metrics fall back to their LUID as `name` upstream, so a name that
  // is just the metric id is not a real name - lead with the definition name
  // instead, never the raw LUID.
  const rawName = variant?.name?.trim();
  const base = ((rawName && rawName !== metricId ? rawName : definitionName) || 'Metric').trim();
  const summary = dimensionalFilterSummary(variant?.filters ?? []);
  if (summary) return `${base} - ${summary}`;
  const timeframe = variant?.timeframeLabel?.trim();
  if (timeframe) return `${base} - ${timeframe}`;
  return `${base} - ${shortLuid(metricId)}`;
}

function dimensionalFilterSummary(filters: unknown[]): string {
  return filters
    .map((filter) => {
      if (!filter || typeof filter !== 'object') return '';
      const record = filter as Record<string, unknown>;
      const field = typeof record.field === 'string' ? record.field.trim() : '';
      if (!field) return '';
      const values = Array.isArray(record.categorical_values)
        ? record.categorical_values
            .map((value) => (value && typeof value === 'object'
              ? String((value as Record<string, unknown>).string_value ?? '').trim()
              : ''))
            .filter(Boolean)
        : [];
      return values.length > 0 ? `${field}: ${values.join(', ')}` : field;
    })
    .filter(Boolean)
    .join('; ');
}

function shortLuid(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 8 ? trimmed.slice(0, 8) : trimmed;
}

function flattenMetrics(definitions: DefinitionNode[]): PulseRegistryMetric[] {
  return definitions.flatMap((definition) => definition.metrics.map((metric) => ({
    metricId: metric.metricId,
    definitionId: definition.definitionId,
    name: metric.name || definition.name,
    timeframeLabel: metric.timeframeLabel,
    measurementPeriod: metric.measurementPeriod,
    ...(metric.filters ? { filters: metric.filters } : {}),
    ...(metric.comparison !== undefined ? { comparison: metric.comparison } : {}),
    ...(metric.specification ? { specification: metric.specification } : {}),
    ...(metric.isDefault !== undefined ? { isDefault: metric.isDefault } : {}),
    ...(metric.scopedState !== undefined ? { scopedState: metric.scopedState } : {}),
  })));
}

function getForkDisabledReason(input: {
  selectedCount: number;
  hasChanges: boolean;
  dimensionsUnresolved: boolean;
  busy: boolean;
}): string | null {
  if (input.busy) return 'A registry action is in progress.';
  if (input.selectedCount === 0) return 'Select at least one exact source metric.';
  if (!input.hasChanges) return 'Stage a target timeframe or at least one dimension clause.';
  if (input.dimensionsUnresolved) return 'Wait for dimension compatibility to finish.';
  return null;
}

function cleanName(name: string): string {
  return name.replace(/calculation_[a-z0-9]+/gi, '(calc)');
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
  const rawName = name?.trim();
  const base = cleanName(((rawName && rawName !== metricId ? rawName : definitionName) || 'Metric').trim());
  const timeframe = timeframeLabel.trim();
  return timeframe ? `${base} - ${timeframe}` : base;
}

function safeDomId(value: string): string {
  return value.replace(/[^a-z0-9_-]/gi, '_');
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}
