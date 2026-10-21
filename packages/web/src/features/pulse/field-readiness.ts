import { validateTimeDimensionId, type DatasourceCatalog, type MetricSelection } from '@pulse-metric-studio/shared';

export function metricHasEligibleTimeDimension(
  metric: Pick<MetricSelection, 'timeDimensionFieldId'>,
  catalog: Pick<DatasourceCatalog, 'timeDimensions'>,
): boolean {
  return validateTimeDimensionId(catalog, metric.timeDimensionFieldId).eligible;
}

export function emptyTimeDimensionDiagnostic(catalog: DatasourceCatalog): string {
  const diagnostics = catalog.diagnostics;
  if (!diagnostics) {
    return 'No normalized date or datetime fields were found. Pulse metrics need an eligible time dimension to publish.';
  }
  const counts = diagnostics.counts;
  const excluded = diagnostics.timeDimensionExcludedByReason;
  return [
    'No normalized date or datetime fields were found.',
    `Catalog counts: ${counts.discovered} discovered, ${counts.measures} measures, ${counts.dimensions} dimensions, ${counts.timeDimensions} time dimensions, and ${counts.excluded} excluded.`,
    `Time-field exclusions: ${excluded.excluded} excluded, ${excluded.measureRole} measure-role, and ${excluded.unsupportedType} unsupported-type.`,
  ].join(' ');
}
