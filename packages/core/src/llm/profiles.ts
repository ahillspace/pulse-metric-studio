import type { Db } from '../db/index.js';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { decryptSecret, encryptSecret } from '../db/crypto.js';
import type { LlmAuthMode, LlmHealthReasonCode, LlmProfilePublic, LlmProfileWrite, LlmProtocol } from '@pulse-metric-studio/shared';

const PROFILES_KEY = 'llm.profiles.v1';
const ACTIVE_PROVIDER_KEY = 'llm.provider';
const READINESS_KEY = 'llm.readiness.v1';
const READINESS_REASON_CODES = new Set<LlmHealthReasonCode>([
  'ready',
  'not_installed',
  'not_configured',
  'not_tested',
  'authentication_failed',
  'model_unavailable',
  'transport_failed',
  'provider_unavailable',
  'invalid_response',
]);

export interface StoredLlmProfile {
  id: string;
  label: string;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  authMode: LlmAuthMode;
  secret: string;
  headers: Record<string, string>;
  region: string;
  awsProfile: string;
  command: string;
  credentialCommand?: string;
  allowPrivateNetwork?: boolean;
  source: 'environment' | 'saved';
}

export interface LlmProfileStore {
  list(): StoredLlmProfile[];
  get(id: string): StoredLlmProfile | null;
  save(input: LlmProfileWrite): LlmProfilePublic;
  delete(id: string): void;
  publicList(): LlmProfilePublic[];
}

export interface LlmReadinessResult {
  fingerprint: string;
  outcome: 'success' | 'failure';
  timestamp: string;
  reasonCode: LlmHealthReasonCode;
  reason: string | null;
}

export interface StoredLlmReadiness {
  lastResult: LlmReadinessResult;
  lastSuccessfulFingerprint: string | null;
  lastSuccessfulAt: string | null;
}

export interface LlmRegistryStateStore {
  getActive(): string | null;
  setActive(id: string): void;
  getReadiness(id: string): StoredLlmReadiness | null;
  setReadiness(id: string, readiness: StoredLlmReadiness): void;
  deleteReadiness(id: string): void;
}

export class LlmProfileStoreError extends Error {
  readonly code = 'profile_store_corrupt';

  constructor() {
    super('Saved LLM provider profiles could not be read safely.');
    this.name = 'LlmProfileStoreError';
  }
}

export class EncryptedLlmProfileStore implements LlmProfileStore {
  constructor(private readonly db: () => Db = getDb) {}

  list(): StoredLlmProfile[] {
    const blob = getSetting(this.db(), PROFILES_KEY);
    if (!blob) return [];
    try {
      const parsed = JSON.parse(decryptSecret(blob));
      if (!Array.isArray(parsed) || !parsed.every(isStoredProfile)) throw new Error('Invalid profile storage.');
      return parsed;
    } catch {
      throw new LlmProfileStoreError();
    }
  }

  get(id: string): StoredLlmProfile | null {
    return this.list().find((profile) => profile.id === id) ?? null;
  }

  save(input: LlmProfileWrite): LlmProfilePublic {
    const profiles = this.list();
    const existing = profiles.find((profile) => profile.id === input.id);
    const secret = input.clearSecret ? '' : input.secret ?? existing?.secret ?? '';
    const headers = input.clearHeaders ? {} : input.headers === undefined ? existing?.headers ?? {} : input.headers;
    const saved: StoredLlmProfile = {
      id: input.id,
      label: input.label,
      protocol: input.protocol,
      baseUrl: input.baseUrl ?? '',
      model: input.model ?? '',
      authMode: input.authMode ?? 'none',
      secret,
      headers,
      region: input.region ?? '',
      awsProfile: input.awsProfile ?? '',
      command: input.command ?? '',
      credentialCommand: input.credentialCommand ?? existing?.credentialCommand ?? '',
      allowPrivateNetwork: input.allowPrivateNetwork ?? false,
      source: 'saved',
    };
    const next = profiles.filter((profile) => profile.id !== input.id);
    next.push(saved);
    setSetting(this.db(), PROFILES_KEY, encryptSecret(JSON.stringify(next)));
    return toPublicProfile(saved);
  }

  delete(id: string): void {
    const next = this.list().filter((profile) => profile.id !== id);
    setSetting(this.db(), PROFILES_KEY, next.length ? encryptSecret(JSON.stringify(next)) : '');
  }

  publicList(): LlmProfilePublic[] {
    return this.list().map(toPublicProfile);
  }
}

export class DbLlmRegistryStateStore implements LlmRegistryStateStore {
  constructor(private readonly db: () => Db = getDb) {}

  getActive(): string | null {
    return getSetting(this.db(), ACTIVE_PROVIDER_KEY);
  }

  setActive(id: string): void {
    setSetting(this.db(), ACTIVE_PROVIDER_KEY, id);
  }

  getReadiness(id: string): StoredLlmReadiness | null {
    return this.readReadiness()[id] ?? null;
  }

  setReadiness(id: string, readiness: StoredLlmReadiness): void {
    const records = this.readReadiness();
    records[id] = readiness;
    setSetting(this.db(), READINESS_KEY, JSON.stringify(records));
  }

  deleteReadiness(id: string): void {
    const records = this.readReadiness();
    if (!(id in records)) return;
    delete records[id];
    setSetting(this.db(), READINESS_KEY, JSON.stringify(records));
  }

  private readReadiness(): Record<string, StoredLlmReadiness> {
    const value = getSetting(this.db(), READINESS_KEY);
    if (!value) return {};
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, StoredLlmReadiness] => isStoredReadiness(entry[1])),
      );
    } catch {
      return {};
    }
  }
}

export function toPublicProfile(profile: StoredLlmProfile): LlmProfilePublic {
  return {
    id: profile.id,
    label: profile.label,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    authMode: profile.authMode,
    hasSecret: profile.secret.length > 0,
    secretHint: profile.secret ? profile.secret.length > 4 ? `...${profile.secret.slice(-4)}` : '[configured]' : null,
    headers: Object.fromEntries(Object.keys(profile.headers).map((name) => [name, '[configured]'])),
    region: profile.region,
    awsProfile: profile.awsProfile,
    command: profile.command,
    credentialCommand: profile.credentialCommand ?? '',
    allowPrivateNetwork: profile.allowPrivateNetwork ?? false,
    source: profile.source,
  };
}

function isStoredProfile(value: unknown): value is StoredLlmProfile {
  if (!value || typeof value !== 'object') return false;
  const profile = value as Partial<StoredLlmProfile>;
  return Boolean(
    profile.id
    && profile.label
    && profile.protocol
    && typeof profile.secret === 'string'
    && typeof profile.baseUrl === 'string'
    && typeof profile.model === 'string'
    && profile.headers
    && typeof profile.headers === 'object'
    && Object.values(profile.headers).every((header) => typeof header === 'string')
    && (profile.credentialCommand === undefined || typeof profile.credentialCommand === 'string'),
  );
}

function isStoredReadiness(value: unknown): value is StoredLlmReadiness {
  if (!value || typeof value !== 'object') return false;
  const readiness = value as Partial<StoredLlmReadiness>;
  const result = readiness.lastResult as Partial<LlmReadinessResult> | undefined;
  return Boolean(
    result
    && typeof result.fingerprint === 'string'
    && (result.outcome === 'success' || result.outcome === 'failure')
    && typeof result.timestamp === 'string'
    && typeof result.reasonCode === 'string'
    && READINESS_REASON_CODES.has(result.reasonCode as LlmHealthReasonCode)
    && (result.reason === null || typeof result.reason === 'string')
    && (readiness.lastSuccessfulFingerprint === null || typeof readiness.lastSuccessfulFingerprint === 'string')
    && (readiness.lastSuccessfulAt === null || typeof readiness.lastSuccessfulAt === 'string'),
  );
}
