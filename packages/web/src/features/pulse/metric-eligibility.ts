import { resolveCatalogField, validateTimeDimensionId, type CatalogField, type DatasourceCatalog, type MetricSelection } from '@pulse-metric-studio/shared';
import { enforceMetricConstraints } from './metric-operations';

export function currentCatalogField(catalog: DatasourceCatalog, id: string): CatalogField | undefined {
  if (catalog.excluded.some((entry) => entry.field.id === id)) return undefined;
  const field = resolveCatalogField(catalog, id);
  return field?.exclusion ? undefined : field;
}

export function metricEligibilityIssue(catalog: DatasourceCatalog, metric: MetricSelection): string | undefined {
  const field = currentCatalogField(catalog, metric.fieldId);
  if (!field) return `"${metric.fieldLabel}" is unavailable or excluded from the current catalog. Remove this metric or choose another field.`;
  if (!catalog.measures.some((measure) => measure.id === field.id) && metric.aggregation !== 'COUNT_DISTINCT') {
    return `"${field.label}" is a dimension. Select COUNT_DISTINCT or remove this metric.`;
  }
  return undefined;
}

export function reconcileMetricWithCatalog(catalog: DatasourceCatalog, metric: MetricSelection): MetricSelection {
  const field = currentCatalogField(catalog, metric.fieldId);
  if (!field) return metric;
  const requiresUserAgg = Boolean(field.requiresUserAgg);
  const aggregation = requiresUserAgg ? 'USER' : metric.aggregation === 'USER' ? 'SUM' : metric.aggregation;
  return enforceMetricConstraints({ ...metric, fieldLabel: field.label, requiresUserAgg, aggregation });
}

export function reconcileCatalogMetrics(catalog: DatasourceCatalog, metrics: Record<string, MetricSelection>): Record<string, MetricSelection> {
  return Object.fromEntries(Object.entries(metrics).map(([id, metric]) => [id, reconcileMetricWithCatalog(catalog, metric)]));
}

export function metricIsReady(catalog: DatasourceCatalog, metric: MetricSelection): boolean {
  return metric.active && !metricEligibilityIssue(catalog, metric) && Boolean(metric.name.trim()) && validateTimeDimensionId(catalog, metric.timeDimensionFieldId).eligible;
}
