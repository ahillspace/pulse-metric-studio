import React from 'react';
import type { LlmAuthMode, LlmProfilePublic, LlmProtocol } from '@pulse-metric-studio/shared';

export const PROVIDER_CHOICES = [
  { id: 'codex', label: 'Codex account', access: 'Current Codex CLI account', description: 'Use your account signed in through the installed Codex CLI. Usage and charges follow your account settings.', protocol: 'codex-cli', authMode: 'local-account', baseUrl: '', command: 'codex', modelMode: 'manual' },
  { id: 'claude', label: 'Claude account', access: 'Current Claude Code account', description: 'Run your installed Claude Code with its signed-in account. Usage and charges follow your account settings, including enabled usage credits.', protocol: 'claude-code', authMode: 'local-account', baseUrl: '', command: 'claude', modelMode: 'manual' },
  { id: 'opencode', label: 'OpenCode', access: 'Configured accounts', description: 'Use accounts and models configured in OpenCode, including subscription access supported by OpenCode. Direct subscription sign-in is not available here.', protocol: 'opencode', authMode: 'none', baseUrl: '', command: 'opencode', modelMode: 'catalog' },
  { id: 'openai', label: 'OpenAI-compatible API', access: 'API key and endpoint', description: 'Use an OpenAI API key or a compatible API gateway. A ChatGPT subscription does not provide an API key.', protocol: 'openai-chat', authMode: 'bearer', baseUrl: 'https://api.openai.com/v1', command: '', modelMode: 'manual' },
  { id: 'anthropic', label: 'Anthropic API', access: 'API key', description: 'Use an Anthropic API key to access Claude models. API billing is separate from your Claude subscription.', protocol: 'anthropic-messages', authMode: 'x-api-key', baseUrl: 'https://api.anthropic.com/v1', command: '', modelMode: 'manual' },
  { id: 'bedrock', label: 'Amazon Bedrock', access: 'AWS credentials', description: 'Use an AWS profile or configured AWS credentials with access to your selected Bedrock model.', protocol: 'bedrock-converse', authMode: 'aws', baseUrl: '', command: '', modelMode: 'manual' },
] as const satisfies ReadonlyArray<{ id: string; label: string; access: string; description: string; protocol: LlmProtocol; authMode: LlmAuthMode; baseUrl: string; command: string; modelMode: 'catalog' | 'manual' }>;

export type ProviderChoice = typeof PROVIDER_CHOICES[number];

const PROTOCOL_CHOICES: Record<LlmProtocol, ProviderChoice> = {
  'codex-cli': PROVIDER_CHOICES[0],
  'claude-code': PROVIDER_CHOICES[1],
  opencode: PROVIDER_CHOICES[2],
  'openai-chat': PROVIDER_CHOICES[3],
  'openai-responses': PROVIDER_CHOICES[3],
  'anthropic-messages': PROVIDER_CHOICES[4],
  'bedrock-converse': PROVIDER_CHOICES[5],
};

export function providerChoice(protocol: LlmProtocol): ProviderChoice {
  return PROTOCOL_CHOICES[protocol];
}

const AUTH_ACCESS: Record<LlmAuthMode, string> = {
  aws: 'AWS credentials',
  bearer: 'Bearer token',
  'x-api-key': 'API key',
  none: 'No authentication',
  'local-account': 'Current CLI account',
};

/** Describes how a saved profile authenticates, which can differ from its provider's default. */
export function providerAccess(protocol: LlmProtocol, authMode: LlmAuthMode): string {
  const choice = providerChoice(protocol);
  return choice.command || authMode === choice.authMode ? choice.access : AUTH_ACCESS[authMode];
}

export function providerDescription(protocol: LlmProtocol, authMode: LlmAuthMode): string {
  if (protocol === 'bedrock-converse' && authMode === 'bearer') {
    return 'Use a Bedrock API key or a company gateway token with access to your selected Bedrock model.';
  }
  return providerChoice(protocol).description;
}

/** macOS text substitution turns typed quotes into curly quotes, which break JSON and shell commands. */
export function straightenQuotes(text: string): string {
  return text.replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'");
}

export function newProviderId(base: string, profiles: Pick<LlmProfilePublic, 'id'>[]): string {
  const used = new Set(profiles.map(profile => profile.id));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function ProviderSetupChoices({ onChoose }: { onChoose: (choice: ProviderChoice) => void }) {
  return <section className="llm-setup-choices" aria-labelledby="llm-setup-heading">
    <h2 id="llm-setup-heading">Choose an assistant provider</h2>
    <p className="section-hint">Use an installed CLI account or add an API provider. Sign in through the provider's own terminal tools.</p>
    <div className="llm-choice-grid">{PROVIDER_CHOICES.map(choice => <button type="button" className="llm-choice" key={choice.id} onClick={() => onChoose(choice)}>
      <strong>{choice.label}</strong><span>{choice.access}</span><small>{choice.description}</small>
    </button>)}</div>
  </section>;
}
