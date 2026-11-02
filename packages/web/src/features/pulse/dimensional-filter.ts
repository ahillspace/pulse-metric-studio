import type {
  DimensionalForkSummary,
  DimensionValuePage,
  FilterDimensionField,
} from '@pulse-metric-studio/shared';
import { DIMENSIONAL_FORK_LIMITS } from '@pulse-metric-studio/shared';

export const PULSE_DIMENSIONAL_FORK_VALUE_MODE_THRESHOLD = DIMENSIONAL_FORK_LIMITS.valueModeThreshold;

export type DimensionValueMode = 'fetch-all' | 'search-required';

/**
 * Decide how the value selector should behave for a dimension given its total
 * distinct-member count. At or below the threshold the entire domain is fetched
 * once (fetch-all); above it the selector requires server-side search.
 */
export function chooseValueMode(
  count: number,
  threshold: number = PULSE_DIMENSIONAL_FORK_VALUE_MODE_THRESHOLD,
): DimensionValueMode {
  return count <= threshold ? 'fetch-all' : 'search-required';
}

export type PulseFilterDimensionField = FilterDimensionField;
export type PulseDimensionValue = DimensionValuePage['values'][number];
export type PulseDimensionValuePage = DimensionValuePage;
export type PulseDimensionalForkSummary = DimensionalForkSummary;

export interface DomainToggleState {
  action: 'select' | 'deselect';
  disabled: boolean;
  reason?: string;
}

export function uniqueDimensionValues(values: PulseDimensionValue[]): PulseDimensionValue[] {
  const seen = new Set<string>();
  return values.filter((entry) => {
    if (seen.has(entry.key)) return false;
    seen.add(entry.key);
    return true;
  });
}

export function mergeDimensionValues(
  known: PulseDimensionValue[],
  incoming: PulseDimensionValue[],
): PulseDimensionValue[] {
  return uniqueDimensionValues([...known, ...incoming]);
}

/**
 * Compute the Select-all / Deselect-all toggle for the currently selectable set
 * of values. `values` is the full domain in fetch-all mode and the current
 * (capped) match set in search-required mode.
 *
 * In search-required mode Select-all is deliberately scoped to the current
 * complete match set: it is disabled whenever the matches are truncated (more
 * exist than are shown) so the user can never select an unbounded or partial
 * set. When enabled, it selects exactly the visible matches.
 */
export function domainToggleState(
  values: PulseDimensionValue[],
  selectedKeys: ReadonlySet<string>,
  options: { mode: DimensionValueMode; truncated: boolean },
): DomainToggleState {
  const complete = !options.truncated;
  const everyValueSelected = complete && values.length > 0 && values.every((entry) => selectedKeys.has(entry.key));
  if (everyValueSelected) return { action: 'deselect', disabled: false };

  if (options.truncated) {
    return {
      action: 'select',
      disabled: true,
      reason: options.mode === 'search-required'
        ? 'Select all is unavailable because more matches exist than are shown. Refine your search.'
        : 'Select all is unavailable because the complete value domain is not loaded.',
    };
  }
  if (values.length === 0) {
    return {
      action: 'select',
      disabled: true,
      reason: options.mode === 'search-required'
        ? 'Type to search for values to select.'
        : 'No values are available to select.',
    };
  }
  return { action: 'select', disabled: false };
}

export function applyDomainToggle(
  state: DomainToggleState,
  values: PulseDimensionValue[],
  selectedKeys: ReadonlySet<string>,
): Set<string> {
  if (state.disabled) return new Set(selectedKeys);
  return state.action === 'deselect' ? new Set() : new Set(values.map((entry) => entry.key));
}

export function selectedProviderValues(
  knownValues: PulseDimensionValue[],
  selectedKeys: ReadonlySet<string>,
): string[] {
  return knownValues.filter((entry) => selectedKeys.has(entry.key)).map((entry) => entry.value);
}

export function filterDimensionValues(values: PulseDimensionValue[], search: string): PulseDimensionValue[] {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return values;
  return values.filter((entry) => entry.label.toLocaleLowerCase().includes(query));
}
