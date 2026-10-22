import { spawn } from 'node:child_process';
import { secretVault, SecretVaultError } from '../../secrets/vault.js';
import type { LlmSecretSource } from '../profiles.js';
import { LlmProviderError } from '../types.js';
import { collectProcessOutput, OWN_PROCESS_GROUP, ProcessOutputError } from './process-tree.js';

const CACHE_TTL_MS = 60_000;
const STDOUT_LIMIT_BYTES = 1_000_000;
const COMMAND_TIMEOUT_MS = 15_000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Desktop builds confirm every new credential command natively before it runs,
 * so a compromised WebView cannot save and run an arbitrary shell command.
 * Without an approver (browser development mode) commands run as configured.
 */
type CommandApprover = (command: string) => Promise<boolean>;
let approver: CommandApprover | null = null;
const approvedCommands = new Set<string>();

export function setCredentialCommandApprover(next: CommandApprover | null): void {
  approver = next;
  approvedCommands.clear();
}

async function assertApproved(command: string, provider: string, model: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!approver || approvedCommands.has(command)) return;
  const approve = approver;
  let approved: boolean;
  try {
    approved = await new Promise<boolean>((resolve, reject) => {
      const cancelled = () => { signal?.removeEventListener('abort', cancelled); reject(signal!.reason); };
      signal?.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(() => { signal?.throwIfAborted(); return approve(command); }).then(
        result => { signal?.removeEventListener('abort', cancelled); resolve(result); },
        error => { signal?.removeEventListener('abort', cancelled); reject(error); },
      );
      if (signal?.aborted) cancelled();
    });
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    throw new LlmProviderError({
      code: 'provider_authentication',
      message: 'The credential command could not be approved because the desktop credential service is unavailable.',
      provider,
      model,
      cause: error,
    });
  }
  if (!approved) {
    throw new LlmProviderError({
      code: 'provider_authentication',
      message: 'The credential command was not allowed to run. Test the connection again to approve it.',
      provider,
      model,
    });
  }
  approvedCommands.add(command);
}

export function clearCredentialCache(): void {
  cache.clear();
}

interface CredentialResolutionOptions {
  runner?: (command: string) => Promise<string>;
  now?: () => number;
  signal?: AbortSignal;
}

export async function resolveCredentialCommand(
  command: string,
  provider: string,
  model: string,
  options: CredentialResolutionOptions = {},
): Promise<string> {
  const { signal, now = Date.now } = options;
  signal?.throwIfAborted();
  const cached = cache.get(command);
  if (cached && cached.expiresAt > now()) return cached.value;
  await assertApproved(command, provider, model, signal);
  signal?.throwIfAborted();
  const runner = options.runner ?? ((value: string) => runCredentialCommand(value, COMMAND_TIMEOUT_MS, signal));
  const token = (await runner(command)).trim();
  signal?.throwIfAborted();
  if (!token) {
    throw new LlmProviderError({
      code: 'provider_authentication',
      message: 'The credential command produced no output.',
      provider,
      model,
    });
  }
  cache.set(command, { value: token, expiresAt: now() + CACHE_TTL_MS });
  return token;
}

interface ProfileCredentials {
  secret: LlmSecretSource | null;
  headers: Record<string, LlmSecretSource>;
  credentialCommand: LlmSecretSource | null;
}

/** Saved secrets are read from the vault only when a request needs them. */
export async function readProfileSecret(source: LlmSecretSource, what: string, provider: string, model: string): Promise<string> {
  if ('value' in source) return source.value;
  const vault = secretVault();
  try {
    return await vault.resolve(source.ref);
  } catch (error) {
    if (!(error instanceof SecretVaultError)) throw error;
    throw new LlmProviderError({
      code: error.code === 'not_found' ? 'provider_not_configured' : 'provider_unavailable',
      message: error.code === 'not_found' ? `The saved ${what} is missing from ${vault.location}. Enter it again in AI settings.` : error.message,
      provider,
      model,
      cause: error,
    });
  }
}

export async function resolveProfileSecret(
  profile: Pick<ProfileCredentials, 'secret' | 'credentialCommand'>,
  provider: string,
  model: string,
  options: CredentialResolutionOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  if (profile.credentialCommand) {
    const command = (await readProfileSecret(profile.credentialCommand, 'credential command', provider, model)).trim();
    if (command) return resolveCredentialCommand(command, provider, model, options);
  }
  return profile.secret ? (await readProfileSecret(profile.secret, 'API key', provider, model)).trim() : '';
}

export async function resolveProfileHeaders(
  profile: Pick<ProfileCredentials, 'headers'>,
  provider: string,
  model: string,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, source] of Object.entries(profile.headers)) {
    headers[name] = await readProfileSecret(source, `value for the ${name} header`, provider, model);
  }
  return headers;
}

/**
 * Credential commands run with the user's environment minus every app-internal
 * variable, so they cannot learn how to reach the credential broker.
 */
export function credentialCommandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !name.toUpperCase().startsWith('PULSE_METRIC_STUDIO_')),
  );
}

export async function runCredentialCommand(command: string, timeoutMs = COMMAND_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const child = spawn(command, {
    shell: true,
    windowsHide: true,
    stdio: 'pipe',
    detached: OWN_PROCESS_GROUP,
    env: credentialCommandEnv(),
  });
  let output;
  try {
    output = await collectProcessOutput(child, { input: '', timeoutMs, signal, maxBytes: STDOUT_LIMIT_BYTES });
  } catch (error) {
    signal?.throwIfAborted();
    const message = error instanceof ProcessOutputError && error.kind === 'timeout'
      ? 'The credential command timed out.'
      : error instanceof ProcessOutputError && error.kind === 'output_limit'
        ? 'The credential command produced too much output.'
        : 'The credential command could not run.';
    throw new LlmProviderError({ code: 'provider_authentication', message, provider: 'credential-command', model: '', cause: error });
  }
  if (output.code === 0) return output.stdout;
  // Both streams can contain credentials, including tokens echoed in diagnostics.
  throw new LlmProviderError({
    code: 'provider_authentication',
    message: `The credential command exited with code ${output.code ?? 'unknown'}.`,
    provider: 'credential-command', model: '',
  });
}
