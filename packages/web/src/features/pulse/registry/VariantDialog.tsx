import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  TIMEFRAMES,
  type PulseVariantRequestV1,
} from "@pulse-metric-studio/shared";
import {
  DimensionalFork,
  type InheritedDimensionFilter,
} from "../components/DimensionalFork";
import type { PulseFilterDimensionField } from "../dimensional-filter";
import { BusyLabel, Modal } from "../components/ui";
import {
  selectionState,
  setMetricSelection,
  type PulseForkPlanState,
  type PulseRegistryMetric,
  type StagedDimensionClause,
} from "../fork-plan";
import {
  sharedSourceFilter,
  sourceFilters,
  stagedValues,
} from "./source-filters";
import {
  variantHasChanges,
  variantPlanForSelection,
  variantPreview,
  variantRequest,
} from "./variant-plan";
import { getForkDisabledReason, SelectionCheckbox } from "./views";

interface Props {
  metrics: PulseRegistryMetric[];
  selectedMetricIds: string[];
  busy: boolean;
  onClose(): void;
  onCreate(
    request: PulseVariantRequestV1,
    labels: Map<string, string>,
  ): Promise<void>;
}
export function VariantDialog({
  metrics,
  selectedMetricIds,
  busy,
  onClose,
  onCreate,
}: Props) {
  const [plan, setPlan] = useState<PulseForkPlanState>(() =>
    variantPlanForSelection(metrics, selectedMetricIds),
  );
  useEffect(() => {
    const available = new Set(metrics.map((metric) => metric.metricId));
    setPlan((current) => {
      const selectedMetricIds = current.selectedMetricIds.filter((id) =>
        available.has(id),
      );
      return selectedMetricIds.length === current.selectedMetricIds.length
        ? current
        : { ...current, selectedMetricIds };
    });
  }, [metrics]);
  const [query, setQuery] = useState("");
  const [sourceOpen, setSourceOpen] = useState(!selectedMetricIds.length);
  const [compatibility, setCompatibility] = useState("");
  const [filterState, setFilterState] = useState<string | null>(null);
  const [fields, setFields] = useState<PulseFilterDimensionField[]>([]);
  const selectedIds = useMemo(
    () => new Set(plan.selectedMetricIds),
    [plan.selectedMetricIds],
  );
  const selected = useMemo(
    () =>
      metrics.filter((metric) =>
        selectedIds.has(metric.metricId),
      ),
    [metrics, selectedIds],
  );
  const sources = useMemo(
    () =>
      selected.map((metric) => ({
        id: metric.metricId,
        label: `${metric.name} - ${metric.timeframeLabel}`,
      })),
    [selected],
  );
  const sourceKey = sources.map((source) => source.id).join("\u0000");
  const sourceKeyRef = useRef(sourceKey);
  sourceKeyRef.current = sourceKey;
  // Eligible fields belong to one source selection; drop them when it changes.
  useEffect(() => setFields([]), [sourceKey]);
  const changeClauses = useCallback(
    (clauses: StagedDimensionClause[]) =>
      setPlan((current) => ({ ...current, clauses })),
    [],
  );
  const compatible = useCallback((key: string, eligible: PulseFilterDimensionField[]) => {
    if (key !== sourceKeyRef.current) return;
    const fieldIds = eligible.map((field) => field.id);
    setFields(eligible);
    setPlan((current) => ({
      ...current,
      clauses: current.clauses.filter((clause) =>
        fieldIds.includes(clause.fieldId),
      ),
    }));
    setCompatibility(key);
  }, []);
  const inherited = useMemo<InheritedDimensionFilter[]>(
    () =>
      fields.flatMap((field) => {
        const filter = sharedSourceFilter(selected, field.name);
        return filter
          ? [
              {
                fieldId: field.id,
                fieldLabel: field.label,
                exclude: filter.exclude,
                values: stagedValues(filter),
              },
            ]
          : [];
      }),
    [fields, selected],
  );
  const visible = metrics.filter((metric) =>
    `${metric.name} ${metric.timeframeLabel}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const reason =
    filterState ||
    getForkDisabledReason({
      selectedCount: selected.length,
      hasChanges: variantHasChanges(plan, metrics, fields),
      dimensionsUnresolved:
        plan.clauses.length > 0 && compatibility !== sourceKey,
      busy,
    });
  const preview = variantPreview(metrics, plan, fields);
  return createPortal(
    <Modal
      title="Create variants"
      className="pulse-variant-dialog"
      onClose={busy ? undefined : onClose}
      actions={
        <>
          <p role="status">
            {reason ||
              `${selected.length} ${selected.length === 1 ? "variant" : "variants"} ready to create`}
          </p>
          <button className="btn" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={Boolean(reason)}
            onClick={() =>
              void onCreate(
                variantRequest(plan, metrics, fields),
                new Map(sources.map((source) => [source.id, source.label])),
              ).then(onClose)
            }
          >
            <BusyLabel busy={busy} idle={`Create ${selected.length} ${selected.length === 1 ? "variant" : "variants"}`} active="Creating..." />
          </button>
        </>
      }
    >
      <fieldset disabled={busy} className="pulse-variant-fields">
        <div className="pulse-variant-layout">
          <div className="pulse-variant-config">
            <section>
              <div className="pulse-variant-heading">
                <h3>Source metrics</h3>
                <span>{selected.length} selected</span>
              </div>
              <details
                open={sourceOpen}
                onToggle={(event) => setSourceOpen(event.currentTarget.open)}
                className="pulse-variant-sources"
              >
                <summary>
                  {selected.length
                    ? [...new Set(selected.map((metric) => metric.name))].join(
                        ", ",
                      )
                    : "Choose metrics"}
                  <span>Change</span>
                </summary>
                <input
                  type="search"
                  aria-label="Search source metrics"
                  placeholder="Search metrics..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <div className="pulse-variant-selection">
                  <SelectionCheckbox
                    label="Select matching source metrics"
                    state={selectionState(
                      selectedIds,
                      visible.map((metric) => metric.metricId),
                    )}
                    onChange={(checked) =>
                      setPlan((current) => ({
                        ...current,
                        selectedMetricIds: setMetricSelection(
                          current.selectedMetricIds,
                          visible.map((metric) => metric.metricId),
                          checked,
                        ),
                      }))
                    }
                  />
                  <span>Select matches</span>
                  <button
                    className="linkish"
                    onClick={() =>
                      setPlan((current) => ({
                        ...current,
                        selectedMetricIds: [],
                      }))
                    }
                  >
                    Clear
                  </button>
                </div>
                <div className="pulse-variant-source-list">
                  {visible.map((metric) => (
                    <label key={metric.metricId}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(
                          metric.metricId,
                        )}
                        onChange={(event) =>
                          setPlan((current) => ({
                            ...current,
                            selectedMetricIds: setMetricSelection(
                              current.selectedMetricIds,
                              [metric.metricId],
                              event.target.checked,
                            ),
                          }))
                        }
                      />
                      <span>
                        {metric.name}
                        <small>
                          {metric.timeframeLabel}
                          {sourceFilters(metric).length > 0 && " · Scoped"}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              </details>
            </section>
            <section>
              <div className="pulse-variant-heading">
                <h3>Timeframe</h3>
              </div>
              <select
                aria-label="Variant timeframe"
                value={plan.timeframe?.key || ""}
                onChange={(event) => {
                  const key = event.target.value;
                  setPlan((current) => ({
                    ...current,
                    timeframe: key
                      ? { key, label: TIMEFRAMES[key].label }
                      : null,
                  }));
                }}
              >
                <option value="">Keep each source timeframe</option>
                {Object.entries(TIMEFRAMES)
                  .filter(([key]) => key !== "LAST_N_DAYS")
                  .map(([key, timeframe]) => (
                    <option key={key} value={key}>
                      {timeframe.label}
                    </option>
                  ))}
              </select>
            </section>
            <DimensionalFork
              sources={sources}
              clauses={plan.clauses}
              inherited={inherited}
              onChange={changeClauses}
              onCompatibilityResolved={compatible}
              onEditingState={setFilterState}
            />
          </div>
          <aside className="pulse-variant-preview" aria-label="Variant preview">
            <div className="pulse-variant-heading">
              <h3>Preview</h3>
              <span>
                {preview.length} {preview.length === 1 ? "variant" : "variants"}
              </span>
            </div>
            {!preview.length && (
              <p className="pulse-variant-empty">
                Choose source metrics to see the results here.
              </p>
            )}
            {preview.map((metric) => (
              <article key={metric.id}>
                <strong>{metric.name}</strong>
                <p>
                  {metric.sourceTimeframe !== metric.timeframe && (
                    <>
                      <span className="muted">{metric.sourceTimeframe}</span>{" "}
                      →{" "}
                    </>
                  )}
                  {metric.timeframe}
                </p>
                {metric.filters.length > 0 ? (
                  <ul>
                    {metric.filters.map((filter) => (
                      <li key={filter}>{filter}</li>
                    ))}
                  </ul>
                ) : (
                  <small>No filters</small>
                )}
              </article>
            ))}
            {!!preview.length && (
              <p className="section-hint">
                One variant per source. Selected values stay together in each
                filter. Existing variants are reused.
              </p>
            )}
          </aside>
        </div>
      </fieldset>
    </Modal>,
    document.body,
  );
}
