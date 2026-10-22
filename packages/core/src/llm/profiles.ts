import type { Db } from '../db/index.js';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { secretVault, type SecretVault } from '../secrets/vault.js';
import type { LlmAuthMode, LlmHealthReasonCode, LlmProfilePublic, LlmProfileWrite, LlmProtocol } from '@pulse-metric-studio/shared';

/** Profiles saved by releases before 0.1.2, until the saved-secrets migration moves them. */
export const LEGACY_PROFILES_KEY = 'llm.profiles.v1';
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

/**
 * A secret is a vault reference once saved. Environment profiles and edits
 * that are not saved yet hold the value itself.
 */
export type LlmSecretSource = { ref: string } | { value: string };

export interface StoredLlmProfile {
  id: string;
  label: string;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  authMode: LlmAuthMode;
  secret: LlmSecretSource | null;
  headers: Record<string, LlmSecretSource>;
  region: string;
  awsProfile: string;
  command: string;
  credentialCommand: LlmSecretSource | null;
  /** The executable's name only, kept beside the vault reference for display. */
  credentialCommandHint: string | null;
  allowPrivateNetwork?: boolean;
  source: 'environment' | 'saved';
}

export interface LlmProfileStore {
  list(): StoredLlmProfile[];
  /** Saves values into the vault and returns the profile as stored, by reference. */
  save(profile: StoredLlmProfile): Promise<StoredLlmProfile>;
  delete(id: string): Promise<void>;
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

/** Saved profiles are unreadable until the startup migration has moved them out of the legacy setting. */
export class LlmProfilesMigratingError extends Error {
  readonly statusCode = 503;

  constructor(location: string) {
    super(`Saved AI providers are moving to ${location}. Allow access when asked, or restart Pulse Metric Studio to try again.`);
    this.name = 'LlmProfilesMigratingError';
  }
}

interface ProfileRow {
  id: string;
  label: string;
  protocol: LlmProtocol;
  base_url: string;
  model: string;
  auth_mode: LlmAuthMode;
  secret_ref: string | null;
  header_refs_json: string;
  region: string;
  aws_profile: string;
  command: string;
  credential_command_ref: string | null;
  credential_command_hint: string | null;
  allow_private_network: number;
}

export class DbLlmProfileStore implements LlmProfileStore {
  constructor(
    private readonly db: () => Db = getDb,
    private readonly vault: () => SecretVault = secretVault,
  ) {}

  list(): StoredLlmProfile[] {
    if (getSetting(this.db(), LEGACY_PROFILES_KEY)) throw new LlmProfilesMigratingError(this.vault().location);
    const rows = this.db().prepare('SELECT * FROM llm_profiles ORDER BY created_at, id').all() as ProfileRow[];
    return rows.map(profileFromRow);
  }

  async save(profile: StoredLlmProfile): Promise<StoredLlmProfile> {
    const previous = this.row(profile.id);
    const created: string[] = [];
    let saved: StoredLlmProfile;
    try {
      const persist = async (source: LlmSecretSource | null): Promise<{ ref: string } | null> => {
        if (!source) return null;
        if ('ref' in source) return source;
        const ref = await this.vault().store(source.value);
        created.push(ref);
        return { ref };
      };
      const headers: Record<string, LlmSecretSource> = {};
      for (const [name, value] of Object.entries(profile.headers)) headers[name] = (await persist(value))!;
      saved = {
        ...profile,
        secret: await persist(profile.secret),
        headers,
        credentialCommand: await persist(profile.credentialCommand),
        source: 'saved',
      };
      const now = Date.now();
      this.db().prepare(
        `INSERT INTO llm_profiles (
           id, label, protocol, base_url, model, auth_mode, secret_ref, header_refs_json, region,
           aws_profile, command, credential_command_ref, credential_command_hint, allow_private_network,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label, protocol = excluded.protocol, base_url = excluded.base_url,
           model = excluded.model, auth_mode = excluded.auth_mode, secret_ref = excluded.secret_ref,
           header_refs_json = excluded.header_refs_json, region = excluded.region,
           aws_profile = excluded.aws_profile, command = excluded.command,
           credential_command_ref = excluded.credential_command_ref,
           credential_command_hint = excluded.credential_command_hint,
           allow_private_network = excluded.allow_private_network, updated_at = excluded.updated_at`,
      ).run(
        saved.id, saved.label, saved.protocol, saved.baseUrl, saved.model, saved.authMode,
        refOf(saved.secret), JSON.stringify(Object.fromEntries(Object.entries(saved.headers).map(([name, value]) => [name, refOf(value)]))),
        saved.region, saved.awsProfile, saved.command, refOf(saved.credentialCommand), saved.credentialCommandHint,
        saved.allowPrivateNetwork ? 1 : 0, now, now,
      );
    } catch (error) {
      await this.discard(created);
      throw error;
    }
    const kept = new Set(profileRefs(saved));
    await this.discard(previous ? profileRefs(profileFromRow(previous)).filter((ref) => !kept.has(ref)) : []);
    return saved;
  }

  async delete(id: string): Promise<void> {
    const previous = this.row(id);
    if (!previous) return;
    this.db().prepare('DELETE FROM llm_profiles WHERE id = ?').run(id);
    await this.discard(profileRefs(profileFromRow(previous)));
  }

  private row(id: string): ProfileRow | undefined {
    return this.db().prepare('SELECT * FROM llm_profiles WHERE id = ?').get(id) as ProfileRow | undefined;
  }

  /** A secret nothing references any more; failing to remove it never fails the user's change. */
  private async discard(refs: string[]): Promise<void> {
    for (const ref of refs) {
      try {
        await this.vault().delete(ref);
      } catch (error) {
        console.warn(`An unused saved secret could not be removed. ${error instanceof Error ? error.message : ''}`.trim());
      }
    }
  }
}

function refOf(source: LlmSecretSource | null): string | null {
  if (!source) return null;
  if (!('ref' in source)) throw new Error('Profile secrets must be saved before their profile.');
  return source.ref;
}

function profileRefs(profile: StoredLlmProfile): string[] {
  return [profile.secret, profile.credentialCommand, ...Object.values(profile.headers)]
    .flatMap((source) => (source && 'ref' in source ? [source.ref] : []));
}

function profileFromRow(row: ProfileRow): StoredLlmProfile {
  let headerRefs: unknown;
  try {
    headerRefs = JSON.parse(row.header_refs_json);
  } catch {
    throw new LlmProfileStoreError();
  }
  if (!headerRefs || typeof headerRefs !== 'object' || Array.isArray(headerRefs)
    || !Object.values(headerRefs).every((ref) => typeof ref === 'string' && ref)) {
    throw new LlmProfileStoreError();
  }
  return {
    id: row.id,
    label: row.label,
    protocol: row.protocol,
    baseUrl: row.base_url,
    model: row.model,
    authMode: row.auth_mode,
    secret: row.secret_ref ? { ref: row.secret_ref } : null,
    headers: Object.fromEntries(Object.entries(headerRefs as Record<string, string>).map(([name, ref]) => [name, { ref }])),
    region: row.region,
    awsProfile: row.aws_profile,
    command: row.command,
    credentialCommand: row.credential_command_ref ? { ref: row.credential_command_ref } : null,
    credentialCommandHint: row.credential_command_hint,
    allowPrivateNetwork: row.allow_private_network === 1,
    source: 'saved',
  };
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

/** Resolve omitted credentials within the same provider family and auth mode. */
export function resolveLlmProfile(input: LlmProfileWrite, existing?: StoredLlmProfile): StoredLlmProfile {
  const localAccount = input.protocol === 'codex-cli' || input.protocol === 'claude-code';
  const cli = localAccount || input.protocol === 'opencode';
  const authMode = localAccount ? 'local-account' : cli ? 'none' : input.authMode ?? 'none';
  const openAiFamily = ['openai-chat', 'openai-responses'];
  const sameFamily = existing && (existing.protocol === input.protocol || openAiFamily.includes(existing.protocol) && openAiFamily.includes(input.protocol));
  const previous = sameFamily && existing.authMode === authMode ? existing : undefined;
  const aws = input.protocol === 'bedrock-converse' && authMode === 'aws';
  const keepsCredentials = !cli && !aws;
  const command = !keepsCredentials || input.clearCredentialCommand
    ? null
    : input.credentialCommand === undefined
      ? previous ? { source: previous.credentialCommand, hint: previous.credentialCommandHint } : null
      : input.credentialCommand ? { source: { value: input.credentialCommand }, hint: credentialCommandHint(input.credentialCommand) } : null;
  return {
    id: input.id,
    label: input.label,
    protocol: input.protocol,
    baseUrl: cli ? '' : input.baseUrl ?? '',
    model: input.model?.trim() ?? '',
    authMode,
    secret: !keepsCredentials || input.clearSecret
      ? null
      : input.secret === undefined ? previous?.secret ?? null : input.secret ? { value: input.secret } : null,
    headers: !keepsCredentials || input.clearHeaders
      ? {}
      : input.headers
        ? Object.fromEntries(Object.entries(input.headers).map(([name, value]) => [name, { value }]))
        : previous?.headers ?? {},
    region: input.protocol === 'bedrock-converse' ? input.region ?? '' : '',
    awsProfile: aws ? input.awsProfile ?? '' : '',
    command: cli ? input.command ?? '' : '',
    credentialCommand: command?.source ?? null,
    credentialCommandHint: command?.source ? command.hint : null,
    allowPrivateNetwork: cli ? false : input.allowPrivateNetwork ?? false,
    source: 'saved',
  };
}

export function toPublicProfile(profile: StoredLlmProfile): LlmProfilePublic {
  return {
    id: profile.id,
    label: profile.label,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    model: profile.model,
    authMode: profile.authMode,
    hasSecret: profile.secret !== null,
    headers: Object.fromEntries(Object.keys(profile.headers).map((name) => [name, '[configured]'])),
    region: profile.region,
    awsProfile: profile.awsProfile,
    command: profile.command,
    hasCredentialCommand: profile.credentialCommand !== null,
    credentialCommandHint: profile.credentialCommand ? profile.credentialCommandHint : null,
    allowPrivateNetwork: profile.allowPrivateNetwork ?? false,
    source: profile.source,
  };
}

/** The executable's name only: arguments after it can carry client secrets. */
export function credentialCommandHint(command: string | undefined): string | null {
  const trimmed = command?.trim();
  if (!trimmed) return null;
  const first = trimmed.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  const executable = (first?.[1] ?? first?.[2] ?? first?.[3] ?? '').split(/[\\/]/).pop() ?? '';
  const name = executable.length > 40 ? `${executable.slice(0, 37)}...` : executable;
  return trimmed.length > (first?.[0].length ?? 0) ? `${name} ...` : name;
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
