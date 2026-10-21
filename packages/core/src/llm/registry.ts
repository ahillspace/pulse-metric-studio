import crypto from 'node:crypto';
import type {
  LlmHealthReasonCode,
  LlmModelCatalogResponse,
  LlmModelOption,
  LlmProfilePublic,
  LlmProfileWrite,
  LlmProtocol,
  LlmProviderStatus,
  LlmReadinessStatus,
  LlmStatusResponse,
} from '@pulse-metric-studio/shared';
import { config } from '../config.js';
import { BedrockProvider } from './providers/bedrock.js';
import { AnthropicProvider, HttpLlmProvider, OpenAiCompatProvider } from './providers/openai-compat.js';
import { OpencodeCliProvider } from './providers/opencode-cli.js';
import { CodexCliProvider } from './providers/codex-cli.js';
import { ClaudeCodeProvider } from './providers/claude-code.js';
import {
  DbLlmRegistryStateStore,
  EncryptedLlmProfileStore,
  type LlmProfileStore,
  type LlmReadinessResult,
  type LlmRegistryStateStore,
  type StoredLlmProfile,
  type StoredLlmReadiness,
  toPublicProfile,
  resolveLlmProfile,
} from './profiles.js';
import type { CompleteOptions, CompleteResult, LlmCompletionTracker, LlmProvider, LlmProviderHealth } from './types.js';
import { LlmProviderError } from './types.js';

export interface ProviderRegistryOptions {
  environment?: NodeJS.ProcessEnv;
  providers?: LlmProvider[];
  store?: LlmProfileStore;
  stateStore?: LlmRegistryStateStore;
  providerFactory?: (profile: StoredLlmProfile) => LlmProvider;
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
  private readonly environment: NodeJS.ProcessEnv;
  private readonly staticProviders: LlmProvider[] | null;
  private readonly store: LlmProfileStore;
  private readonly stateStore: LlmRegistryStateStore;
  private readonly providerFactory: (profile: StoredLlmProfile) => LlmProvider;
  private readonly now: () => Date;
  private readonly modelCatalogCache = new Map<string, { fingerprint: string; loadedAt: number; models: LlmModelOption[] }>();
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(options: ProviderRegistryOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.staticProviders = options.providers ?? null;
    this.store = options.store ?? new EncryptedLlmProfileStore();
    this.stateStore = options.stateStore ?? new DbLlmRegistryStateStore();
    this.providerFactory = options.providerFactory ?? providerForProfile;
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
      if (baseHealth.healthy === false && this.matchingReadiness(id, fingerprint)?.lastResult.outcome === 'success') {
        this.recordResult(id, fingerprint, 'failure', baseHealth.reasonCode, baseHealth.reason);
      }
      const localAccount = profile?.authMode === 'local-account';
      const readiness = this.matchingReadiness(id, fingerprint);
      const health = healthWithReadiness(baseHealth, localAccount && readiness?.lastResult.outcome === 'success' ? null : readiness);
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
      readiness: this.readinessStatus(active, activeStatus, fingerprint, activeProfile?.authMode === 'local-account'),
    };
  }

  async listProfiles(): Promise<LlmProfilePublic[]> {
    return this.publicProfiles();
  }

  async listModels(profileId: string): Promise<LlmModelCatalogResponse> {
    const profile = this.profiles().find((entry) => entry.id === profileId);
    if (!profile) throw new LlmModelCatalogError(`LLM provider profile "${profileId}" does not exist.`);
    return this.currentModels(profile, this.providerFactory(profile), true);
  }

  async listSetupModels(protocol: LlmProtocol = 'opencode', command?: string): Promise<LlmModelCatalogResponse> {
    const profile = this.setupProfile(protocol, command);
    return this.currentModels(profile, this.providerFactory(profile), true);
  }

  async setupStatus(protocol: LlmProtocol, command?: string): Promise<LlmProviderHealth> {
    const provider = this.providerFactory(this.setupProfile(protocol, command));
    return this.runOperation(signal => provider.getSetupHealth ? provider.getSetupHealth(signal) : providerHealth(provider, signal));
  }

  async saveProfile(input: LlmProfileWrite): Promise<LlmProfilePublic> {
    const before = this.profiles().find((profile) => profile.id === input.id);
    const beforeFingerprint = before ? this.profileFingerprint(input.id, before) : null;
    // Resolve preservation against the effective profile, which can come from
    // the environment rather than the encrypted store. Clear flags win here.
    const prospective = resolveLlmProfile(input, before);
    await this.assertCurrentModel(prospective, this.providerFactory(prospective), true);
    const saved = this.store.save(prospective);
    const after = this.profiles().find((profile) => profile.id === input.id);
    if (!after || beforeFingerprint !== this.profileFingerprint(input.id, after)) {
      this.stateStore.deleteReadiness(input.id);
    }
    return saved;
  }

  async deleteProfile(id: string): Promise<void> {
    const active = this.activePreference(await this.providers());
    this.store.delete(id);
    this.stateStore.deleteReadiness(id);
    this.modelCatalogCache.delete(id);
    if (active === id) this.stateStore.setActive('');
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
    if (!health.installed || !health.configured || health.healthy === false) throw healthError(id, health);
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
    if (!initial.installed || !initial.configured || initial.healthy === false) {
      this.recordResult(id, fingerprint, 'failure', initial.reasonCode, initial.reason);
      throw healthError(id, initial);
    }
    const publicProfile = this.publicProfiles().find((item) => item.id === id) ?? fallbackPublicProfile(provider, initial);
    try {
      const result = await this.complete(provider, {
        system: 'This is a connection test. Do not use tools or access files.',
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        maxTokens: 16,
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
    if (preference === 'auto') throw new LlmModelCatalogError('Automatic provider selection is no longer supported. Select a provider profile.');
    const requested = preference ?? this.activePreference(providers);
    const provider = providers.get(requested);
    if (!provider) {
      throw new LlmProviderError({ code: 'provider_not_configured', message: `LLM provider profile "${requested}" does not exist.`, provider: requested });
    }
    const profile = this.staticProviders ? undefined : this.profiles().find((entry) => entry.id === requested);
    const health = await this.checkedProviderHealth(provider, profile, true);
    if (!health.installed || !health.configured || health.healthy === false) throw healthError(requested, health);
    const fingerprint = this.profileFingerprint(requested, profile);
    return this.trackCompletions(provider, requested, fingerprint);
  }

  private async providers(): Promise<Map<string, LlmProvider>> {
    if (this.staticProviders) return new Map(this.staticProviders.map((provider) => [provider.id, provider]));
    return new Map(this.profiles().map((profile) => [profile.id, this.providerFactory(profile)]));
  }

  private profiles(): StoredLlmProfile[] {
    const profiles = new Map(environmentProfiles(this.environment).map((profile) => [profile.id, profile]));
    for (const profile of this.store.list()) profiles.set(profile.id, profile);
    return [...profiles.values()];
  }

  private publicProfiles(): LlmProfilePublic[] {
    if (this.staticProviders) return [];
    return this.profiles().map(toPublicProfile);
  }

  private activePreference(providers: Map<string, LlmProvider>): string {
    const configured = this.stateStore.getActive() ?? config.llm.providerPreference ?? 'opencode';
    if (configured !== 'auto') return configured;
    const migrated = providers.has('opencode') ? 'opencode' : '';
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
      credentialCommand: profile.credentialCommand ?? '',
      allowPrivateNetwork: profile.allowPrivateNetwork ?? false,
      source: profile.source,
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private matchingReadiness(id: string, fingerprint: string): StoredLlmReadiness | null {
    const readiness = this.stateStore.getReadiness(id);
    return readiness?.lastResult.fingerprint === fingerprint ? readiness : null;
  }

  private readinessStatus(id: string, provider: LlmProviderStatus | undefined, fingerprint: string, localAccount: boolean): LlmReadinessStatus {
    const readiness = this.matchingReadiness(id, fingerprint);
    if (!provider?.available || provider.healthy === false && provider.reasonCode !== 'not_tested') {
      return {
        state: 'red',
        providerId: id || null,
        message: provider?.reason ?? 'Select and configure an AI provider and model.',
        lastSuccessfulAt: readiness?.lastSuccessfulFingerprint === fingerprint ? readiness.lastSuccessfulAt : null,
      };
    }
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
    if (localAccount) {
      return { state: 'yellow', providerId: id, message: 'Last request succeeded, but this CLI does not expose account identity. Sign-in is checked before each request.', lastSuccessfulAt: readiness.lastSuccessfulAt };
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
      isConfigured: async () => (await this.runOperation(signal => providerHealth(provider, signal))).configured,
      getHealth: provider.getHealth ? signal => this.runOperation(innerSignal => provider.getHealth!(innerSignal), signal) : undefined,
      getSetupHealth: provider.getSetupHealth ? signal => this.runOperation(innerSignal => provider.getSetupHealth!(innerSignal), signal) : undefined,
      listModels: provider.listModels ? signal => this.runOperation(innerSignal => provider.listModels!(innerSignal), signal) : undefined,
      tracking,
      complete: async (options: CompleteOptions): Promise<CompleteResult> => {
        try {
          return await this.complete(provider, options);
        } catch (error) {
          const failure = failureHealth({ installed: true, configured: true, healthy: false, reasonCode: 'transport_failed', reason: null, resolvedModel: null }, error);
          this.recordResult(id, fingerprint, 'failure', failure.reasonCode, failure.reason);
          throw error;
        }
      },
    };
  }

  private setupProfile(protocol: LlmProtocol, command?: string): StoredLlmProfile {
    const commands = { opencode: this.environment.OPENCODE_BIN?.trim() || 'opencode', 'codex-cli': 'codex', 'claude-code': 'claude' };
    if (protocol !== 'opencode' && protocol !== 'codex-cli' && protocol !== 'claude-code') throw new LlmModelCatalogError('Setup checks require a local CLI protocol.');
    return resolveLlmProfile({ id: `${protocol}-setup`, label: protocol, protocol, model: '', command: command?.trim() || commands[protocol], authMode: protocol === 'opencode' ? 'none' : 'local-account' });
  }

  private async checkedProviderHealth(provider: LlmProvider, profile?: StoredLlmProfile, refreshCatalog = false): Promise<LlmProviderHealth> {
    const health = await this.runOperation(signal => providerHealth(provider, signal));
    if (!profile || !provider.listModels || !health.installed || !health.configured || health.healthy === false) return health;
    try {
      await this.assertCurrentModel(profile, provider, refreshCatalog);
      return health;
    } catch (error) {
      return { ...health, configured: false, healthy: false,
        reasonCode: error instanceof LlmModelCatalogError ? 'model_unavailable' : 'provider_unavailable',
        reason: error instanceof Error ? error.message : 'The provider model catalog could not be loaded.',
        resolvedModel: profile.model || null };
    }
  }

  private async assertCurrentModel(profile: StoredLlmProfile, provider: LlmProvider, refresh = false): Promise<void> {
    const model = profile.model.trim();
    if (!model) throw new LlmModelCatalogError(provider.listModels ? `Select a model from the current ${profile.label} model catalog.` : 'Enter an explicit model ID.');
    if (!provider.listModels) return;
    const catalog = await this.currentModels(profile, provider, refresh);
    if (!catalog.models.some(candidate => candidate.id === model)) throw new LlmModelCatalogError(`${profile.label} model "${model}" is not available in the current model catalog.`);
  }

  private async currentModels(profile: StoredLlmProfile, provider: LlmProvider, refresh: boolean): Promise<LlmModelCatalogResponse> {
    if (!provider.listModels) return { provider: profile.protocol, source: 'manual', selection: 'manual', models: [] };
    const fingerprint = this.profileFingerprint(profile.id, profile);
    const cached = this.modelCatalogCache.get(profile.id);
    let models = cached?.fingerprint === fingerprint && this.now().getTime() - cached.loadedAt < 60_000 && !refresh ? cached.models : undefined;
    if (!models) {
      models = await this.runOperation(signal => provider.listModels!(signal));
      this.modelCatalogCache.set(profile.id, { fingerprint, loadedAt: this.now().getTime(), models });
    }
    return { provider: profile.protocol, source: 'provider', selection: 'catalog', models };
  }

  private async complete(provider: LlmProvider, options: CompleteOptions): Promise<CompleteResult> {
    return this.runOperation(signal => provider.complete({ ...options, signal }), options.signal);
  }

  private async runOperation<T>(work: (signal: AbortSignal) => Promise<T>, requestSignal?: AbortSignal): Promise<T> {
    if (this.shutdown.signal.aborted) throw new LlmProviderError({ code: 'provider_unavailable', message: 'The AI provider registry is closed.' });
    const signal = requestSignal ? AbortSignal.any([requestSignal, this.shutdown.signal]) : this.shutdown.signal;
    signal.throwIfAborted();
    const pending = work(signal);
    this.pending.add(pending);
    try { return await pending; }
    finally { this.pending.delete(pending); }
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    await Promise.allSettled([...this.pending]);
  }

}

function environmentProfiles(environment: NodeJS.ProcessEnv): StoredLlmProfile[] {
  const explicit = (keys: string[]) => keys.some(key => Boolean(environment[key]?.trim()));
  const value = (key: string, fallback = '') => environment[key]?.trim() || fallback;
  const enabledFlag = (key: string) => ['1', 'true', 'yes'].includes(value(key).toLowerCase());
  const enabled: Record<string, boolean> = {
    opencode: explicit(['OPENCODE_MODEL']),
    bedrock: explicit(['BEDROCK_MODEL_ID', 'AWS_ENDPOINT_URL_BEDROCK', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_WEB_IDENTITY_TOKEN_FILE']) || environment.PULSE_METRIC_STUDIO_LLM_PROVIDER === 'bedrock',
    'openai-compat': explicit(['OPENAI_COMPAT_BASE_URL', 'OPENAI_COMPAT_API_KEY', 'OPENAI_COMPAT_MODEL']),
    anthropic: explicit(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']),
  };
  const profiles: StoredLlmProfile[] = [
    {
      id: 'opencode', label: 'OpenCode', protocol: 'opencode', baseUrl: '', model: value('OPENCODE_MODEL'),
      authMode: 'none', secret: '', headers: {}, region: '', awsProfile: '', command: value('OPENCODE_BIN', 'opencode'), source: 'environment',
      allowPrivateNetwork: false,
    },
    {
      id: 'bedrock', label: 'Amazon Bedrock', protocol: 'bedrock-converse', baseUrl: value('AWS_ENDPOINT_URL_BEDROCK'),
      model: value('BEDROCK_MODEL_ID', config.llm.bedrock.modelId), authMode: 'aws', secret: '', headers: {}, region: value('AWS_REGION', 'us-east-1'),
      awsProfile: value('AWS_PROFILE'), command: '', source: 'environment',
      allowPrivateNetwork: enabledFlag('BEDROCK_ALLOW_PRIVATE_NETWORK'),
    },
    {
      id: 'openai-compat', label: 'OpenAI-compatible API', protocol: 'openai-chat', baseUrl: value('OPENAI_COMPAT_BASE_URL'),
      model: value('OPENAI_COMPAT_MODEL'), authMode: 'bearer', secret: value('OPENAI_COMPAT_API_KEY'),
      headers: {}, region: '', awsProfile: '', command: '', source: 'environment',
      allowPrivateNetwork: enabledFlag('OPENAI_COMPAT_ALLOW_PRIVATE_NETWORK'),
    },
    {
      id: 'anthropic', label: 'Anthropic API', protocol: 'anthropic-messages', baseUrl: value('ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1'),
      model: value('ANTHROPIC_MODEL', config.llm.anthropic.model), authMode: 'x-api-key', secret: value('ANTHROPIC_API_KEY'),
      headers: {}, region: '', awsProfile: '', command: '', source: 'environment',
      allowPrivateNetwork: enabledFlag('ANTHROPIC_ALLOW_PRIVATE_NETWORK'),
    },
  ];
  return profiles.filter(profile => enabled[profile.id]);
}

function providerForProfile(profile: StoredLlmProfile): LlmProvider {
  if (profile.protocol === 'opencode') return new OpencodeCliProvider(profile);
  if (profile.protocol === 'codex-cli') return new CodexCliProvider(profile);
  if (profile.protocol === 'claude-code') return new ClaudeCodeProvider(profile);
  if (profile.protocol === 'bedrock-converse') return new BedrockProvider(profile);
  if (profile.protocol === 'openai-chat' && profile.id === 'openai-compat' && profile.source === 'environment') return new OpenAiCompatProvider(profile);
  if (profile.protocol === 'anthropic-messages' && profile.id === 'anthropic' && profile.source === 'environment') return new AnthropicProvider(profile);
  return new HttpLlmProvider(profile);
}

async function providerHealth(provider: LlmProvider, signal?: AbortSignal): Promise<LlmProviderHealth> {
  if (provider.getHealth) return provider.getHealth(signal);
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
  if (!readiness || !health.installed || !health.configured || health.healthy === false) return health;
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
    hasCredentialCommand: false,
    credentialCommandHint: null,
    allowPrivateNetwork: false,
    source: 'saved',
  };
}

function healthError(id: string, health: LlmProviderHealth): LlmProviderError {
  return new LlmProviderError({
    code: !health.installed ? 'provider_not_installed' : health.reasonCode === 'authentication_failed' ? 'provider_authentication' : health.configured ? 'provider_unavailable' : 'provider_not_configured',
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
