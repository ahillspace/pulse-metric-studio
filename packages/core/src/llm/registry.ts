import crypto from 'node:crypto';
import type {
  LlmHealthReasonCode,
  LlmModelCatalogResponse,
  LlmModelOption,
  LlmProfilePublic,
  LlmProfileWrite,
  LlmProviderStatus,
  LlmReadinessStatus,
  LlmStatusResponse,
} from '@pulse-metric-studio/shared';
import { config } from '../config.js';
import { BedrockProvider } from './providers/bedrock.js';
import { AnthropicProvider, HttpLlmProvider, OpenAiCompatProvider } from './providers/openai-compat.js';
import { OpencodeCliProvider } from './providers/opencode-cli.js';
import {
  DbLlmRegistryStateStore,
  EncryptedLlmProfileStore,
  type LlmProfileStore,
  type LlmReadinessResult,
  type LlmRegistryStateStore,
  type StoredLlmProfile,
  type StoredLlmReadiness,
  toPublicProfile,
} from './profiles.js';
import type { CompleteOptions, CompleteResult, LlmCompletionTracker, LlmProvider, LlmProviderHealth } from './types.js';
import { LlmProviderError } from './types.js';

export interface ProviderRegistryOptions {
  providers?: LlmProvider[];
  store?: LlmProfileStore;
  stateStore?: LlmRegistryStateStore;
  opencodeModelLister?: (profile: StoredLlmProfile) => Promise<LlmModelOption[]>;
  now?: () => Date;
}

export class LlmModelCatalogError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'LlmModelCatalogError';
  }
}

export class ProviderRegistry {
  private readonly staticProviders: LlmProvider[] | null;
  private readonly store: LlmProfileStore;
  private readonly stateStore: LlmRegistryStateStore;
  private readonly opencodeModelLister: (profile: StoredLlmProfile) => Promise<LlmModelOption[]>;
  private readonly now: () => Date;
  private readonly modelCatalogCache = new Map<string, { fingerprint: string; loadedAt: number; models: LlmModelOption[] }>();

  constructor(options: ProviderRegistryOptions = {}) {
    this.staticProviders = options.providers ?? null;
    this.store = options.store ?? new EncryptedLlmProfileStore();
    this.stateStore = options.stateStore ?? new DbLlmRegistryStateStore();
    this.opencodeModelLister = options.opencodeModelLister
      ?? ((profile) => new OpencodeCliProvider(profile).listModels());
    this.now = options.now ?? (() => new Date());
  }

  async status(): Promise<LlmStatusResponse> {
    const providers = await this.providers();
    const profiles = this.staticProviders ? [] : this.profiles();
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    const publicById = new Map(profiles.map((profile) => [profile.id, toPublicProfile(profile)]));
    const status: Record<string, LlmProviderStatus> = {};

    for (const [id, provider] of providers) {
      const profile = profileById.get(id);
      const baseHealth = await this.checkedProviderHealth(provider, profile);
      const fingerprint = this.profileFingerprint(id, profile);
      const health = healthWithReadiness(baseHealth, this.matchingReadiness(id, fingerprint));
      const publicProfile = publicById.get(id) ?? fallbackPublicProfile(provider, health);
      status[id] = {
        ...publicProfile,
        ...health,
        available: baseHealth.installed && baseHealth.configured,
      };
    }

    const active = this.activePreference(providers);
    const activeProfile = profileById.get(active);
    const activeStatus = status[active];
    const fingerprint = this.profileFingerprint(active, activeProfile);
    return {
      active,
      resolvedProvider: activeStatus?.available ? active : null,
      providers: status,
      models: Object.fromEntries(Object.entries(status).map(([id, provider]) => [id, provider.resolvedModel])),
      readiness: this.readinessStatus(active, activeStatus, fingerprint),
    };
  }

  async listProfiles(): Promise<LlmProfilePublic[]> {
    return this.publicProfiles();
  }

  async listModels(profileId: string): Promise<LlmModelCatalogResponse> {
    const profile = this.profiles().find((entry) => entry.id === profileId);
    if (!profile) throw new LlmModelCatalogError(`LLM provider profile "${profileId}" does not exist.`);
    if (profile.protocol !== 'opencode') {
      throw new LlmModelCatalogError(`LLM provider profile "${profileId}" is not an OpenCode profile.`);
    }
    return {
      provider: 'opencode',
      source: 'opencode-cli-cache',
      models: await this.currentOpenCodeModels(profile, true),
    };
  }

  async saveProfile(input: LlmProfileWrite): Promise<LlmProfilePublic> {
    const before = this.profiles().find((profile) => profile.id === input.id);
    const beforeFingerprint = before ? this.profileFingerprint(input.id, before) : null;
    if (input.protocol === 'opencode') {
      await this.assertCurrentOpenCodeModel(this.prospectiveProfile(input, before), true);
    }
    const saved = this.store.save(input);
    const after = this.profiles().find((profile) => profile.id === input.id);
    if (!after || beforeFingerprint !== this.profileFingerprint(input.id, after)) {
      this.stateStore.deleteReadiness(input.id);
    }
    return saved;
  }

  async deleteProfile(id: string): Promise<void> {
    this.store.delete(id);
    this.stateStore.deleteReadiness(id);
    this.modelCatalogCache.delete(id);
    const providers = await this.providers();
    if (this.activePreference(providers) === id) {
      this.stateStore.setActive(providers.has('opencode') ? 'opencode' : providers.keys().next().value ?? 'opencode');
    }
  }

  async setActive(id: string): Promise<string> {
    if (id === 'auto') throw new LlmModelCatalogError('Automatic provider selection is no longer supported. Select a provider profile.');
    const providers = await this.providers();
    const provider = providers.get(id);
    if (!provider) {
      throw new LlmProviderError({ code: 'provider_not_configured', message: `LLM provider profile "${id}" does not exist.`, provider: id });
    }
    const profile = this.staticProviders ? undefined : this.profiles().find((entry) => entry.id === id);
    const health = await this.checkedProviderHealth(provider, profile, true);
    if (!health.installed || !health.configured) throw healthError(id, health);
    const previous = this.activePreference(providers);
    if (previous !== id) this.stateStore.deleteReadiness(id);
    this.stateStore.setActive(id);
    return id;
  }

  async testProfile(id: string): Promise<LlmProviderStatus> {
    const providers = await this.providers();
    const provider = providers.get(id);
    if (!provider) {
      throw new LlmProviderError({ code: 'provider_not_configured', message: `LLM provider profile "${id}" does not exist.`, provider: id });
    }
    const profile = this.staticProviders ? undefined : this.profiles().find((entry) => entry.id === id);
    const initial = await this.checkedProviderHealth(provider, profile, true);
    const fingerprint = this.profileFingerprint(id, profile);
    if (!initial.installed || !initial.configured) {
      this.recordResult(id, fingerprint, 'failure', initial.reasonCode, initial.reason);
      throw healthError(id, initial);
    }
    const publicProfile = this.publicProfiles().find((item) => item.id === id) ?? fallbackPublicProfile(provider, initial);
    try {
      const result = await provider.complete({
        system: 'This is a connection test. Do not use tools or access files.',
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        maxTokens: 16,
        temperature: 0,
      });
      if (result.text?.trim().toUpperCase() !== 'OK') {
        throw new LlmProviderError({
          code: 'invalid_model_output',
          message: 'The connection test did not return the expected OK response.',
          provider: id,
          model: result.model ?? initial.resolvedModel ?? undefined,
          retryable: false,
        });
      }
      const health: LlmProviderHealth = {
        installed: true,
        configured: true,
        healthy: true,
        reasonCode: 'ready',
        reason: null,
        resolvedModel: result.model ?? initial.resolvedModel,
      };
      this.recordResult(id, fingerprint, 'success', 'ready', null);
      return { ...publicProfile, ...health, available: true };
    } catch (error) {
      const failure = failureHealth(initial, error);
      this.recordResult(id, fingerprint, 'failure', failure.reasonCode, failure.reason);
      throw error;
    }
  }

  async pick(preference?: string): Promise<LlmProvider> {
    const providers = await this.providers();
    const requested = preference === 'auto'
      ? providers.has('opencode') ? 'opencode' : this.activePreference(providers)
      : preference ?? this.activePreference(providers);
    const provider = providers.get(requested);
    if (!provider) {
      throw new LlmProviderError({ code: 'provider_not_configured', message: `LLM provider profile "${requested}" does not exist.`, provider: requested });
    }
    const profile = this.staticProviders ? undefined : this.profiles().find((entry) => entry.id === requested);
    const health = await this.checkedProviderHealth(provider, profile, true);
    if (!health.installed || !health.configured) throw healthError(requested, health);
    const fingerprint = this.profileFingerprint(requested, profile);
    return this.trackCompletions(provider, requested, fingerprint);
  }

  private async providers(): Promise<Map<string, LlmProvider>> {
    if (this.staticProviders) return new Map(this.staticProviders.map((provider) => [provider.id, provider]));
    return new Map(this.profiles().map((profile) => [profile.id, providerForProfile(profile)]));
  }

  private profiles(): StoredLlmProfile[] {
    const profiles = new Map(environmentProfiles().map((profile) => [profile.id, profile]));
    for (const profile of this.store.list()) profiles.set(profile.id, profile);
    return [...profiles.values()];
  }

  private publicProfiles(): LlmProfilePublic[] {
    if (this.staticProviders) return [];
    return this.profiles().map(toPublicProfile);
  }

  private activePreference(providers: Map<string, LlmProvider>): string {
    const configured = this.stateStore.getActive() || config.llm.providerPreference || 'opencode';
    if (configured !== 'auto') return configured;
    const migrated = providers.has('opencode') ? 'opencode' : providers.keys().next().value ?? 'opencode';
    this.stateStore.setActive(migrated);
    return migrated;
  }

  private profileFingerprint(id: string, profile?: StoredLlmProfile): string {
    if (this.staticProviders || !profile) return `static:${id}`;
    const payload = {
      id: profile.id,
      label: profile.label,
      protocol: profile.protocol,
      baseUrl: profile.baseUrl,
      model: profile.model,
      authMode: profile.authMode,
      secret: profile.secret,
      headers: Object.fromEntries(Object.entries(profile.headers).sort(([left], [right]) => left.localeCompare(right))),
      region: profile.region,
      awsProfile: profile.awsProfile,
      command: profile.command,
      allowPrivateNetwork: profile.allowPrivateNetwork ?? false,
      source: profile.source,
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private matchingReadiness(id: string, fingerprint: string): StoredLlmReadiness | null {
    const readiness = this.stateStore.getReadiness(id);
    return readiness?.lastResult.fingerprint === fingerprint ? readiness : null;
  }

  private readinessStatus(id: string, provider: LlmProviderStatus | undefined, fingerprint: string): LlmReadinessStatus {
    if (!provider?.available) {
      return {
        state: 'red',
        providerId: id || null,
        message: provider?.reason ?? 'Select and configure an AI provider and model.',
        lastSuccessfulAt: null,
      };
    }
    const readiness = this.matchingReadiness(id, fingerprint);
    if (!readiness) {
      return {
        state: 'yellow',
        providerId: id,
        message: `${provider.label} is configured but has not succeeded with the current settings.`,
        lastSuccessfulAt: null,
      };
    }
    if (readiness.lastResult.outcome === 'failure') {
      return {
        state: 'red',
        providerId: id,
        message: readiness.lastResult.reason ?? `${provider.label} failed its latest request.`,
        lastSuccessfulAt: readiness.lastSuccessfulFingerprint === fingerprint ? readiness.lastSuccessfulAt : null,
      };
    }
    return {
      state: 'green',
      providerId: id,
      message: `${provider.label} succeeded with the current settings.`,
      lastSuccessfulAt: readiness.lastSuccessfulAt,
    };
  }

  private recordResult(
    id: string,
    fingerprint: string,
    outcome: LlmReadinessResult['outcome'],
    reasonCode: LlmHealthReasonCode,
    reason: string | null,
  ): void {
    const timestamp = this.now().toISOString();
    const previous = this.stateStore.getReadiness(id);
    this.stateStore.setReadiness(id, {
      lastResult: { fingerprint, outcome, timestamp, reasonCode, reason },
      lastSuccessfulFingerprint: outcome === 'success' ? fingerprint : previous?.lastSuccessfulFingerprint ?? null,
      lastSuccessfulAt: outcome === 'success' ? timestamp : previous?.lastSuccessfulAt ?? null,
    });
  }

  private trackCompletions(provider: LlmProvider, id: string, fingerprint: string): LlmProvider {
    let committed = false;
    const commitOnce = (record: () => void): void => {
      if (committed) return;
      committed = true;
      record();
    };
    const tracking: LlmCompletionTracker = {
      commitSuccess: () => commitOnce(() => this.recordResult(id, fingerprint, 'success', 'ready', null)),
      commitFailure: (reasonCode, reason) => commitOnce(() => this.recordResult(id, fingerprint, 'failure', reasonCode, reason)),
    };
    return {
      id: provider.id,
      label: provider.label,
      isConfigured: () => provider.isConfigured(),
      getHealth: provider.getHealth ? () => provider.getHealth!() : undefined,
      tracking,
      complete: async (options: CompleteOptions): Promise<CompleteResult> => {
        try {
          return await provider.complete(options);
        } catch (error) {
          const failure = failureHealth(await providerHealth(provider), error);
          this.recordResult(id, fingerprint, 'failure', failure.reasonCode, failure.reason);
          throw error;
        }
      },
    };
  }

  private prospectiveProfile(input: LlmProfileWrite, existing?: StoredLlmProfile): StoredLlmProfile {
    return {
      id: input.id,
      label: input.label,
      protocol: input.protocol,
      baseUrl: input.baseUrl ?? '',
      model: input.model?.trim() ?? '',
      authMode: input.authMode ?? 'none',
      secret: input.clearSecret ? '' : input.secret ?? existing?.secret ?? '',
      headers: input.clearHeaders ? {} : input.headers ?? existing?.headers ?? {},
      region: input.region ?? '',
      awsProfile: input.awsProfile ?? '',
      command: input.command ?? '',
      allowPrivateNetwork: input.allowPrivateNetwork ?? false,
      source: 'saved',
    };
  }

  private async checkedProviderHealth(
    provider: LlmProvider,
    profile?: StoredLlmProfile,
    refreshCatalog = false,
  ): Promise<LlmProviderHealth> {
    const health = await providerHealth(provider);
    if (profile?.protocol !== 'opencode' || !health.installed || !health.configured) return health;
    try {
      await this.assertCurrentOpenCodeModel(profile, refreshCatalog);
      return health;
    } catch (error) {
      return {
        installed: health.installed,
        configured: false,
        healthy: false,
        reasonCode: error instanceof LlmModelCatalogError ? 'model_unavailable' : 'provider_unavailable',
        reason: error instanceof Error ? error.message : 'The OpenCode model catalog could not be loaded.',
        resolvedModel: profile.model || null,
      };
    }
  }

  private async assertCurrentOpenCodeModel(profile: StoredLlmProfile, refreshCatalog = false): Promise<void> {
    const model = profile.model.trim();
    if (!model) throw new LlmModelCatalogError('Select an OpenCode model from the current model catalog.');
    const models = await this.currentOpenCodeModels(profile, refreshCatalog);
    if (!models.some((candidate) => candidate.id === model)) {
      throw new LlmModelCatalogError(`OpenCode model "${model}" is not available in the current model catalog.`);
    }
  }

  private async currentOpenCodeModels(profile: StoredLlmProfile, refresh: boolean): Promise<LlmModelOption[]> {
    const fingerprint = this.profileFingerprint(profile.id, profile);
    const cached = this.modelCatalogCache.get(profile.id);
    if (!refresh && cached?.fingerprint === fingerprint && this.now().getTime() - cached.loadedAt < 60_000) {
      return cached.models;
    }
    const models = await this.opencodeModelLister(profile);
    this.modelCatalogCache.set(profile.id, { fingerprint, loadedAt: this.now().getTime(), models });
    return models;
  }
}

function environmentProfiles(): StoredLlmProfile[] {
  return [
    {
      id: 'opencode', label: 'OpenCode CLI', protocol: 'opencode', baseUrl: '', model: config.llm.opencode.model,
      authMode: 'none', secret: '', headers: {}, region: '', awsProfile: '', command: config.llm.opencode.bin, source: 'environment',
      allowPrivateNetwork: false,
    },
    {
      id: 'bedrock', label: 'Amazon Bedrock Converse', protocol: 'bedrock-converse', baseUrl: config.llm.bedrock.endpointOverride,
      model: config.llm.bedrock.modelId, authMode: 'aws', secret: '', headers: {}, region: config.llm.bedrock.region,
      awsProfile: config.llm.bedrock.awsProfile, command: '', source: 'environment',
      allowPrivateNetwork: config.llm.bedrock.allowPrivateNetwork,
    },
    {
      id: 'openai-compat', label: 'OpenAI-compatible Chat Completions', protocol: 'openai-chat', baseUrl: config.llm.openaiCompat.baseUrl,
      model: config.llm.openaiCompat.model, authMode: 'bearer', secret: config.llm.openaiCompat.apiKey,
      headers: {}, region: '', awsProfile: '', command: '', source: 'environment',
      allowPrivateNetwork: config.llm.openaiCompat.allowPrivateNetwork,
    },
    {
      id: 'anthropic', label: 'Anthropic Messages', protocol: 'anthropic-messages', baseUrl: config.llm.anthropic.baseUrl,
      model: config.llm.anthropic.model, authMode: 'x-api-key', secret: config.llm.anthropic.apiKey,
      headers: {}, region: '', awsProfile: '', command: '', source: 'environment',
      allowPrivateNetwork: config.llm.anthropic.allowPrivateNetwork,
    },
  ];
}

function providerForProfile(profile: StoredLlmProfile): LlmProvider {
  if (profile.protocol === 'opencode') return new OpencodeCliProvider(profile);
  if (profile.protocol === 'bedrock-converse') return new BedrockProvider(profile);
  if (profile.protocol === 'openai-chat' && profile.id === 'openai-compat' && profile.source === 'environment') return new OpenAiCompatProvider(profile);
  if (profile.protocol === 'anthropic-messages' && profile.id === 'anthropic' && profile.source === 'environment') return new AnthropicProvider(profile);
  return new HttpLlmProvider(profile);
}

async function providerHealth(provider: LlmProvider): Promise<LlmProviderHealth> {
  if (provider.getHealth) return provider.getHealth();
  const configured = await provider.isConfigured();
  return {
    installed: configured,
    configured,
    healthy: configured ? null : false,
    reasonCode: configured ? 'not_tested' : 'not_configured',
    reason: configured ? 'Run a connection test to verify provider access.' : 'The provider is not configured.',
    resolvedModel: null,
  };
}

function healthWithReadiness(health: LlmProviderHealth, readiness: StoredLlmReadiness | null): LlmProviderHealth {
  if (!readiness) return health;
  if (readiness.lastResult.outcome === 'success') {
    return { ...health, healthy: true, reasonCode: 'ready', reason: null };
  }
  return {
    ...health,
    healthy: false,
    reasonCode: readiness.lastResult.reasonCode,
    reason: readiness.lastResult.reason,
  };
}

function fallbackPublicProfile(provider: LlmProvider, health: LlmProviderHealth): LlmProfilePublic {
  return {
    id: provider.id,
    label: provider.label,
    protocol: 'opencode',
    baseUrl: '',
    model: health.resolvedModel ?? '',
    authMode: 'none',
    hasSecret: false,
    secretHint: null,
    headers: {},
    region: '',
    awsProfile: '',
    command: '',
    credentialCommand: '',
    allowPrivateNetwork: false,
    source: 'saved',
  };
}

function healthError(id: string, health: LlmProviderHealth): LlmProviderError {
  return new LlmProviderError({
    code: health.installed ? 'provider_not_configured' : 'provider_not_installed',
    message: health.reason ?? `LLM provider "${id}" is unavailable.`,
    provider: id,
    model: health.resolvedModel,
  });
}

function failureHealth(initial: LlmProviderHealth, error: unknown): LlmProviderHealth {
  const reasonCode: LlmHealthReasonCode = error instanceof LlmProviderError
    ? error.code === 'provider_authentication'
      ? 'authentication_failed'
      : error.code === 'provider_not_installed'
        ? 'not_installed'
        : error.code === 'provider_not_configured'
          ? 'not_configured'
          : error.code === 'invalid_provider_response' || error.code === 'invalid_model_output'
            ? 'invalid_response'
            : 'transport_failed'
    : 'transport_failed';
  return {
    ...initial,
    healthy: false,
    reasonCode,
    reason: error instanceof LlmProviderError ? error.message : 'The provider request failed.',
  };
}

let defaultRegistry: ProviderRegistry | null = null;
export function getLlmRegistry(): ProviderRegistry {
  defaultRegistry ??= new ProviderRegistry();
  return defaultRegistry;
}

export async function pickLlmProvider(preference?: string): Promise<LlmProvider> {
  return getLlmRegistry().pick(preference);
}
