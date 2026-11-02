export * from './pulse-enums.js';
export * from './field-catalog.js';
export * from './ops.js';
export * from './timeframes.js';
export * from './dimensional-fork.js';
export * from './llm-contracts.js';
export * from './local-launch-command.js';
export * from './pulse-contracts.js';
export * from './pulse-domain.js';
export * from './pulse-proposal.js';

/** Builder selection state - serialized to the drafts store. */
import type { Granularity } from './pulse-enums.js';
import type { UiAgg, UiNumberFormat, UiSentiment } from './pulse-enums.js';
import { allowedGranularitiesForMinimumDate } from './timeframes.js';

export interface MetricSelection {
  active: boolean;
  fieldId: string;
  fieldLabel: string;
  requiresUserAgg: boolean;
  aggregation: UiAgg | 'USER';
  cumulative: boolean;
  format: UiNumberFormat;
  sentiment: UiSentiment;
  name: string;
  description: string;
  timeDimensionFieldId: string | null;
  /** Minimum display granularity (maps to allowed_granularities). */
  minGranularity: '' | 'DAY' | 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR';
  /** Pulse data mode: flowing over time vs latest point-in-time snapshot. */
  temporality: 'OVER_TIME' | 'LATEST';
  /** Attributes manually edited by the user; LLM ops must not clobber these. */
  locks: string[];
}

export interface SlicerSelection {
  active: boolean;
  fieldId: string;
  fieldLabel: string;
}

export interface BuilderDraft {
  version: 1;
  datasourceLuid: string;
  datasourceName: string;
  digestAudience: string;
  digestAudienceLocked: boolean;
  groupFollow: boolean;
  metrics: Record<string, MetricSelection>;
  slicers: Record<string, SlicerSelection>;
  chat: Array<{ role: 'user' | 'assistant'; content: string; ts: number }>;
  updatedAt: number;
}

/** Per-metric payload the web app assembles before publish. */
export interface PublishMetricInput {
  metric: MetricSelection;
}

export function minGranularityToAllowed(g: MetricSelection['minGranularity']): Granularity[] {
  // Empty = unrestricted; pods accept an empty array as "all granularities".
  return allowedGranularitiesForMinimumDate(g || null);
}
