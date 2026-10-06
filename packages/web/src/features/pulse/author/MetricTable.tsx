import { useLayoutEffect, useRef } from "react";
import {
  MIN_GRANULARITY_OPTIONS,
  PULSE_TEXT_LIMITS,
  type CatalogField,
  type DatasourceCatalog,
  type PulseMetricDraft,
} from "@pulse-metric-studio/shared";

export type MetricFieldRow = {
  id: string;
  label: string;
  dimension: boolean;
  field?: CatalogField;
};

export const aggregationLabels: Record<string, string> = {
  SUM: "Sum",
  AVERAGE: "Average",
  MIN: "Minimum",
  MAX: "Maximum",
  COUNT_DISTINCT: "Distinct count",
  USER: "Calculated",
};

const propertyLabels: Record<string, string> = {
  name: "name",
  description: "description",
  format: "format",
  sentiment: "sentiment",
  cumulative: "cumulative setting",
  aggregation: "calculation",
  timeDimensionFieldId: "date field",
  minGranularity: "minimum granularity",
  temporality: "data mode",
  active: "selection",
};

export function MetricTable({
  fields,
  metrics,
  catalog,
  testId,
  onToggle,
  onChange,
}: {
  fields: MetricFieldRow[];
  metrics: Record<string, PulseMetricDraft>;
  catalog: DatasourceCatalog | null;
  testId?: string;
  onToggle: (id: string) => void;
  onChange: (id: string, patch: Partial<PulseMetricDraft>) => void;
}) {
  return (
    <div
      className="pulse-metric-scroll"
      tabIndex={0}
      role="region"
      aria-label="Metric settings, scroll horizontally for more properties"
    >
      <table className="pulse-metric-list" data-testid={testId}>
        <thead>
          <tr>
            {[
              "Metric",
              "Calculation",
              "Date field",
              "Format",
              "Sentiment",
              "Data mode",
              "Cumulative",
              "Minimum granularity",
              "Description",
              "Source field",
            ].map((label) => (
              <th scope="col" key={label}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <MetricRow
              key={field.id}
              field={field}
              metric={metrics[field.id]}
              catalog={catalog}
              onToggle={() => onToggle(field.id)}
              onChange={(patch) => onChange(field.id, patch)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetricRow({
  field,
  metric,
  catalog,
  onToggle,
  onChange,
}: {
  field: MetricFieldRow;
  metric?: PulseMetricDraft;
  catalog: DatasourceCatalog | null;
  onToggle: () => void;
  onChange: (patch: Partial<PulseMetricDraft>) => void;
}) {
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const editor = descriptionRef.current;
    if (editor && document.activeElement !== editor) {
      editor.scrollTop = 0;
      editor.scrollLeft = 0;
    }
  }, [metric?.description]);
  const active = Boolean(metric?.active);
  const calculated = Boolean(
    field.field?.requiresUserAgg || metric?.aggregation === "USER",
  );
  const aggregations = calculated
    ? ["USER"]
    : field.dimension
      ? ["COUNT_DISTINCT"]
      : ["SUM", "AVERAGE", "MIN", "MAX", "COUNT_DISTINCT"];
  const times = catalog?.timeDimensions ?? [];
  const missingTime =
    metric?.timeDimensionFieldId &&
    !times.some((time) => time.id === metric.timeDimensionFieldId);
  const select = (
    label: string,
    property: keyof PulseMetricDraft,
    options: ReadonlyArray<{ value: string; label: string }>,
  ) => (
    <select
      aria-label={`${label} for ${field.label}`}
      disabled={!active}
      value={String(metric?.[property] ?? "")}
      onChange={(event) => onChange({ [property]: event.target.value })}
    >
      {!metric && <option value="">Select metric first</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
  return (
    <tr className={active ? "is-selected" : ""}>
      <th scope="row">
        <div className="pulse-metric-name">
          <input
            type="checkbox"
            aria-label={`Use ${field.label}`}
            checked={active}
            onChange={onToggle}
          />
          <div>
            <input
              aria-label={`Metric name for ${field.label}`}
              title={`Source field: ${field.label}`}
              maxLength={PULSE_TEXT_LIMITS.name}
              disabled={!active}
              value={metric?.name ?? field.label}
              onChange={(event) => onChange({ name: event.target.value })}
            />
          </div>
        </div>
      </th>
      <td>
        <select
          aria-label={`Aggregation for ${field.label}`}
          disabled={!active || calculated}
          value={
            metric?.aggregation ??
            (field.dimension
              ? "COUNT_DISTINCT"
              : (field.field?.defaultAggregation ?? "SUM"))
          }
          onChange={(event) =>
            onChange({
              aggregation: event.target
                .value as PulseMetricDraft["aggregation"],
            })
          }
        >
          {metric && !aggregations.includes(metric.aggregation) && (
            <option value={metric.aggregation}>
              Unsupported:{" "}
              {aggregationLabels[metric.aggregation] ?? metric.aggregation}
            </option>
          )}
          {aggregations.map((value) => (
            <option key={value} value={value}>
              {aggregationLabels[value]}
            </option>
          ))}
        </select>
      </td>
      <td>
        <select
          aria-label={`Time field for ${field.label}`}
          disabled={!active}
          value={metric?.timeDimensionFieldId ?? ""}
          onChange={(event) =>
            onChange({ timeDimensionFieldId: event.target.value || null })
          }
        >
          <option value="">Select date</option>
          {missingTime && (
            <option value={metric!.timeDimensionFieldId!}>
              Unavailable date field
            </option>
          )}
          {times.map((time) => (
            <option key={time.id} value={time.id}>
              {time.label}
            </option>
          ))}
        </select>
      </td>
      <td>
        {select("Format", "format", [
          { value: "NUMBER", label: "Number" },
          { value: "CURRENCY", label: "Currency" },
          { value: "PERCENT", label: "Percent" },
        ])}
      </td>
      <td>
        {select("Sentiment", "sentiment", [
          { value: "UP", label: "Higher is better" },
          { value: "DOWN", label: "Lower is better" },
          { value: "NONE", label: "Neutral" },
        ])}
      </td>
      <td>
        {select("Data mode", "temporality", [
          { value: "OVER_TIME", label: "Over time" },
          { value: "LATEST", label: "Latest value" },
        ])}
      </td>
      <td className="pulse-cumulative-cell">
        <input
          type="checkbox"
          role="switch"
          aria-label={`Cumulative for ${field.label}`}
          checked={!calculated && Boolean(metric?.cumulative)}
          disabled={
            !active ||
            calculated ||
            metric?.aggregation !== "SUM" ||
            metric?.format === "PERCENT" ||
            metric?.temporality === "LATEST"
          }
          onChange={(event) => onChange({ cumulative: event.target.checked })}
        />
      </td>
      <td>
        {select(
          "Minimum granularity",
          "minGranularity",
          MIN_GRANULARITY_OPTIONS,
        )}
      </td>
      <td className="pulse-description-cell">
        <textarea
          ref={descriptionRef}
          rows={2}
          aria-label={`Description for ${field.label}`}
          placeholder="Add description"
          maxLength={PULSE_TEXT_LIMITS.description}
          disabled={!active}
          value={metric?.description ?? ""}
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </td>
      <td className="pulse-source-field-cell">
        <span className="pulse-source-field-label">
          <span className="pulse-source-field-name" title={field.label}>{field.label}</span>
          {catalog && !field.field && (
            <span className="pulse-field-unavailable">Unavailable</span>
          )}
        </span>
        <details className="pulse-field-details">
          <summary
            aria-label={`Field details for ${field.label}`}
            title={`Field details for ${field.label}`}
          >
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <circle cx="10" cy="10" r="7.5" />
              <path d="M10 9v5m0-9v1" />
            </svg>
          </summary>
          <p>
            {[field.field?.table, field.field?.dataType]
              .filter(Boolean)
              .join(" · ") || "This field is not in the current datasource."}
          </p>
          {field.field?.formula && <pre>{field.field.formula}</pre>}
          {!!metric?.locks.length && (
            <p>
              Protected from assistant changes:{" "}
              {metric.locks
                .map((property) => propertyLabels[property] ?? "edited setting")
                .join(", ")}
              .
            </p>
          )}
        </details>
      </td>
    </tr>
  );
}
