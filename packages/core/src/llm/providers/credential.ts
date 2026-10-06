import { spawn } from 'node:child_process';
import { LlmProviderError, summarizeProcessError } from '../types.js';
import { killProcessTree, OWN_PROCESS_GROUP } from './process-tree.js';

const CACHE_TTL_MS = 60_000;
const STDOUT_LIMIT_BYTES = 1_000_000;
const STDERR_LIMIT_BYTES = 8_000;
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

async function assertApproved(command: string, provider: string, model: string): Promise<void> {
  if (!approver || approvedCommands.has(command)) return;
  let approved: boolean;
  try {
    approved = await approver(command);
  } catch (error) {
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

export async function resolveCredentialCommand(
  command: string,
  provider: string,
  model: string,
  runner: (command: string) => Promise<string> = runCredentialCommand,
  now: () => number = Date.now,
): Promise<string> {
  const cached = cache.get(command);
  if (cached && cached.expiresAt > now()) return cached.value;
  await assertApproved(command, provider, model);
  const token = (await runner(command)).trim();
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

export async function resolveProfileSecret(
  profile: { secret?: string; credentialCommand?: string },
  provider: string,
  model: string,
  runner: (command: string) => Promise<string> = runCredentialCommand,
  now: () => number = Date.now,
): Promise<string> {
  const command = profile.credentialCommand?.trim();
  if (command) return resolveCredentialCommand(command, provider, model, runner, now);
  return (profile.secret ?? '').trim();
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

export function runCredentialCommand(command: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: OWN_PROCESS_GROUP,
      env: credentialCommandEnv(),
    });
    let settled = false;
    let timedOut = false;
    // Own timer instead of spawn's timeout: that only signals the shell, not what it started.
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      fail(new LlmProviderError({
        code: 'provider_authentication',
        message: 'The credential command timed out.',
        provider: 'credential-command',
        model: '',
      }));
    }, timeoutMs);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const fail = (error: LlmProviderError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > STDOUT_LIMIT_BYTES) {
        killProcessTree(child);
        // SECURITY: never include stdout in an error message - it holds the token.
        fail(new LlmProviderError({
          code: 'provider_authentication',
          message: 'The credential command produced too much output.',
          provider: 'credential-command',
          model: '',
        }));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes >= STDERR_LIMIT_BYTES) return;
      stderrBytes += chunk.byteLength;
      stderrChunks.push(chunk);
    });

    child.on('error', (error) => {
      fail(new LlmProviderError({
        code: 'provider_authentication',
        message: 'The credential command could not run.',
        provider: 'credential-command',
        model: '',
        cause: error,
      }));
    });

    // 'close' (not 'exit') guarantees stdout has been fully consumed before we
    // read the token; 'exit' can fire while stdio is still flushing, truncating it.
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code === 0 && !timedOut) {
        settled = true;
        resolve(Buffer.concat(stdoutChunks).toString('utf8'));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, STDERR_LIMIT_BYTES);
      // SECURITY: only stderr is surfaced here; stdout carries the token and is never included.
      const detail = stderr.trim() ? ` ${summarizeProcessError(stderr)}` : '';
      fail(new LlmProviderError({
        code: 'provider_authentication',
        message: `The credential command exited with code ${code ?? 'unknown'}.${detail}`,
        provider: 'credential-command',
        model: '',
      }));
    });
  });
}
