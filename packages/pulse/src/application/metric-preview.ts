import { TableauError } from '@pulse-metric-studio/core';
import type { PulseMetricPreview, PulseMetricPreviewRequest } from '@pulse-metric-studio/shared';
import { getPulseDefinition, getPulseMetric } from '../pulse/pulse-client.js';
import { metricDefinitionId } from '../pulse/reconciliation.js';
import { generateMetricPreview, PulsePreviewDataError } from '../pulse/metric-preview.js';
import { requirePulseOwner } from './context.js';
import { PulseApplicationError } from './errors.js';

const MAX_METADATA_BYTES = 1024 * 1024;
export async function previewPulseMetric(metricId: string, request: PulseMetricPreviewRequest): Promise<PulseMetricPreview> {
  const session = requirePulseOwner(request.context);
  try {
    const metric = await getPulseMetric(session, metricId, MAX_METADATA_BYTES);
    requirePulseOwner(request.context, session);
    const actualMetricId = metric.id ?? metric.metadata?.id;
    const definitionId = metricDefinitionId(metric);
    if (actualMetricId !== metricId || !definitionId || ((metric.site_id ?? metric.site?.id) && (metric.site_id ?? metric.site?.id) !== session.siteId))
      throw new PulseApplicationError('pulse_preview_context_mismatch', 'This metric does not belong to the selected context.', 409);
    const definition = await getPulseDefinition(session, definitionId, MAX_METADATA_BYTES);
    requirePulseOwner(request.context, session);
    if (definition.metadata?.id !== definitionId || definition.specification?.datasource?.id !== request.context.datasourceLuid)
      throw new PulseApplicationError('pulse_preview_context_mismatch', 'This metric does not belong to the selected datasource.', 409);
    const imageDataUrl = await generateMetricPreview(session, definition, metric, metricId, definitionId);
    requirePulseOwner(request.context, session);
    return { metricId, definitionId, name: definition.metadata.name ?? '', imageDataUrl, generatedAt: Date.now() };
  } catch (error) {
    if (error instanceof PulsePreviewDataError)
      throw new PulseApplicationError(error.code, error.message, error.code === 'pulse_preview_unavailable' ? 422 : 502);
    if (error instanceof TableauError) {
      if (error.kind === 'auth') throw new PulseApplicationError('tableau_connection_required', 'Reconnect to Tableau to preview this metric.', 401);
      if (error.status === 404 && /images\/metricCard|insights\/springboard/.test(error.message))
        throw new PulseApplicationError('pulse_preview_unsupported', 'Metric card previews require Tableau Cloud with the metric image API.', 501);
      if (error.status === 403) throw new PulseApplicationError('pulse_preview_forbidden', 'You do not have permission to preview this metric.', 403);
      throw new PulseApplicationError('pulse_preview_unavailable', 'Tableau could not load this metric preview. Try again or view it in Pulse.', 502);
    }
    throw error;
  }
}
