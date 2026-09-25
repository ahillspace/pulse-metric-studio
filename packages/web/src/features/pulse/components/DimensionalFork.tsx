import { useEffect, useMemo, useRef, useState } from 'react';
import { pulseDimensionalForkApi } from '../dimensional-fork-api';
import { createRequestSequencer } from '../dimensional-fork-requests';
import {
  applyDomainToggle,
  chooseValueMode,
  domainToggleState,
  filterDimensionValues,
  mergeDimensionValues,
  selectedProviderValues,
  uniqueDimensionValues,
  type DimensionValueMode,
  type PulseDimensionValue,
  type PulseFilterDimensionField,
} from '../dimensional-filter';
import {
  dimensionClauseSummary,
  removeDimensionClause,
  upsertDimensionClause,
  type StagedDimensionClause,
} from '../fork-plan';

interface SourceMetric {
  id: string;
  label: string;
}

interface DimensionalForkProps {
  sources: SourceMetric[];
  clauses: StagedDimensionClause[];
  onChange: (clauses: StagedDimensionClause[]) => void;
  onCompatibilityResolved: (sourceContextKey: string, eligibleFieldIds: string[]) => void;
}

// Above this many rendered rows, switch from the multi-column grid to a
// virtualized single-column list. The auto fetch-all threshold is 1250 members,
// so every normal dimension keeps the grid; only a "Load all" of a very large
// domain (up to DIMENSION_VALUE_FETCH_CEILING) crosses over and gets windowed,
// which keeps the picker responsive no matter how many members are loaded.
const VALUE_GRID_MAX = 1500;

export function DimensionalFork({ sources, clauses, onChange, onCompatibilityResolved }: DimensionalForkProps) {
  const sourceMetricIds = useMemo(() => sources.map((source) => source.id), [sources]);
  const sourceContextKey = sourceMetricIds.join(' ');
  const [fields, setFields] = useState<PulseFilterDimensionField[]>([]);
  const [fieldId, setFieldId] = useState('');
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [valueMode, setValueMode] = useState<DimensionValueMode | null>(null);
  // The full domain (fetch-all mode) or the current server match set (search).
  const [domain, setDomain] = useState<PulseDimensionValue[]>([]);
  const [matches, setMatches] = useState<PulseDimensionValue[]>([]);
  const [knownValues, setKnownValues] = useState<PulseDimensionValue[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // Include (OPERATOR_EQUAL) vs exclude (OPERATOR_NOT_EQUAL) for the active clause.
  const [exclude, setExclude] = useState(false);
  const [search, setSearch] = useState('');
  const [valuesLoading, setValuesLoading] = useState(false);
  const [allLoading, setAllLoading] = useState(false);
  const [valuesError, setValuesError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const fieldsSeqRef = useRef(createRequestSequencer());
  const valuesSeqRef = useRef(createRequestSequencer());
  const searchSeqRef = useRef(createRequestSequencer());
  // True while a search fetch owns `valuesLoading`. Lets the clear-search path
  // release the spinner a superseded search left on, without clobbering the
  // count/fetch-all load (which owns the same flag on a field/source switch).
  const searchLoadingRef = useRef(false);
  // Tracks the source context the count effect last ran under, so it can skip
  // the stale (oldField, newSources) pair produced on a source switch.
  const countSourceKeyRef = useRef(sourceContextKey);

  useEffect(() => {
    setFieldsLoading(false);
    setFieldId('');
    setFields([]);
    setFieldsError(null);
    resetValues();
    // Invalidate any prior in-flight fields request even when we early-return
    // (e.g. selection cleared), so its late response cannot repopulate state.
    const token = fieldsSeqRef.current.next();
    if (sourceMetricIds.length === 0) return;

    setFieldsLoading(true);
    void pulseDimensionalForkApi.fields(sourceMetricIds)
      .then((response) => {
        if (!fieldsSeqRef.current.isLatest(token)) return;
        setFields(response.fields);
        onCompatibilityResolved(sourceContextKey, response.fields.map((field) => field.id));
      })
      .catch((error) => {
        if (fieldsSeqRef.current.isLatest(token)) setFieldsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (fieldsSeqRef.current.isLatest(token)) setFieldsLoading(false);
      });
  }, [sourceContextKey]);

  // Field select: count the distinct members first, then either fetch the whole
  // domain (small) or wait for the user to search (large). One monotonic token
  // gates both the count and the fetch-all query so a superseded field switch
  // can never repopulate state.
  useEffect(() => {
    const sourceChanged = countSourceKeyRef.current !== sourceContextKey;
    countSourceKeyRef.current = sourceContextKey;
    resetValues();
    const token = valuesSeqRef.current.next();
    // Any pending search from a prior field is now stale.
    searchSeqRef.current.next();
    if (!fieldId || sourceMetricIds.length === 0) return;
    // On a source switch the fields effect resets fieldId to '' in the same
    // commit, but this effect still sees the stale fieldId. Skip that doomed
    // count(newSources, oldFieldId) pair (the server would 422 it); the
    // fieldId='' reset re-runs this effect clean.
    if (sourceChanged) return;

    const existingClause = clauses.find((clause) => clause.fieldId === fieldId);
    const stagedValues = existingClause?.values ?? [];
    setValuesLoading(true);
    void (async () => {
      try {
        const { count } = await pulseDimensionalForkApi.count(sourceMetricIds, fieldId);
        if (!valuesSeqRef.current.isLatest(token)) return;
        const mode = chooseValueMode(count);
        setMemberCount(count);
        setValueMode(mode);
        setKnownValues(uniqueDimensionValues(stagedValues));
        setSelectedKeys(new Set(stagedValues.map((entry) => entry.key)));
        setExclude(existingClause?.exclude ?? false);

        if (mode !== 'fetch-all') return;
        const page = await pulseDimensionalForkApi.values(sourceMetricIds, fieldId, '');
        if (!valuesSeqRef.current.isLatest(token)) return;
        const values = uniqueDimensionValues(page.values);
        setDomain(values);
        setKnownValues(mergeDimensionValues(values, stagedValues));
        setTruncated(page.truncated);
      } catch (error) {
        if (valuesSeqRef.current.isLatest(token)) setValuesError(error instanceof Error ? error.message : String(error));
      } finally {
        if (valuesSeqRef.current.isLatest(token)) setValuesLoading(false);
      }
    })();
  }, [fieldId, sourceContextKey]);

  // Search-required mode: query the provider for substring matches as the user
  // types. Fetch-all mode filters the already-loaded domain client-side, so it
  // never enters this effect.
  useEffect(() => {
    const token = searchSeqRef.current.next();
    if (valueMode !== 'search-required') return;
    if (!search.trim()) {
      setMatches([]);
      setTruncated(false);
      // Release a spinner left on by a search fetch this run supersedes; the
      // superseded fetch's gated .finally will not fire. Guard on the ref so we
      // never turn off the count/fetch-all load that owns the flag.
      if (searchLoadingRef.current) {
        searchLoadingRef.current = false;
        setValuesLoading(false);
      }
      return;
    }
    // Own the spinner synchronously, before the debounce elapses, so the empty
    // state ("No matching values.") cannot flash during the 250ms wait before
    // the query even fires.
    searchLoadingRef.current = true;
    setValuesLoading(true);
    setValuesError(null);
    const timer = window.setTimeout(() => {
      void pulseDimensionalForkApi.values(sourceMetricIds, fieldId, search.trim())
        .then((page) => {
          if (!searchSeqRef.current.isLatest(token)) return;
          const values = uniqueDimensionValues(page.values);
          setMatches(values);
          setKnownValues((current) => mergeDimensionValues(current, values));
          setTruncated(page.truncated);
        })
        .catch((error) => {
          if (searchSeqRef.current.isLatest(token)) setValuesError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (searchSeqRef.current.isLatest(token)) {
            searchLoadingRef.current = false;
            setValuesLoading(false);
          }
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
    };
  }, [valueMode, fieldId, search, sourceContextKey]);

  const searchRequired = valueMode === 'search-required';
  // Values shown as checkboxes: client-filtered domain in fetch-all mode, the
  // server match set in search-required mode.
  const visibleValues = searchRequired ? matches : filterDimensionValues(domain, search);
  // Values the Select-all toggle acts on: the whole domain in fetch-all mode so
  // it ignores the client filter; the current match set in search-required.
  const toggleValues = searchRequired ? matches : domain;
  const toggleState = domainToggleState(toggleValues, selectedKeys, {
    mode: valueMode ?? 'fetch-all',
    truncated,
  });
  const selectedValues = selectedProviderValues(knownValues, selectedKeys);
  const selectedField = fields.find((field) => field.id === fieldId);
  const stageDisabledReason = getStageDisabledReason({
    sourceCount: sourceMetricIds.length,
    fieldsLoading,
    valuesLoading: valuesLoading || allLoading,
    fieldId,
    selectedCount: selectedValues.length,
  });

  const toggleValue = (key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const stageClause = () => {
    if (stageDisabledReason || !selectedField) return;
    const selected = new Set(selectedKeys);
    const values = knownValues.filter((entry) => selected.has(entry.key));
    onChange(upsertDimensionClause(clauses, {
      fieldId: selectedField.id,
      fieldLabel: selectedField.label,
      ...(selectedField.table ? { table: selectedField.table } : {}),
      exclude,
      ...(memberCount !== null ? { memberTotal: memberCount } : {}),
      values,
    }));
    // Return the picker to "Select a field" so the next clause starts clean.
    // Clearing fieldId re-runs the field effect, which resets values/mode/exclude.
    setFieldId('');
  };

  // Load the whole domain on demand for a large (search-required) dimension.
  // Fetches every value in one query, then behaves like fetch-all mode so the
  // client filter and Select all act over the complete domain - there is no cap
  // on how many the user can then select.
  const loadAllValues = () => {
    if (!fieldId || allLoading) return;
    const token = valuesSeqRef.current.next();
    // Any pending search is now stale.
    searchSeqRef.current.next();
    searchLoadingRef.current = false;
    setAllLoading(true);
    setValuesError(null);
    void pulseDimensionalForkApi.values(sourceMetricIds, fieldId, '', { all: true })
      .then((page) => {
        if (!valuesSeqRef.current.isLatest(token)) return;
        const values = uniqueDimensionValues(page.values);
        setDomain(values);
        setKnownValues((current) => mergeDimensionValues(current, values));
        setMatches([]);
        setSearch('');
        setTruncated(page.truncated);
        setValueMode('fetch-all');
      })
      .catch((error) => {
        if (valuesSeqRef.current.isLatest(token)) setValuesError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (valuesSeqRef.current.isLatest(token)) setAllLoading(false);
      });
  };

  function resetValues() {
    searchLoadingRef.current = false;
    setAllLoading(false);
    setMemberCount(null);
    setValueMode(null);
    setDomain([]);
    setMatches([]);
    setKnownValues([]);
    setSelectedKeys(new Set());
    setExclude(false);
    setSearch('');
    setValuesLoading(false);
    setValuesError(null);
    setTruncated(false);
  }

  const searchPlaceholder = searchRequired ? 'Type to search values' : 'Filter loaded values';
  const showEmpty = !valuesLoading && !valuesError && visibleValues.length === 0
    && (!searchRequired || Boolean(search.trim()));

  return (
    <section className="dimension-fork" aria-labelledby="dimension-fork-title">
      <div className="subpanel-title" id="dimension-fork-title">Dimension clauses</div>
      <p className="section-hint">Stage zero or more filters. Values within a clause use OR. Separate clauses use AND.</p>

      <div className="dimension-fork-source-summary">
        <span>{sources.length} exact source metric{sources.length === 1 ? '' : 's'} selected</span>
        {sources.length > 0 && (
          <span className="mono" title={sources.map((source) => source.label).join(', ')}>
            {sources.map((source) => source.label).join(', ')}
          </span>
        )}
      </div>
      {clauses.length > 0 && (
        <div className="pulse-clause-list" aria-label="Staged dimension clauses">
          {clauses.map((clause) => (
            <div className="pulse-clause" key={clause.fieldId} title={clause.table ? `${clause.fieldLabel} - ${clause.table}` : clause.fieldLabel}>
              <span>
                <strong>{clause.fieldLabel}</strong>: {dimensionClauseSummary(clause)}
              </span>
              <button
                className="btn small"
                type="button"
                aria-label={`Remove ${clause.fieldLabel} clause`}
                onClick={() => onChange(removeDimensionClause(clauses, clause.fieldId))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="dimension-fork-controls">
        <label>
          <span>Dimension field</span>
          <select
            aria-label="Dimension field"
            value={fieldId}
            disabled={sourceMetricIds.length === 0 || fieldsLoading || Boolean(fieldsError)}
            onChange={(event) => setFieldId(event.target.value)}
          >
            <option value="">{fieldsLoading ? 'Loading fields...' : 'Select a field'}</option>
            {fields.map((field) => (
              <option key={field.id} value={field.id}>{field.table ? `${field.label} - ${field.table}` : field.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Search values</span>
          <input
            type="search"
            aria-label="Search dimension values"
            placeholder={searchPlaceholder}
            value={search}
            disabled={!fieldId || valueMode === null}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>

      {sourceMetricIds.length === 0 && <p className="section-hint">Select exact source metrics from the registry.</p>}
      {fieldsError && <div className="dimension-fork-error" role="alert">Fields could not load: {fieldsError}</div>}
      {!fieldsLoading && sourceMetricIds.length > 0 && !fieldsError && fields.length === 0 && (
        <p className="section-hint">The selected source context has no eligible string dimensions.</p>
      )}
      {fieldId && (
        <div className="dimension-value-picker">
          <div className="dimension-value-mode" role="radiogroup" aria-label="Filter mode">
            <label className="dimension-value-mode-option">
              <input
                type="radio"
                name="dimension-filter-mode"
                checked={!exclude}
                onChange={() => setExclude(false)}
              />
              <span>Include selected</span>
            </label>
            <label className="dimension-value-mode-option">
              <input
                type="radio"
                name="dimension-filter-mode"
                checked={exclude}
                onChange={() => setExclude(true)}
              />
              <span>Exclude selected</span>
            </label>
          </div>
          <p className="section-hint">
            {exclude
              ? 'Excluded values are removed; every other member (including any added later) stays in the metric.'
              : 'Only the selected values are kept. Members added to the datasource later are not included.'}
          </p>
          <div className="dimension-value-toolbar">
            <button
              className="btn small"
              type="button"
              disabled={toggleState.disabled}
              title={toggleState.reason}
              onClick={() => setSelectedKeys((current) => applyDomainToggle(toggleState, toggleValues, current))}
            >
              {toggleState.action === 'deselect'
                ? 'Deselect all'
                : searchRequired ? 'Select all matches' : 'Select all'}
            </button>
            {toggleState.action !== 'deselect' && selectedKeys.size > 0 && (
              <button className="btn small" type="button" onClick={() => setSelectedKeys(new Set())}>Deselect all</button>
            )}
            <span className="dimension-value-count">{selectedKeys.size} selected</span>
            {memberCount !== null && (
              <span className="dimension-value-count" title="Total distinct members in this dimension">
                Total members: {memberCount.toLocaleString()}
              </span>
            )}
            {valuesLoading && <span className="dimension-value-state" role="status">Loading values...</span>}
          </div>
          {searchRequired && !search.trim() && !valuesLoading && memberCount !== null && (
            <div className="dimension-load-all">
              <p className="section-hint">
                This dimension has {memberCount.toLocaleString()} members - type to search, or load them all.
              </p>
              <button
                className="btn small"
                type="button"
                disabled={allLoading}
                onClick={loadAllValues}
              >
                {allLoading ? `Loading all ${memberCount.toLocaleString()}...` : `Load all ${memberCount.toLocaleString()} values`}
              </button>
            </div>
          )}
          {searchRequired && truncated && (
            <p className="section-hint warn">Showing the first {matches.length} matches. Refine your search to narrow the results.</p>
          )}
          {!valuesLoading && toggleState.reason && <p className="section-hint warn">{toggleState.reason}</p>}
          {valuesError && <div className="dimension-fork-error" role="alert">Values could not load: {valuesError}</div>}
          {showEmpty && (
            <div className="empty-note">{search.trim() ? 'No matching values.' : 'No selectable values.'}</div>
          )}
          {visibleValues.length > 0 && (
            visibleValues.length > VALUE_GRID_MAX ? (
              <VirtualizedValueList
                key={`${fieldId}:${visibleValues.length}`}
                items={visibleValues}
                selectedKeys={selectedKeys}
                exclude={exclude}
                onToggle={toggleValue}
              />
            ) : (
              <div className="dimension-value-options" role="group" aria-label="Dimension values">
                {visibleValues.map((entry) => {
                  const isSelected = selectedKeys.has(entry.key);
                  return (
                    <label
                      key={entry.key}
                      className={`dimension-value-option${exclude && isSelected ? ' is-excluded' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleValue(entry.key)}
                      />
                      <span>{entry.label}</span>
                    </label>
                  );
                })}
              </div>
            )
          )}
        </div>
      )}

      <div className="dimension-fork-submit-row">
        <div>
          <strong>{clauses.length}</strong> staged clause{clauses.length === 1 ? '' : 's'}
          {stageDisabledReason && <div className="section-hint">{stageDisabledReason}</div>}
        </div>
        <button
          className="btn"
          type="button"
          disabled={Boolean(stageDisabledReason)}
          title={stageDisabledReason ?? undefined}
          onClick={stageClause}
        >
          {clauses.some((clause) => clause.fieldId === fieldId) ? 'Update clause' : 'Add clause'}
        </button>
      </div>
    </section>
  );
}

function getStageDisabledReason(input: {
  sourceCount: number;
  fieldsLoading: boolean;
  valuesLoading: boolean;
  fieldId: string;
  selectedCount: number;
}): string | null {
  if (input.sourceCount === 0) return 'Select at least one exact source metric.';
  if (input.fieldsLoading) return 'Wait for eligible fields to load.';
  if (!input.fieldId) return 'Select a dimension field.';
  if (input.valuesLoading) return 'Wait for dimension values to load.';
  if (input.selectedCount === 0) return 'Select at least one value.';
  return null;
}

// Fixed-height windowed list for very large value sets: only the rows in (and
// near) the viewport are mounted, so a domain of tens of thousands of members
// renders and scrolls smoothly instead of freezing the WebView. Selection and
// Select-all still act over the full domain upstream - this only bounds the DOM.
const VALUE_ROW_HEIGHT = 30;
const VALUE_VIEWPORT_HEIGHT = 300;
const VALUE_OVERSCAN = 8;

function VirtualizedValueList({
  items,
  selectedKeys,
  exclude,
  onToggle,
}: {
  items: PulseDimensionValue[];
  selectedKeys: Set<string>;
  exclude: boolean;
  onToggle: (key: string) => void;
}) {
  const [scrollTop, setScrollTop] = useState(0);
  const total = items.length;
  const firstVisible = Math.max(0, Math.floor(scrollTop / VALUE_ROW_HEIGHT) - VALUE_OVERSCAN);
  const windowRows = Math.ceil(VALUE_VIEWPORT_HEIGHT / VALUE_ROW_HEIGHT) + VALUE_OVERSCAN * 2;
  const lastVisible = Math.min(total, firstVisible + windowRows);
  const slice = items.slice(firstVisible, lastVisible);
  return (
    <div
      className="dimension-value-virtual"
      role="group"
      aria-label="Dimension values"
      style={{ height: VALUE_VIEWPORT_HEIGHT, overflowY: 'auto', position: 'relative' }}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div style={{ height: total * VALUE_ROW_HEIGHT, position: 'relative' }}>
        {slice.map((entry, offset) => {
          const index = firstVisible + offset;
          const isSelected = selectedKeys.has(entry.key);
          return (
            <label
              key={entry.key}
              className={`dimension-value-option${exclude && isSelected ? ' is-excluded' : ''}`}
              style={{ position: 'absolute', top: index * VALUE_ROW_HEIGHT, left: 0, right: 0, height: VALUE_ROW_HEIGHT }}
            >
              <input
                type="checkbox"
                checked={isSelected}
                onChange={() => onToggle(entry.key)}
              />
              <span className="dimension-value-virtual-label" title={entry.label}>{entry.label}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
