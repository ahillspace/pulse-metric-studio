import type { DatasourceCatalog } from './field-catalog.js';
import type { PulseAuthorProposal, PulseWorkspaceDocumentV1 } from './pulse-contracts.js';

const metricChangeLabels = {
  active: 'Included', aggregation: 'Aggregation', cumulative: 'Cumulative',
  format: 'Number format', sentiment: 'Favorable direction', name: 'Name',
  description: 'Description', timeDimensionFieldId: 'Date field',
  minGranularity: 'Minimum time grain', temporality: 'Time comparison',
} as const;

function changeValue(value: unknown, field: string, catalog?: DatasourceCatalog | null): string {
  if (value === undefined || value === null || value === '') return '(none)';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (field === 'timeDimensionFieldId')
    return catalog?.timeDimensions.find((item) => item.id === value)?.label ?? String(value);
  return String(value);
}

/** Describe the actual configuration transition, including a merge with newer manual edits. */
export function describePulseDocumentChanges(
  before: PulseWorkspaceDocumentV1,
  after: PulseWorkspaceDocumentV1,
  catalog?: DatasourceCatalog | null,
): PulseAuthorProposal['changes'] {
  const changes: PulseAuthorProposal['changes'] = [];
  for (const [fieldId, metric] of Object.entries(after.metrics)) {
    const previous = Object.hasOwn(before.metrics, fieldId) ? before.metrics[fieldId] : undefined;
    for (const field of Object.keys(metricChangeLabels) as Array<keyof typeof metricChangeLabels>) {
      const value = metric[field];
      if (JSON.stringify(previous?.[field]) !== JSON.stringify(value))
        changes.push({
          field: `${fieldId}.${field}`,
          message: `${metric.fieldLabel}: ${metricChangeLabels[field]} changed from ${changeValue(previous?.[field], field, catalog)} to ${changeValue(value, field, catalog)}.`,
        });
    }
  }
  for (const [fieldId, metric] of Object.entries(before.metrics))
    if (!Object.hasOwn(after.metrics, fieldId)) changes.push({ field: `${fieldId}.active`, message: `${metric.fieldLabel}: metric removed.` });
  for (const fieldId of new Set([...Object.keys(before.slicers), ...Object.keys(after.slicers)])) {
    const previous = Object.hasOwn(before.slicers, fieldId) ? before.slicers[fieldId] : undefined;
    const next = Object.hasOwn(after.slicers, fieldId) ? after.slicers[fieldId] : undefined;
    const slicer = next ?? previous;
    if (slicer && Boolean(previous?.active) !== Boolean(next?.active))
      changes.push({ field: `slicers.${fieldId}`, message: `${slicer.fieldLabel}: slicer ${next?.active ? 'selected' : 'removed'}.` });
  }
  if (before.digestAudience !== after.digestAudience)
    changes.push({ field: 'digestAudience', message: `Audience changed to ${after.digestAudience}.` });
  return changes;
}
