import { PNG } from 'pngjs';
import { postJson, TableauError, type TableauSession } from '@pulse-metric-studio/core';
import type { PulseDefinition, PulseExactMetric } from './pulse-client.js';
import { metricSpecification } from './reconciliation.js';

const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES = 6 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export class PulsePreviewDataError extends Error {
  constructor(
    public readonly code: 'pulse_preview_unavailable' | 'pulse_preview_invalid_response' | 'pulse_preview_too_large',
    message: string,
    public readonly insightError?: { code?: string; message?: string },
  ) {
    super(message);
  }
}
export class PulsePreviewProviderError extends Error {
  constructor(public readonly stage: 'insights' | 'image', public readonly providerError: TableauError) {
    super(providerError.message, { cause: providerError });
  }
}
async function previewRequest<T>(stage: 'insights' | 'image', request: () => Promise<T>): Promise<T> {
  try { return await request(); }
  catch (error) {
    if (error instanceof TableauError) throw new PulsePreviewProviderError(stage, error);
    throw error;
  }
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = (message: string): never => { throw new PulsePreviewDataError('pulse_preview_unavailable', message); };

export function previewInsightInput(definition: PulseDefinition, metric: PulseExactMetric, metricId: string, definitionId: string) {
  const source = definition as unknown as Record<string, unknown>;
  const specification = metricSpecification(metric);
  if (!definition.metadata?.name || !definition.specification || !specification
      || !record(specification.measurement_period) || !Array.isArray(specification.filters))
    return unavailable('Tableau did not return the metadata needed to preview this metric.');
  if (!record(source.extension_options) || !record(source.representation_options) || !record(source.insights_options))
    return unavailable('Tableau did not return the definition settings needed to preview this metric.');
  return {
    bundle_request: {
      version: '1',
      input: {
        metadata: { metric_id: metricId, definition_id: definitionId, name: definition.metadata.name },
        metric: {
          definition: definition.specification,
          metric_specification: specification,
          extension_options: source.extension_options,
          representation_options: source.representation_options,
          insights_options: source.insights_options,
        },
      },
      options: { language: 'LANGUAGE_EN_US', locale: 'LOCALE_EN_US', output_format: 'OUTPUT_FORMAT_HTML' },
    },
  };
}

export function previewCardInput(definition: PulseDefinition, metric: PulseExactMetric, bundle: unknown) {
  const response = record(bundle) && bundle.bundle_response;
  if (record(response) && record(response.error)) {
    const error = response.error;
    throw new PulsePreviewDataError('pulse_preview_unavailable', 'Tableau could not generate insights for this metric.', {
      ...(typeof error.code === 'string' || typeof error.code === 'number' ? { code: String(error.code) } : {}),
      ...(typeof error.message === 'string' ? { message: error.message } : {}),
    });
  }
  if (!record(response) || response.error || !record(response.result))
    return unavailable('Tableau could not generate insights for this metric.');
  const groups = response.result.insight_groups;
  if (!Array.isArray(groups)) return unavailable('Tableau has no insights available for this metric.');
  const insights: Record<string, unknown>[] = [];
  for (const group of groups) {
    if (!record(group) || group.error || !Array.isArray(group.insights)) continue;
    for (const entry of group.insights) {
      if (!record(entry) || entry.error || entry.skip_details || !record(entry.result)) continue;
      const insight = entry.result;
      if (typeof insight.type !== 'string' || typeof insight.markup !== 'string'
          || !record(insight.facts) || typeof insight.score !== 'number'
          || !Number.isFinite(insight.score) || insight.score < 0) continue;
      insights.push(insight);
    }
  }
  const period = insights.filter((insight) => insight.type === 'popc');
  if (period.length !== 1 || !record(period[0]!.viz) || !Object.keys(period[0]!.viz as object).length)
    return unavailable('Tableau has no unambiguous period comparison chart available for this metric.');
  // The preview shows the highest scored successful supporting insight. Provider order breaks ties.
  const top = insights.filter((insight) => insight.type !== 'popc')
    .sort((a, b) => Number(b.score) - Number(a.score))[0];
  if (!top) return unavailable('Tableau has no supporting insight available for this metric card.');
  const specification = metricSpecification(metric)!;
  return {
    input: {
      metricMetadata: {
        definitionName: definition.metadata!.name,
        measurementPeriod: specification.measurement_period,
        filters: specification.filters,
      },
      viz: period[0]!.viz,
      insights: {
        popc: { markup: period[0]!.markup, facts: period[0]!.facts },
        top: { markup: top.markup, facts: top.facts },
      },
    },
    settings: { scale: 'METRIC_CARD_IMAGE_SCALE_CSS', language: 'en-US', theme: 'THEME_DARK', width: 420 },
  };
}

export function previewPngDataUrl(value: unknown): string {
  if (!record(value) || typeof value.content !== 'string')
    throw new PulsePreviewDataError('pulse_preview_invalid_response', 'Tableau returned an invalid preview image.');
  const content = value.content;
  if (content.length > Math.ceil(MAX_PNG_BYTES / 3) * 4)
    throw new PulsePreviewDataError('pulse_preview_too_large', 'The metric preview image is too large to display.');
  if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content))
    throw new PulsePreviewDataError('pulse_preview_invalid_response', 'Tableau returned an invalid preview image.');
  const png = Buffer.from(content, 'base64');
  if (png.length < 45 || png.length > MAX_PNG_BYTES || png.toString('base64') !== content
      || !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.readUInt32BE(8) !== 13
      || png.toString('ascii', 12, 16) !== 'IHDR' || png.toString('ascii', png.length - 8, png.length - 4) !== 'IEND')
    throw new PulsePreviewDataError('pulse_preview_invalid_response', 'Tableau returned an invalid PNG preview.');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 8_000_000)
    throw new PulsePreviewDataError('pulse_preview_too_large', 'The metric preview dimensions are too large to display.');
  if (png[28] !== 0)
    return unavailable('This metric preview uses an unsupported interlaced image encoding. View it in Pulse.');
  // Resource preflight prevents a later IHDR from bypassing the dimensions/interlace guard.
  // pngjs performs decoding and CRC checks.
  let offset = 8;
  let headers = 0;
  let imageDataBytes = 0;
  while (offset < png.length) {
    if (offset + 12 > png.length)
      throw new PulsePreviewDataError('pulse_preview_invalid_response', 'Tableau returned a truncated PNG preview.');
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (length > png.length - offset - 12 || (type === 'IHDR' && ++headers !== 1)
        || (type === 'IEND' && offset + length + 12 !== png.length))
      throw new PulsePreviewDataError('pulse_preview_invalid_response', 'Tableau returned an invalid PNG preview.');
    if (type === 'IDAT') imageDataBytes += length;
    offset += length + 12;
  }
  if (imageDataBytes === 0)
    throw new PulsePreviewDataError('pulse_preview_invalid_response', 'Tableau returned a PNG preview without image data.');
  try {
    PNG.sync.read(png, { checkCRC: true });
  } catch {
    throw new PulsePreviewDataError('pulse_preview_invalid_response', 'Tableau returned an invalid PNG preview.');
  }
  return `data:image/png;base64,${content}`;
}

function boundedRequest(value: unknown): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_BUNDLE_BYTES)
    throw new PulsePreviewDataError('pulse_preview_too_large', 'The metric preview data exceeds the supported size.');
  return json;
}
export async function generateMetricPreview(session: TableauSession, definition: PulseDefinition, metric: PulseExactMetric, metricId: string, definitionId: string): Promise<string> {
  const bundle = await previewRequest('insights', () => postJson<unknown>(session, '/api/-/pulse/insights/springboard',
    boundedRequest(previewInsightInput(definition, metric, metricId, definitionId)), {
      contentType: 'application/vnd.tableau.pulse.insightsservice.v1.GenerateInsightBundleSpringboardRequest+json',
      accept: 'application/vnd.tableau.pulse.insightsservice.v1.GenerateInsightBundleSpringboardResponse+json',
      maxResponseBytes: MAX_BUNDLE_BYTES,
    }));
  const image = await previewRequest('image', () => postJson<unknown>(session, '/api/-/pulse/images/metricCard',
    boundedRequest(previewCardInput(definition, metric, bundle)), {
      contentType: 'application/vnd.tableau.imageservice.v1.GenerateMetricCardImageRequest+json',
      accept: 'application/vnd.tableau.imageservice.v1.GenerateMetricCardImageResponse+json',
      maxResponseBytes: MAX_IMAGE_RESPONSE_BYTES,
    }));
  return previewPngDataUrl(image);
}
