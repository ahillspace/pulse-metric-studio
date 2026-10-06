import type { LlmModelOption } from '@pulse-metric-studio/shared';

export interface OpenCodeModelSelectOption extends LlmModelOption {
  unavailable: boolean;
}

export function buildOpenCodeModelOptions(
  catalog: LlmModelOption[],
  configuredModel: string,
): OpenCodeModelSelectOption[] {
  const current = configuredModel.trim();
  const options = catalog.map((model) => ({ ...model, unavailable: false }));
  if (!current || options.some((option) => option.id === current)) return options;
  return [
    { id: current, label: `${current} (currently configured, unavailable)`, unavailable: true },
    ...options,
  ];
}

export function isCurrentOpenCodeModel(catalog: LlmModelOption[], configuredModel: string): boolean {
  const current = configuredModel.trim();
  return Boolean(current && catalog.some((model) => model.id === current));
}

export function openCodeCatalogProfileId(
  existing: boolean,
  persistedProtocol: string | undefined,
  profileId: string,
): string | null {
  return existing && persistedProtocol === 'opencode' ? profileId : null;
}
