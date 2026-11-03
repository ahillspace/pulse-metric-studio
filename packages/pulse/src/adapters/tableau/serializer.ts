import type { CatalogField,DatasourceCatalog,MetricSelection } from '@pulse-metric-studio/shared';

import { currentCatalogField,metricEligibilityIssue,reconcileMetricWithCatalog,validateTimeDimensionId } from '@pulse-metric-studio/shared';

/**
 * Pulse definition payload construction — a verbatim port of the working
 * legacy Juju builder (`buildTableauCreateMetricPayload` + helpers in the old
 * app.js). Do NOT "improve" shapes here: every key, ordering decision, and
 * fallback below is proven against prod pods. The server posts this object
 * as-is (no schema reshape).
 */

export interface SlicerSelection {
  active: boolean;
  fieldId: string;
  fieldLabel: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

// -- enums (verbatim from legacy app.js) --------------------------------------

function mapAggregation(agg: string): string {
  switch (String(agg || '').toUpperCase()) {
    case 'SUM': return 'AGGREGATION_SUM';
    case 'AVG': return 'AGGREGATION_AVG';
    case 'AVERAGE': return 'AGGREGATION_AVERAGE';
    case 'MIN': return 'AGGREGATION_MIN';
    case 'MAX': return 'AGGREGATION_MAX';
    case 'COUNT': return 'AGGREGATION_COUNT';
    case 'COUNT_DISTINCT': return 'AGGREGATION_COUNT_DISTINCT';
    case 'AGGREGATION_USER': return 'AGGREGATION_USER';
    case 'USER': return 'AGGREGATION_USER';
    default: return 'AGGREGATION_SUM';
  }
}

function mapNumberFormat(fmt: string): string {
  switch (String(fmt || '').toUpperCase()) {
    case 'CURRENCY': return 'NUMBER_FORMAT_TYPE_CURRENCY';
    case 'PERCENT': return 'NUMBER_FORMAT_TYPE_PERCENT';
    case 'NUMBER':
    default: return 'NUMBER_FORMAT_TYPE_NUMBER';
  }
}

function mapSentiment(s: string): string {
  switch (String(s || '').toUpperCase()) {
    case 'DOWN_IS_GOOD':
    case 'DOWN': return 'SENTIMENT_TYPE_DOWN_IS_GOOD';
    case 'NEUTRAL': return 'SENTIMENT_TYPE_NEUTRAL';
    case 'NONE': return 'SENTIMENT_TYPE_NONE';
    case 'UP_IS_GOOD':
    case 'UP':
    default: return 'SENTIMENT_TYPE_UP_IS_GOOD';
  }
}

function mapMinimumDateToAllowedGranularities(minDate: string): string[] {
  switch (String(minDate || 'DAY').toUpperCase()) {
    case 'WEEK':
      return ['GRANULARITY_BY_WEEK', 'GRANULARITY_BY_MONTH', 'GRANULARITY_BY_QUARTER', 'GRANULARITY_BY_YEAR'];
    case 'MONTH':
      return ['GRANULARITY_BY_MONTH', 'GRANULARITY_BY_QUARTER', 'GRANULARITY_BY_YEAR'];
    case 'QUARTER':
      return ['GRANULARITY_BY_QUARTER', 'GRANULARITY_BY_YEAR'];
    case 'YEAR':
      return ['GRANULARITY_BY_YEAR'];
    case 'DAY':
    default:
      return ['GRANULARITY_BY_DAY', 'GRANULARITY_BY_WEEK', 'GRANULARITY_BY_MONTH', 'GRANULARITY_BY_QUARTER', 'GRANULARITY_BY_YEAR'];
  }
}

const INSIGHTS_SETTINGS = [
  { type: 'INSIGHT_TYPE_RISKY_MONOPOLY', disabled: false },
  { type: 'INSIGHT_TYPE_TOP_DRIVERS', disabled: false },
  { type: 'INSIGHT_TYPE_CURRENT_TREND', disabled: false },
  { type: 'INSIGHT_TYPE_BOTTOM_CONTRIBUTORS', disabled: false },
  { type: 'INSIGHT_TYPE_TOP_DETRACTORS', disabled: false },
  { type: 'INSIGHT_TYPE_NEW_TREND', disabled: false },
  { type: 'INSIGHT_TYPE_UNUSUAL_CHANGE', disabled: false },
  { type: 'INSIGHT_TYPE_RECORD_LEVEL_OUTLIERS', disabled: true },
  { type: 'INSIGHT_TYPE_CORRELATED_METRIC', disabled: false },
  { type: 'INSIGHT_TYPE_METRIC_FORECAST', disabled: false },
];

// -- canonical identifiers ----------------------------------------------------

/** Resolve only a catalog-proven legacy display qualifier to its provider name. */
function catalogFieldReference(field: CatalogField): string {
  const qualifier = field.table ?? 'calc';
  return field.name && field.id === `${field.name} (${qualifier})` ? field.name : field.id;
}

function pulseFieldReference(id: string, catalog: DatasourceCatalog): string {
  const field = currentCatalogField(catalog, id);
  return field ? catalogFieldReference(field) : id;
}

function referenceIssues(input: BuildPayloadsInput): ValidationError[] {
  const issues: ValidationError[] = [];
  const wireReferences = new Map<string, Set<string>>();
  for (const field of [...input.catalog.measures, ...input.catalog.dimensions, ...input.catalog.timeDimensions]) {
    const wire = catalogFieldReference(field);
    const ids = wireReferences.get(wire) ?? new Set<string>();
    ids.add(field.id);
    wireReferences.set(wire, ids);
  }
  const checked = new Set<string>();
  const checkReference = (id: string, label: string) => {
    if (checked.has(id)) return;
    checked.add(id);
    const collisions = wireReferences.get(pulseFieldReference(id, input.catalog));
    if (collisions && collisions.size > 1) {
      issues.push({ field: id, message: `"${label}" has an ambiguous Pulse field reference shared by ${[...collisions].join(', ')}. Rename the conflicting datasource fields before publishing.` });
    }
  };
  for (const metric of Object.values(input.metrics).filter((entry) => entry.active)) {
    const issue = metricEligibilityIssue(input.catalog, metric);
    if (issue) issues.push({ field: metric.fieldId, message: issue });
    checkReference(metric.fieldId, metric.fieldLabel);
    if (metric.timeDimensionFieldId) checkReference(metric.timeDimensionFieldId, metric.timeDimensionFieldId);
  }
  for (const slicer of Object.values(input.slicers).filter((entry) => entry.active)) {
    if (!currentCatalogField(input.catalog, slicer.fieldId)) issues.push({ field: slicer.fieldId, message: `"${slicer.fieldLabel}" is an unavailable or excluded slicer. Remove it before publishing.` });
    checkReference(slicer.fieldId, slicer.fieldLabel);
  }
  return issues;
}

// -- validation ---------------------------------------------------------------

export function validateSelection(input: {
  metrics: Record<string, MetricSelection>;
  slicers: Record<string, SlicerSelection>;
  catalog: DatasourceCatalog;
}): ValidationError[] {
  const errors: ValidationError[] = referenceIssues(input);
  const active = Object.values(input.metrics).filter((m) => m.active);
  if (active.length === 0) {
    errors.push({ field: '', message: 'Select at least one measure to publish.' });
  }
  for (const m of active) {
    if (!m.timeDimensionFieldId) {
      errors.push({ field: m.fieldId, message: `"${m.name || m.fieldLabel}" needs a time field.` });
    } else if (!validateTimeDimensionId(input.catalog, m.timeDimensionFieldId).eligible) {
      errors.push({
        field: m.fieldId,
        message: `"${m.name || m.fieldLabel}" uses a time field that is no longer eligible. Select a current date or datetime field.`,
      });
    }
    if (!(m.name || '').trim()) errors.push({ field: m.fieldId, message: `Metric based on "${m.fieldLabel}" needs a name.` });
  }
  return errors;
}

// -- payload construction (verbatim port) -------------------------------------

export interface BuildPayloadsInput {
  metrics: Record<string, MetricSelection>;
  slicers: Record<string, SlicerSelection>;
  catalog: DatasourceCatalog;
  datasourceLuid?: string;
}

function buildOne(
  catalog: DatasourceCatalog,
  datasourceId: string,
  timeField: string,
  slicers: string[],
  sel: MetricSelection,
): Record<string, unknown> & { name: string } {
  const field = String(sel.fieldId ?? '');
  const displayName = String(sel.name ?? sel.fieldLabel ?? '').trim();
  const current = reconcileMetricWithCatalog(catalog, sel);
  const aggEnum = current.requiresUserAgg ? 'AGGREGATION_USER' : mapAggregation(current.aggregation);
  const isRunningTotal =
    current.temporality !== 'LATEST' && Boolean(current.cumulative) && aggEnum === 'AGGREGATION_SUM';

  const rep: Record<string, unknown> = {
    type: mapNumberFormat(sel.format),
    sentiment_type: mapSentiment(sel.sentiment),
  };
  if (sel.format === 'CURRENCY') rep.currency_code = 'CURRENCY_CODE_USD';

  const measureField = pulseFieldReference(field, catalog);

  const timeDimField = pulseFieldReference(timeField, catalog);

  const resolvedSlicers = [...new Set(
    slicers
      // allowed_dimensions references emit the raw canonical id like the
      // measure/time dimension: a calculated dimension slicer emits its
      // internal Calculation_NNN id, physical columns emit their raw name.
      // MQS resolves these by id/name, not caption.
      .map((s) => pulseFieldReference(s, catalog))
      .filter(Boolean),
  )];

  return {
    name: displayName || 'Unnamed Metric',
    description: String(sel.description ?? '').trim(),
    specification: {
      datasource: { id: String(datasourceId || catalog.datasourceLuid || '').trim() },
      basic_specification: {
        measure: { field: measureField, aggregation: aggEnum },
        time_dimension: { field: timeDimField },
        filters: [],
      },
      ...(sel.temporality === 'LATEST'
        ? { temporality: 'TEMPORALITY_LATEST_POINT_IN_TIME' as const }
        : {}),
      is_running_total: isRunningTotal,
    },
    extension_options: {
      allowed_dimensions: resolvedSlicers,
      allowed_granularities: mapMinimumDateToAllowedGranularities(sel.minGranularity || 'DAY'),
      offset_from_today: 0,
      use_dynamic_offset: false,
    },
    representation_options: rep,
    insights_options: {
      show_insights: true,
      settings: INSIGHTS_SETTINGS,
    },
    comparisons: {
      comparisons: [
        { compare_config: { comparison: 'TIME_COMPARISON_PREVIOUS_PERIOD' }, index: 0 },
        { compare_config: { comparison: 'TIME_COMPARISON_YEAR_AGO_PERIOD' }, index: 1 },
      ],
    },
    datasource_goals: [],
    related_links: [],
    certification: { is_certified: false },
  };
}

export function buildCreatePayloads(input: BuildPayloadsInput): Array<Record<string, unknown> & { name: string }> {
  const issues = referenceIssues(input);
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join(' '));
  const payloads: Array<Record<string, unknown> & { name: string }> = [];

  const selectedSlicers = Object.values(input.slicers).filter((s) => s.active).map((s) => s.fieldId);

  for (const sel of Object.values(input.metrics)) {
    if (!sel.active) continue;
    const timeField = validateTimeDimensionId(input.catalog, sel.timeDimensionFieldId);
    if (!timeField.eligible) continue;
    payloads.push(buildOne(input.catalog, input.catalog.datasourceLuid, timeField.field.id, selectedSlicers, sel));
  }
  return payloads;
}
