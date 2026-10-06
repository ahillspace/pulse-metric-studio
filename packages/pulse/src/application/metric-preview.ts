import { sanitizeProviderMessage, TableauError } from '@pulse-metric-studio/core';
import type { PulseMetricPreview, PulseMetricPreviewRequest } from '@pulse-metric-studio/shared';
import { getPulseDefinition, getPulseMetric } from '../pulse/pulse-client.js';
import { metricDefinitionId } from '../pulse/reconciliation.js';
import { generateMetricPreview, PulsePreviewDataError, PulsePreviewProviderError } from '../pulse/metric-preview.js';
import { requirePulseOwner } from './context.js';
import { PulseApplicationError } from './errors.js';

const MAX_METADATA_BYTES = 1024 * 1024;
export async function previewPulseMetric(metricId: string, request: PulseMetricPreviewRequest): Promise<PulseMetricPreview> {
  const session = requirePulseOwner(request.context);
  let metadataStage: 'metric' | 'definition' = 'metric';
  try {
    const metric = await getPulseMetric(session, metricId, MAX_METADATA_BYTES);
    requirePulseOwner(request.context, session);
    const actualMetricId = metric.id ?? metric.metadata?.id;
    const definitionId = metricDefinitionId(metric);
    if (actualMetricId !== metricId || !definitionId || ((metric.site_id ?? metric.site?.id) && (metric.site_id ?? metric.site?.id) !== session.siteId))
      throw new PulseApplicationError('pulse_preview_context_mismatch', 'This metric does not belong to the selected context.', 409);
    metadataStage = 'definition';
    const definition = await getPulseDefinition(session, definitionId, MAX_METADATA_BYTES);
    requirePulseOwner(request.context, session);
    if (definition.metadata?.id !== definitionId || definition.specification?.datasource?.id !== request.context.datasourceLuid)
      throw new PulseApplicationError('pulse_preview_context_mismatch', 'This metric does not belong to the selected datasource.', 409);
    const imageDataUrl = await generateMetricPreview(session, definition, metric, metricId, definitionId);
    requirePulseOwner(request.context, session);
    return { metricId, definitionId, name: definition.metadata.name ?? '', imageDataUrl, generatedAt: Date.now() };
  } catch (error) {
    const sanitize = (message: string) => sanitizeProviderMessage(session.token ? message.split(session.token).join('[redacted]') : message);
    if (error instanceof PulsePreviewDataError && error.insightError) {
      const code = sanitize(error.insightError.code ?? '').slice(0, 100);
      const message = sanitize(error.insightError.message ?? '');
      const detail = [code, message].filter(Boolean).join(': ');
      throw new PulseApplicationError(error.code, detail ? `${error.message} ${detail}` : error.message, 422,
        { stage: 'insights', kind: 'provider', code, message });
    }
    if (error instanceof PulsePreviewDataError)
      throw new PulseApplicationError(error.code, error.message, error.code === 'pulse_preview_unavailable' ? 422 : 502);
    const providerError = error instanceof PulsePreviewProviderError ? error.providerError : error;
    if (providerError instanceof TableauError) {
      const stage = error instanceof PulsePreviewProviderError ? error.stage : metadataStage;
      const rawMessage = [providerError.message, providerError.bodySnippet].filter(Boolean).join(' - ');
      const message = sanitize(rawMessage);
      const details = { stage, status: providerError.status, kind: providerError.kind, message };
      if (providerError.kind === 'auth') throw new PulseApplicationError('tableau_connection_required', 'Reconnect to Tableau to preview this metric.', 401, details);
      if (providerError.status === 404 && (stage === 'image' || stage === 'insights'))
        throw new PulseApplicationError('pulse_preview_unsupported', 'Metric card previews require Tableau Cloud with the metric image API.', 501, details);
      if (providerError.status === 403) throw new PulseApplicationError('pulse_preview_forbidden', 'You do not have permission to preview this metric.', 403, details);
      const label = { metric: 'metric lookup', definition: 'definition lookup', insights: 'insight generation', image: 'image generation' }[stage];
      throw new PulseApplicationError('pulse_preview_unavailable', `Tableau ${label} failed. ${message}`, 502, details);
    }
    throw error;
  }
}
