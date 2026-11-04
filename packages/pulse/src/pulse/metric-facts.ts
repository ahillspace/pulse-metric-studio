import type { PulseExactMetric } from './pulse-client.js';

export function metricDefinitionId(metric: PulseExactMetric): string {
  const nestedMetadata = metric.definition?.metadata;
  return String(
    metric.definition_id
    ?? metric.specification_reference?.definition_id
    ?? nestedMetadata?.id
    ?? '',
  ).trim();
}

export function metricSpecification(metric: PulseExactMetric): Record<string, unknown> | null {
  const candidate = metric.specification ?? metric.metric_specification;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}
