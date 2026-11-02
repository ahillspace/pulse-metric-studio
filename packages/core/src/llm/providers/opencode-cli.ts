import { execFile, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { collectProcessOutput, OWN_PROCESS_GROUP, ProcessOutputError } from './process-tree.js';
import { buildLocalAgentEnv, localAgentCwd, resolveLaunchCommand } from './local-agent-runtime.js';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { LlmModelOption } from '@pulse-metric-studio/shared';
import { config } from '../../config.js';
import type { StoredLlmProfile } from '../profiles.js';
import type { CompleteOptions, CompleteResult, LlmProviderHealth } from '../types.js';
import { LLM_REQUEST_TIMEOUT_MS, LlmProviderError, timeoutDescription } from '../types.js';

export interface OpencodeExecutable { file: string; args?: string[] }
export interface OpencodeRuntime {
  resolve(command: string): Promise<OpencodeExecutable | null>;
  run?(bin: OpencodeExecutable, args: string[], prompt: string, provider: string, model: string, timeoutMs?: number, signal?: AbortSignal): Promise<string>;
  listModels?(bin: OpencodeExecutable, args: string[], signal?: AbortSignal): Promise<string>;
  spawn?(file: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
  env?: NodeJS.ProcessEnv;
}
const MAX_OPENCODE_MODEL_OUTPUT_BYTES = 1_000_000;
const OPENCODE_MODEL_LIST_TIMEOUT_MS = 15_000;
const resolvedBins = new Map<string, Promise<ResolveResult | null>>();
type ResolveResult = OpencodeExecutable;

function envProfile(): StoredLlmProfile {
  return {
    id: 'opencode',
    label: 'OpenCode CLI',
    protocol: 'opencode',
    baseUrl: '',
    model: config.llm.opencode.model,
    authMode: 'none',
    secret: null,
    headers: {},
    region: '',
    awsProfile: '',
    command: config.llm.opencode.bin,
    credentialCommand: null,
    credentialCommandHint: null,
    allowPrivateNetwork: false,
    source: 'environment',
  };
}

export class OpencodeCliProvider {
  readonly id: string;
  readonly label: string;
  private resolvedModel: string | null = null;

  constructor(
    private readonly profile: StoredLlmProfile = envProfile(),
    private readonly runtime: OpencodeRuntime = defaultRuntime,
  ) {
    this.id = profile.id;
    this.label = profile.label;
  }

  async isConfigured(): Promise<boolean> {
    return (await this.getHealth()).configured;
  }

  async getSetupHealth(signal?: AbortSignal): Promise<LlmProviderHealth> {
    signal?.throwIfAborted();
    const command = this.profile.command || 'opencode';
    let bin: OpencodeExecutable | null;
    try { bin = await resolveOpenCodeLaunch(command, this.runtime, this.id); }
    catch (error) {
      if (!(error instanceof LlmProviderError)) throw error;
      return { installed: false, configured: false, healthy: false, reasonCode: 'not_configured', reason: error.message, resolvedModel: this.profile.model.trim() || null };
    }
    signal?.throwIfAborted();
    return {
      installed: Boolean(bin), configured: Boolean(bin), healthy: bin ? null : false,
      reasonCode: bin ? 'not_tested' : 'not_installed',
      reason: bin ? 'OpenCode CLI is installed. Account access is checked by an explicit connection test.' : 'OpenCode launch command is invalid or its executable is unavailable.',
      resolvedModel: this.profile.model.trim() || null,
    };
  }

  async getHealth(signal?: AbortSignal): Promise<LlmProviderHealth> {
    signal?.throwIfAborted();
    const setup = await this.getSetupHealth(signal);
    if (!setup.installed || !setup.configured) return setup;
    this.resolvedModel = this.profile.model.trim() || null;
    if (!this.resolvedModel) {
      return {
        installed: true,
        configured: false,
        healthy: false,
        reasonCode: 'not_configured',
        reason: 'Select an OpenCode model from the current model catalog.',
        resolvedModel: null,
      };
    }
    return {
      installed: true,
      configured: true,
      healthy: null,
      reasonCode: 'not_tested',
      reason: 'OpenCode and its model are configured. Run a connection test to verify provider access.',
      resolvedModel: this.resolvedModel,
    };
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    opts.signal?.throwIfAborted();
    const command = this.profile.command || 'opencode';
    const bin = await resolveOpenCodeLaunch(command, this.runtime, this.id);
    if (!bin) throw new LlmProviderError({ code: 'provider_not_installed', message: 'OpenCode launch command is invalid or its executable is unavailable.', provider: this.id });
    const model = this.profile.model.trim() || this.resolvedModel;
    if (!model) {
      throw new LlmProviderError({
        code: 'provider_not_configured',
        message: 'Select an OpenCode model from the current model catalog.',
        provider: this.id,
      });
    }
    const prompt = renderPrompt(opts);
    const args = isNativeOpenCode(bin)
      ? ['run', ...(bin.args ?? []), '--format', 'json', '--title', 'Pulse Metric Studio', '--model', model]
      : [...(bin.args ?? []), 'run', '--format', 'json', '--title', 'Pulse Metric Studio', '--model', model];
    const stdout = this.runtime.run
      ? await this.runtime.run(bin, args, prompt, this.id, model, opts.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS, opts.signal)
      : await runOpenCode(bin, args, prompt, this.id, model, opts.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS, opts.signal, this.runtime);
    return {
      text: stripAnsi(stdout),
      provider: this.id,
      model,
    };
  }

  async listModels(signal?: AbortSignal): Promise<LlmModelOption[]> {
    signal?.throwIfAborted();
    const command = this.profile.command || 'opencode';
    const bin = await resolveOpenCodeLaunch(command, this.runtime, this.id);
    if (!bin) {
      throw new LlmProviderError({ code: 'provider_not_installed', message: 'OpenCode launch command is invalid or its executable is unavailable.', provider: this.id });
    }
    const args = isNativeOpenCode(bin)
      ? ['models', ...catalogOptions(bin.args ?? []), '--verbose']
      : [...(bin.args ?? []), 'models', '--verbose'];
    const output = this.runtime.listModels
      ? await this.runtime.listModels(bin, args, signal)
      : await runOpenCodeModelList(bin, args, this.runtime, signal);
    return parseOpenCodeVerboseModels(output);
  }
}

async function resolveBin(command: string): Promise<ResolveResult | null> {
  let pending = resolvedBins.get(command);
  if (!pending) {
    pending = findBin(command);
    resolvedBins.set(command, pending);
  }
  let resolved: ResolveResult | null = null;
  try {
    resolved = await pending;
    return resolved;
  } finally {
    if (!resolved && resolvedBins.get(command) === pending) resolvedBins.delete(command);
  }
}

async function findBin(command: string): Promise<ResolveResult | null> {
  const candidates: string[] = [];
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) candidates.push(path.resolve(command));
  else candidates.push(...await where(command));
  const nativeDefault = !command.includes('/') && !command.includes('\\') && /^opencode(?:\.exe)?$/i.test(command);
  const npmDir = nativeDefault && process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '';
  if (npmDir) {
    candidates.push(
      path.join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
      path.join(npmDir, 'node_modules', 'opencode-ai', 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe'),
      path.join(npmDir, 'node_modules', 'opencode-ai', 'node_modules', 'opencode-windows-x64-baseline', 'bin', 'opencode.exe'),
    );
  }
  if (nativeDefault && process.platform !== 'win32') candidates.push('/usr/local/bin/opencode', '/opt/homebrew/bin/opencode');
  for (const candidate of [...new Set(candidates)]) {
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      if (process.platform !== 'win32' || /\.(exe|com)$/i.test(candidate)) return { file: candidate };
    } catch {}
  }
  return null;
}

function where(command: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where.exe' : 'which', [command], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      resolve(error ? [] : stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
  });
}

async function runOpenCode(bin: ResolveResult, args: string[], prompt: string, provider: string, model: string, timeoutMs = LLM_REQUEST_TIMEOUT_MS, signal?: AbortSignal, runtime: OpencodeRuntime = defaultRuntime): Promise<string> {
  signal?.throwIfAborted();
  try {
    const result = await runOpenCodeProcess(bin, args, prompt, localAgentCwd(), buildOpenCodeChildEnv(runtime.env ?? process.env), timeoutMs, signal, runtime);
    return parseOpenCodeCompletion(result.stdout, result.stderr, result.code, provider, model);
  } catch (error) {
    if (error instanceof LlmProviderError || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new LlmProviderError({
      code: error instanceof ProcessOutputError && error.kind === 'timeout' ? 'provider_timeout' : 'provider_execution',
      message: error instanceof ProcessOutputError && error.kind === 'timeout' ? `OpenCode did not respond within ${timeoutDescription(timeoutMs)}.` : 'OpenCode could not complete the request or exceeded its output limit.',
      provider, model, retryable: error instanceof ProcessOutputError && error.kind === 'timeout', cause: error,
    });
  }
}

function runOpenCodeProcess(bin: ResolveResult, args: string[], input: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal | undefined, runtime: OpencodeRuntime, maxBytes?: number) {
  const child = (runtime.spawn ?? spawn)(bin.file, args, { cwd, env, shell: false, windowsHide: true, detached: OWN_PROCESS_GROUP, stdio: 'pipe' });
  return collectProcessOutput(child, { input, timeoutMs, signal, maxBytes });
}

/** JSON mode separates the final assistant answer from reasoning, tool output, and earlier steps. */
function parseOpenCodeCompletion(stdout: string, stderr: string, code: number | null, provider: string, model: string): string {
  const messages = new Map<string, string[]>();
  let finalMessageID: string | null = null;
  let invalid = false;
  let toolError = '';
  let errorText = '';
  for (const line of stripAnsi(stdout).split(/\r?\n/).filter((line) => line.trim())) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!isRecord(event)) continue;
    if (event.type === 'error') {
      const error = isRecord(event.error) ? event.error : {};
      const data = isRecord(error.data) ? error.data : {};
      errorText = typeof error.message === 'string' ? error.message : typeof data.message === 'string' ? data.message : 'OpenCode reported an error.';
    } else if (event.type === 'tool_use' && isRecord(event.part) && isRecord(event.part.state) && typeof event.part.state.error === 'string') {
      toolError = event.part.state.error;
    } else if (event.type === 'step_start') {
      finalMessageID = null;
      toolError = '';
    } else if (event.type === 'text' && isRecord(event.part) && typeof event.part.text === 'string') {
      if (typeof event.part.messageID !== 'string') { invalid = true; continue; }
      const parts = messages.get(event.part.messageID) ?? [];
      parts.push(event.part.text);
      messages.set(event.part.messageID, parts);
    } else if (event.type === 'step_finish' && isRecord(event.part)) {
      finalMessageID = event.part.reason === 'stop' && typeof event.part.messageID === 'string' ? event.part.messageID : null;
    }
  }
  if (code !== 0 || errorText) {
    const failure = classifyOpenCodeFailure(`${stderr}\n${errorText}\n${toolError}`);
    throw new LlmProviderError({ code: failure.code, message: failure.reason ?? `OpenCode could not complete the request (exit code ${code ?? 'unknown'}).`, provider, model, retryable: failure.retryable, reference: failure.reference });
  }
  // Native reconciliation can append text suffixes and tool results after step_finish.
  // Part IDs can change during reconciliation; assistant message IDs remain stable.
  const text = finalMessageID ? messages.get(finalMessageID)?.join('').trim() : '';
  if (invalid || !finalMessageID || !text) {
    const failure = classifyOpenCodeFailure(`${stderr}\n${toolError}`);
    throw new LlmProviderError({ code: failure.code, message: failure.reason ?? 'OpenCode did not return a completed assistant response. Check your launch command and OpenCode configuration, then retry.', provider, model, retryable: false });
  }
  return text;
}

async function runOpenCodeModelList(bin: ResolveResult, args: string[], runtime: OpencodeRuntime = defaultRuntime, signal?: AbortSignal, timeoutMs = OPENCODE_MODEL_LIST_TIMEOUT_MS): Promise<string> {
  signal?.throwIfAborted();
  if (timeoutMs <= 0) throw new LlmProviderError({ code: 'provider_timeout', message: 'OpenCode discovery timed out.', provider: 'opencode', retryable: true });
  try {
    const result = await runOpenCodeProcess(bin, args, '', catalogCwd(bin), buildOpenCodeChildEnv(runtime.env ?? process.env), timeoutMs, signal, runtime, MAX_OPENCODE_MODEL_OUTPUT_BYTES);
    if (result.code !== 0) {
      const failure = classifyOpenCodeFailure(result.stderr);
      throw new LlmProviderError({ code: failure.code, message: failure.reason ?? `OpenCode discovery exited with code ${result.code ?? 'unknown'}.`, provider: 'opencode', retryable: failure.retryable, reference: failure.reference });
    }
    return result.stdout;
  } catch (error) {
    if (error instanceof LlmProviderError || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new LlmProviderError({
      code: error instanceof ProcessOutputError && error.kind === 'timeout' ? 'provider_timeout' : 'provider_execution',
      message: error instanceof ProcessOutputError && error.kind === 'timeout' ? 'OpenCode discovery timed out.' : 'OpenCode discovery could not complete or exceeded its output limit.',
      provider: 'opencode', retryable: error instanceof ProcessOutputError && error.kind === 'timeout', cause: error,
    });
  }
}

export function parseOpenCodeVerboseModels(output: string): LlmModelOption[] {
  const text = stripAnsi(output);
  const headerPattern = /^([a-z0-9][a-z0-9._-]*)\/([^\s]+)[ \t]*\r?$/gim;
  const headers = [...text.matchAll(headerPattern)];
  const models = new Map<string, LlmModelOption>();

  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (!header[1] || !header[2] || header.index === undefined) continue;
    const id = `${header[1]}/${header[2]}`;
    if (id.length > 240 || models.has(id)) continue;
    const recordStart = header.index + header[0].length;
    const recordEnd = headers[index + 1]?.index ?? text.length;
    const parsed = parseFirstJsonObject(text.slice(recordStart, recordEnd));
    if (!isRecord(parsed)) continue;
    if (parsed.providerID !== header[1] || parsed.id !== header[2] || parsed.status === 'deprecated') continue;
    const label = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : header[2];
    if (label.length > 240) continue;
    models.set(id, { id, label });
  }

  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function parseFirstJsonObject(value: string): unknown {
  const start = value.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(value.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function renderPrompt(opts: CompleteOptions): string {
  const parts = [(opts.system ?? '').trim(), '', '--- conversation ---'];
  for (const message of opts.messages) parts.push(`${message.role.toUpperCase()}:`, message.content.trim(), '');
  return parts.join('\n');
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u001b\u009b][^m]*m/g, '');
}

const defaultRuntime: OpencodeRuntime = {
  resolve: resolveBin,
  spawn,
};

/** Keep native configuration and tool credentials without app-internal secrets. */
export function buildOpenCodeChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildLocalAgentEnv(source);
}

function isNativeOpenCode(bin: OpencodeExecutable): boolean {
  return /^opencode(?:\.exe)?$/i.test(bin.file.replace(/\\/g, '/').split('/').pop() ?? '');
}

async function resolveOpenCodeLaunch(command: string, runtime: OpencodeRuntime, provider: string): Promise<OpencodeExecutable | null> {
  let bin: OpencodeExecutable | null;
  try { bin = await resolveLaunchCommand(command, (file) => runtime.resolve(file)); }
  catch {
    throw new LlmProviderError({ code: 'provider_not_configured', provider, message: 'OpenCode launch command is invalid. Use an executable followed by options, and close each quoted value.', retryable: false });
  }
  if (bin && isNativeOpenCode(bin)) {
    const managed = new Set(['--format', '--model', '-m', '--title', '--command', '--help', '-h', '--version', '-v', '--interactive', '-i']);
    if ((bin.args ?? []).some((argument) => managed.has(argument.split('=')[0]!))) {
      throw new LlmProviderError({ code: 'provider_not_configured', provider, message: 'OpenCode launch options cannot replace the app\'s headless run, JSON output, or model selection.', retryable: false });
    }
  }
  return bin;
}

/** Run-only options belong after `run`; the catalog accepts only these global options. */
function catalogOptions(args: string[]): string[] {
  const result: string[] = [];
  const valued = new Set(['--agent', '--session', '-s', '--file', '-f', '--attach', '--password', '-p', '--username', '-u', '--dir', '--port', '--variant']);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (/^--(?:pure|print-logs)(?:=(?:true|false))?$/.test(argument) || /^--no-(?:pure|print-logs)$/.test(argument) || argument.startsWith('--log-level=')) result.push(argument);
    else if (argument === '--log-level' && args[index + 1] !== undefined) result.push(argument, args[++index]!);
    else if (valued.has(argument)) index += 1;
  }
  return result;
}

function catalogCwd(bin: OpencodeExecutable): string {
  if (!isNativeOpenCode(bin)) return localAgentCwd();
  const args = bin.args ?? [];
  if (args.some((argument) => argument === '--attach' || argument.startsWith('--attach='))) return localAgentCwd();
  let directory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--dir') directory = args[++index];
    else if (args[index]?.startsWith('--dir=')) directory = args[index]!.slice('--dir='.length);
  }
  return directory ? path.resolve(localAgentCwd(), directory) : localAgentCwd();
}

export function classifyOpenCodeFailure(stderr: string): {
  code: 'provider_authentication' | 'provider_quota' | 'provider_timeout' | 'provider_unavailable' | 'provider_execution';
  retryable: boolean;
  reference?: string;
  reason?: string;
} {
  const text = stripAnsi(stderr).toLowerCase();
  const reference = extractSafeReference(stderr);
  if (/free tier can only be used from within opencode/.test(text)) {
    return {
      code: 'provider_execution',
      retryable: false,
      reference,
      reason: 'OpenCode rejected this model request because of its launch configuration. Update OpenCode and test the connection again.',
    };
  }
  if (/unauthori[sz]ed|authentication|invalid api key|forbidden/.test(text)) return { code: 'provider_authentication', retryable: false, reference };
  if (/permission|requires approval|approval.{0,30}(?:required|rejected)|not granted|non.interactive/.test(text)) {
    return { code: 'provider_execution', retryable: false, reference, reason: 'OpenCode needs tool approval that is unavailable in this headless request. Adjust your launch command or OpenCode permissions, then retry.' };
  }
  if (/rate.?limit|quota|too many requests/.test(text)) return { code: 'provider_quota', retryable: true, reference };
  if (/timeout|timed out|deadline/.test(text)) return { code: 'provider_timeout', retryable: true, reference };
  if (/upstream|server error|service unavailable|bad gateway|gateway timeout|\b5\d\d\b/.test(text)) return { code: 'provider_unavailable', retryable: true, reference };
  return { code: 'provider_execution', retryable: true, reference };
}

function extractSafeReference(stderr: string): string | undefined {
  const match = stderr.match(/(?:"(?:ref|request[_-]?id)"\s*:\s*"|\b)(err_[a-z0-9_-]{6,160}|req_[a-z0-9_-]{6,160})/i);
  return match?.[1];
}
