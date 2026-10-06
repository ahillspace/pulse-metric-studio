import { useEffect, useMemo, useState } from "react";
import { validatePulseDocument } from "@pulse-metric-studio/shared";
import {
  MetricTable,
  type MetricFieldRow as FieldRow,
} from "../author/MetricTable";
import { activeEditor, contextMatches, useAuthor } from "../author/controller";
import { useConnection } from "../connections/controller";
import { emptyTimeDimensionDiagnostic } from "../field-readiness";
import { Modal } from "./ui";

const PAGE_SIZE = 50;

export function ConfigEditor() {
  const entry = useAuthor(activeEditor);
  const session = useConnection((state) => state.session);
  const { updateMetric, toggleMetric, toggleSlicer } = useAuthor();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [hideUnused, setHideUnused] = useState(false);
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    setPage(0);
    setQuery("");
  }, [entry?.record.id]);
  const fields = useMemo(() => {
    if (!entry) return [];
    const known = new Map<string, FieldRow>();
    entry.catalog?.measures.forEach((field) =>
      known.set(field.id, {
        id: field.id,
        label: field.label,
        dimension: false,
        field,
      }),
    );
    entry.catalog?.dimensions.forEach((field) =>
      known.set(field.id, {
        id: field.id,
        label: field.label,
        dimension: true,
        field,
      }),
    );
    Object.values(entry.document.metrics).forEach((metric) => {
      if (!known.has(metric.fieldId))
        known.set(metric.fieldId, {
          id: metric.fieldId,
          label: metric.fieldLabel,
          dimension: false,
        });
    });
    return [...known.values()].filter(
      (field) =>
        (!hideUnused || entry.document.metrics[field.id]?.active) &&
        field.label.toLowerCase().includes(query.trim().toLowerCase()),
    );
  }, [entry?.catalog, entry?.document.metrics, query, hideUnused]);
  if (!entry) return null;
  const { document, catalog } = entry;
  const measures = fields.filter((field) => !field.dimension);
  const dimensions = fields.filter((field) => field.dimension);
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(measures.length / PAGE_SIZE) - 1),
  );
  const activeCount = Object.values(document.metrics).filter(
    (metric) => metric.active,
  ).length;
  const issues =
    catalog && activeCount ? validatePulseDocument(document, catalog) : [];
  const slicers = [
    ...new Map([
      ...(catalog?.dimensions.map(
        (field) =>
          [field.id, { fieldId: field.id, fieldLabel: field.label }] as const,
      ) ?? []),
      ...Object.values(document.slicers).map(
        (field) => [field.fieldId, field] as const,
      ),
    ]).values(),
  ].filter(
    (field) =>
      (!hideUnused || document.slicers[field.fieldId]?.active) &&
      field.fieldLabel.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const renderRows = (rows: FieldRow[], testId?: string) => (
    <MetricTable
      fields={rows}
      metrics={document.metrics}
      catalog={catalog}
      testId={testId}
      onToggle={toggleMetric}
      onChange={updateMetric}
    />
  );
  return (
    <section
      className="pulse-editor"
      id="matrix-panel"
      aria-label="Metric configuration"
    >
      <div className="pulse-view-toolbar pulse-author-toolbar">
        <label className="pulse-search">
          <span className="sr-only">Find fields</span>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" />
            <path d="m13 13 4 4" />
          </svg>
          <input
            type="search"
            placeholder="Filter fields..."
            aria-label="Find fields"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </label>
        <label className="pulse-native-checkbox">
          <input
            type="checkbox"
            checked={hideUnused}
            onChange={(event) => {
              setHideUnused(event.target.checked);
              setPage(0);
            }}
          />
          Hide unused
        </label>
        <button
          className="btn small pulse-clear-configuration"
          disabled={
            !Object.keys(document.metrics).length &&
            !Object.keys(document.slicers).length
          }
          onClick={() => setClearing(true)}
        >
          Clear configuration
        </button>
        <details className="pulse-context-menu">
          <summary aria-label="Datasource details" title="Datasource details">
            <svg
              width="16"
              height="16"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <circle cx="10" cy="10" r="7.5" />
              <path d="M10 9v5m0-9v1" />
            </svg>
          </summary>
          <div className="pulse-menu-surface">
            <strong>{entry.record.datasourceName}</strong>
            {catalog && (
              <p>
                {catalog.measures.length}{" "}
                {catalog.measures.length === 1 ? "measure" : "measures"} ·{" "}
                {catalog.dimensions.length}{" "}
                {catalog.dimensions.length === 1 ? "dimension" : "dimensions"} ·{" "}
                {catalog.timeDimensions.length} date{" "}
                {catalog.timeDimensions.length === 1 ? "field" : "fields"} ·{" "}
                {catalog.excluded.length} excluded
              </p>
            )}
            {catalog?.warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
            <button
              className="btn small"
              disabled={
                !contextMatches(entry.record.context, session) ||
                entry.catalogLoading
              }
              onClick={() =>
                void useAuthor.getState().refreshCatalog(entry.record.id, true)
              }
            >
              {entry.catalogLoading ? "Loading fields..." : "Refresh fields"}
            </button>
          </div>
        </details>
      </div>
      {entry.catalogError && (
        <p className="warning-banner" role="alert">
          {entry.catalogError}
        </p>
      )}
      {catalog && !catalog.timeDimensions.length && (
        <details className="warning-banner">
          <summary>No usable date field</summary>
          <p>{emptyTimeDimensionDiagnostic(catalog)}</p>
        </details>
      )}
      {!!issues.length && (
        <details className="pulse-validation">
          <summary>
            {issues.length} {issues.length === 1 ? "issue" : "issues"} to
            resolve before publishing
          </summary>
          <ul>
            {issues.map((issue, index) => (
              <li key={index}>{issue.message}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="pulse-slicer-section" role="group" aria-label="Slicers">
        <div className="pulse-group-heading">
          <h2>Slicers</h2>
          <span>
            {
              Object.values(document.slicers).filter((field) => field.active)
                .length
            }{" "}
            selected
          </span>
        </div>
        <div className="pill-wrap">
          {slicers.map((field) => {
            const metadata = catalog?.dimensions.find(
              (value) => value.id === field.fieldId,
            );
            const identifier = /(^|[\s_])(id|key)($|[\s_])/i.test(
              field.fieldLabel,
            );
            const title = [
              field.fieldLabel,
              metadata?.table,
              metadata?.dataType,
              identifier
                ? "Identifier-like field: often less useful for slicing."
                : "",
              catalog && !metadata ? "Field unavailable" : "",
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <button
                key={field.fieldId}
                className={`pill ${document.slicers[field.fieldId]?.active ? "active" : "inactive"}`}
                aria-label={
                  catalog && !metadata
                    ? `Unavailable: ${field.fieldLabel}`
                    : field.fieldLabel
                }
                aria-pressed={Boolean(document.slicers[field.fieldId]?.active)}
                title={title}
                onClick={() => toggleSlicer(field.fieldId)}
              >
                {field.fieldLabel}
              </button>
            );
          })}
        </div>
        {!slicers.length && (
          <p className="pulse-inline-empty">
            {hideUnused ? "No selected slicers." : "No matching slicers."}
          </p>
        )}
      </div>
      <div className="pulse-group-heading">
        <h2>Measures</h2>
        <span>{measures.filter((field) => document.metrics[field.id]?.active).length} of {measures.length} selected</span>
        <span className="pulse-table-scroll-hint" aria-hidden="true">
          More settings
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 10h13m-5-4 4 4-4 4" />
          </svg>
        </span>
      </div>
      {renderRows(
        measures.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE),
        "measure-list",
      )}
      {!measures.length && (
        <p className="pulse-inline-empty">
          {query || hideUnused
            ? "No matching measures."
            : "No measures available."}
        </p>
      )}
      <details
        className="pulse-dimension-group"
        data-testid="dimension-metrics"
      >
        <summary>
          Dimensions <span>{dimensions.length}</span>
        </summary>
        {renderRows(dimensions)}
      </details>
      {measures.length > PAGE_SIZE && (
        <Pagination
          page={currentPage}
          size={PAGE_SIZE}
          count={measures.length}
          label="Measures"
          onChange={setPage}
        />
      )}

      {clearing && (
        <Modal
          title="Clear configuration?"
          onClose={() => setClearing(false)}
          actions={
            <>
              <button className="btn" onClick={() => setClearing(false)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  useAuthor.getState().clearConfiguration();
                  setClearing(false);
                }}
              >
                Clear configuration
              </button>
            </>
          }
        >
          <p>
            Remove selected metrics and slicers. Your conversation and published
            metrics are kept.
          </p>
        </Modal>
      )}
    </section>
  );
}

export function Pagination({
  page,
  size,
  count,
  label,
  onChange,
}: {
  page: number;
  size: number;
  count: number;
  label: string;
  onChange: (page: number) => void;
}) {
  return (
    <div className="pulse-pagination" aria-label={`${label} pages`}>
      <span>
        {count === 0
          ? "0"
          : `${page * size + 1}-${Math.min(count, (page + 1) * size)}`}{" "}
        of {count} {label.toLowerCase()}
      </span>
      {count > size && (
        <>
          <button
            className="btn small"
            aria-label={`Previous ${label.toLowerCase()}`}
            disabled={page === 0}
            onClick={() => onChange(page - 1)}
          >
            Previous
          </button>
          <button
            className="btn small"
            aria-label={`Next ${label.toLowerCase()}`}
            disabled={(page + 1) * size >= count}
            onClick={() => onChange(page + 1)}
          >
            Next
          </button>
        </>
      )}
    </div>
  );
}
