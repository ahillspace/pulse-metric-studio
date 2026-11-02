import type { LlmModelOption } from '@pulse-metric-studio/shared';

export interface ModelSelectOption extends LlmModelOption {
  unavailable: boolean;
}

export function buildModelOptions(
  catalog: LlmModelOption[],
  configuredModel: string,
): ModelSelectOption[] {
  const current = configuredModel.trim();
  const options = catalog.map((model) => ({ ...model, unavailable: false }));
  if (!current || options.some((option) => option.id === current)) return options;
  return [
    { id: current, label: `${current} (currently configured, unavailable)`, unavailable: true },
    ...options,
  ];
}

export function isCurrentModel(catalog: LlmModelOption[], configuredModel: string): boolean {
  const current = configuredModel.trim();
  return Boolean(current && catalog.some((model) => model.id === current));
}
