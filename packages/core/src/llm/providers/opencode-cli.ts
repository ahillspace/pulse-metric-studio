import { execFile, spawn } from 'node:child_process';
import { collectProcessOutput, OWN_PROCESS_GROUP, ProcessOutputError } from './process-tree.js';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import type { LlmModelOption } from '@pulse-metric-studio/shared';
import { config } from '../../config.js';
import type { StoredLlmProfile } from '../profiles.js';
import type { CompleteOptions, CompleteResult, LlmProviderHealth } from '../types.js';
import { LLM_REQUEST_TIMEOUT_MS, LlmProviderError, timeoutDescription } from '../types.js';

export interface OpencodeExecutable { file: string }
export interface OpencodeRuntime {
  resolve(command: string): Promise<OpencodeExecutable | null>;
  run(bin: OpencodeExecutable, args: string[], prompt: string, provider: string, model: string, timeoutMs?: number, signal?: AbortSignal): Promise<string>;
  listModels?(bin: OpencodeExecutable, args: string[], signal?: AbortSignal): Promise<string>;
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
    secret: '',
    headers: {},
    region: '',
    awsProfile: '',
    command: config.llm.opencode.bin,
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
    const bin = isAllowedOpenCodeCommand(command) ? await this.runtime.resolve(command) : null;
    signal?.throwIfAborted();
    return {
      installed: Boolean(bin), configured: Boolean(bin), healthy: bin ? null : false,
      reasonCode: bin ? 'not_tested' : 'not_installed',
      reason: bin ? 'OpenCode CLI is installed. Account access is checked by an explicit connection test.' : 'OpenCode CLI is not installed or is not directly executable.',
      resolvedModel: this.profile.model.trim() || null,
    };
  }

  async getHealth(signal?: AbortSignal): Promise<LlmProviderHealth> {
    signal?.throwIfAborted();
    const command = this.profile.command || 'opencode';
    if (!isAllowedOpenCodeCommand(command)) {
      return { installed: false, configured: false, healthy: false, reasonCode: 'not_installed', reason: 'The configured OpenCode command is not an opencode executable.', resolvedModel: null };
    }
    const bin = await this.runtime.resolve(command);
    signal?.throwIfAborted();
    if (!bin) {
      return { installed: false, configured: false, healthy: false, reasonCode: 'not_installed', reason: 'OpenCode CLI is not installed or is not directly executable.', resolvedModel: null };
    }
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
    if (!isAllowedOpenCodeCommand(command)) throw new LlmProviderError({ code: 'provider_execution', message: 'The configured OpenCode command is not allowed.', provider: this.id });
    const bin = await this.runtime.resolve(command);
    if (!bin) throw new LlmProviderError({ code: 'provider_not_installed', message: 'OpenCode CLI is not installed.', provider: this.id });
    const model = this.profile.model.trim() || this.resolvedModel;
    if (!model) {
      throw new LlmProviderError({
        code: 'provider_not_configured',
        message: 'Select an OpenCode model from the current model catalog.',
        provider: this.id,
      });
    }
    const prompt = renderPrompt(opts);
    const args = ['--pure', 'run', '--model', model];
    const stdout = await this.runtime.run(bin, args, prompt, this.id, model, opts.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS, opts.signal);
    return {
      text: stripAnsi(stdout),
      provider: this.id,
      model,
    };
  }

  async listModels(signal?: AbortSignal): Promise<LlmModelOption[]> {
    signal?.throwIfAborted();
    const command = this.profile.command || 'opencode';
    if (!isAllowedOpenCodeCommand(command)) {
      throw new LlmProviderError({ code: 'provider_execution', message: 'The configured OpenCode command is not allowed.', provider: this.id });
    }
    const bin = await this.runtime.resolve(command);
    if (!bin || !isAllowedOpenCodeCommand(bin.file)) {
      throw new LlmProviderError({ code: 'provider_not_installed', message: 'OpenCode CLI is not installed.', provider: this.id });
    }
    const args = ['--pure', 'models', '--verbose'];
    const output = this.runtime.listModels
      ? await this.runtime.listModels(bin, args, signal)
      : await runOpenCodeModelList(bin, args, undefined, signal);
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
  if (!isAllowedOpenCodeCommand(command)) return null;
  const candidates: string[] = [];
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) candidates.push(path.resolve(command));
  else candidates.push(...await where(command));
  const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : '';
  if (npmDir) {
    candidates.push(
      path.join(npmDir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
      path.join(npmDir, 'node_modules', 'opencode-ai', 'node_modules', 'opencode-windows-x64', 'bin', 'opencode.exe'),
      path.join(npmDir, 'node_modules', 'opencode-ai', 'node_modules', 'opencode-windows-x64-baseline', 'bin', 'opencode.exe'),
    );
  }
  if (process.platform !== 'win32') candidates.push('/usr/local/bin/opencode', '/opt/homebrew/bin/opencode');
  for (const candidate of [...new Set(candidates)]) {
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      if (process.platform !== 'win32' || /\.exe$/i.test(candidate)) return { file: candidate };
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

async function runOpenCode(bin: ResolveResult, args: string[], prompt: string, provider: string, model: string, timeoutMs = LLM_REQUEST_TIMEOUT_MS, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const deadline = Date.now() + timeoutMs;
  const isolatedCwd = path.join(config.dataDir, 'llm-workspace');
  fs.mkdirSync(isolatedCwd, { recursive: true });
  const childEnv = buildOpenCodeChildEnv(process.env);
  // Config inspection does not start MCP servers or submit a model request.
  const inherited = await readOpenCodeConfig(bin, childEnv, signal, Math.min(OPENCODE_MODEL_LIST_TIMEOUT_MS, deadline - Date.now()));
  const agent = `pulse-metric-studio-${randomUUID()}`;
  const requestEnv = buildOpenCodeRequestEnv(childEnv, inherited, agent);
  const effective = await readOpenCodeConfig(bin, requestEnv, signal, Math.min(OPENCODE_MODEL_LIST_TIMEOUT_MS, deadline - Date.now()));
  assertOpenCodeRequestConfig(effective, agent);
  signal?.throwIfAborted();
  if (deadline <= Date.now()) throw new LlmProviderError({ code: 'provider_timeout', message: `OpenCode did not respond within ${timeoutDescription(timeoutMs)}.`, provider, model, retryable: true });
  try {
    const child = spawn(bin.file, [...args, '--agent', agent], {
      cwd: isolatedCwd, shell: false, windowsHide: true, detached: OWN_PROCESS_GROUP,
      env: requestEnv, stdio: 'pipe',
    });
    const result = await collectProcessOutput(child, { input: prompt, timeoutMs: deadline - Date.now(), signal });
    if (result.code !== 0 || !result.stdout.trim()) {
      const failure = classifyOpenCodeFailure(result.stderr);
      throw new LlmProviderError({ code: failure.code, message: failure.reason ?? `OpenCode exited with code ${result.code ?? 'unknown'}.`, provider, model, retryable: failure.retryable, reference: failure.reference });
    }
    return result.stdout;
  } catch (error) {
    if (error instanceof LlmProviderError || (error instanceof Error && error.name === 'AbortError')) throw error;
    throw new LlmProviderError({
      code: error instanceof ProcessOutputError && error.kind === 'timeout' ? 'provider_timeout' : 'provider_execution',
      message: error instanceof ProcessOutputError && error.kind === 'timeout' ? `OpenCode did not respond within ${timeoutDescription(timeoutMs)}.` : 'OpenCode could not complete the request or exceeded its output limit.',
      provider, model, retryable: error instanceof ProcessOutputError && error.kind === 'timeout', cause: error,
    });
  }
}

async function runOpenCodeModelList(bin: ResolveResult, args: string[], env = buildOpenCodeChildEnv(process.env), signal?: AbortSignal, timeoutMs = OPENCODE_MODEL_LIST_TIMEOUT_MS): Promise<string> {
  signal?.throwIfAborted();
  if (timeoutMs <= 0) throw new LlmProviderError({ code: 'provider_timeout', message: 'OpenCode discovery timed out.', provider: 'opencode', retryable: true });
  const isolatedCwd = path.join(config.dataDir, 'llm-workspace');
  fs.mkdirSync(isolatedCwd, { recursive: true });
  try {
    const child = spawn(bin.file, args, { cwd: isolatedCwd, shell: false, windowsHide: true, detached: OWN_PROCESS_GROUP, env, stdio: 'pipe' });
    const result = await collectProcessOutput(child, { input: '', timeoutMs, signal, maxBytes: MAX_OPENCODE_MODEL_OUTPUT_BYTES });
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
  run: runOpenCode,
};

async function readOpenCodeConfig(bin: ResolveResult, env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs?: number): Promise<Record<string, unknown>> {
  const output = await runOpenCodeModelList(bin, ['--pure', 'debug', 'config'], env, signal, timeoutMs);
  try {
    const parsed: unknown = JSON.parse(output);
    if (isRecord(parsed)) return parsed;
  } catch {}
  throw openCodeConfigurationError();
}

function openCodeConfigurationError(): LlmProviderError {
  return new LlmProviderError({
    code: 'provider_execution',
    provider: 'opencode',
    message: 'OpenCode could not verify the app\'s tool restrictions. Update OpenCode and test the connection again.',
    retryable: false,
  });
}

/** Keep provider configuration while isolating the selected agent from inherited tool grants. */
export function buildOpenCodeRequestEnv(
  env: NodeJS.ProcessEnv,
  inherited: Record<string, unknown>,
  agent: string,
): NodeJS.ProcessEnv {
  const mcp = isRecord(inherited.mcp) ? inherited.mcp : {};
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...safeOpenCodeConfig(env.OPENCODE_CONFIG_CONTENT),
      share: 'disabled',
      // OpenCode run automatically rejects permission requests without --auto/--yolo.
      // Deny removes tool schemas and prevents some supported OpenCode models from responding.
      permission: { '*': 'ask' },
      agent: { [agent]: { mode: 'primary', permission: { '*': 'ask' } } },
      mcp: Object.fromEntries(Object.keys(mcp).map((name) => [name, { enabled: false }])),
    }),
  };
}

export function assertOpenCodeRequestConfig(config: Record<string, unknown>, agent: string): void {
  const agents = isRecord(config.agent) ? config.agent : {};
  const selected = isRecord(agents[agent]) ? agents[agent] : {};
  const permissions = isRecord(selected.permission) ? selected.permission : {};
  const mcp = isRecord(config.mcp) ? config.mcp : {};
  if (
    selected.mode !== 'primary'
    || selected.disable === true
    || selected.hidden === true
    || Object.keys(permissions).length !== 1
    || permissions['*'] !== 'ask'
    || Object.values(mcp).some((server) => !isRecord(server) || server.enabled !== false)
    || config.share !== 'disabled'
  ) throw openCodeConfigurationError();
}

export function buildOpenCodeChildEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const normalizeName = (name: string) => platform === 'win32' ? name.toUpperCase() : name;
  const exact = new Set([
    'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TMP', 'TEMP', 'HOME', 'USERPROFILE',
    'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'LANG', 'LC_ALL',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
  ].map(normalizeName));
  const prefixes = ['AWS_', 'AZURE_OPENAI_'];
  const child: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    const normalized = normalizeName(name);
    if (value !== undefined && (exact.has(normalized) || prefixes.some((prefix) => normalized.startsWith(prefix)))) child[name] = value;
  }
  child.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...safeOpenCodeConfig(source.OPENCODE_CONFIG_CONTENT),
    permission: { '*': 'deny' },
    share: 'disabled',
  });
  child.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  return child;
}

function safeOpenCodeConfig(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed.provider && typeof parsed.provider === 'object' ? { provider: parsed.provider } : {};
  } catch {
    return {};
  }
}

function isAllowedOpenCodeCommand(command: string): boolean {
  const normalized = command.replace(/\\/g, '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
  return basename === 'opencode' || basename === 'opencode.exe';
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
  if (/rate.?limit|quota|too many requests/.test(text)) return { code: 'provider_quota', retryable: true, reference };
  if (/timeout|timed out|deadline/.test(text)) return { code: 'provider_timeout', retryable: true, reference };
  if (/upstream|server error|service unavailable|bad gateway|gateway timeout|\b5\d\d\b/.test(text)) return { code: 'provider_unavailable', retryable: true, reference };
  return { code: 'provider_execution', retryable: true, reference };
}

function extractSafeReference(stderr: string): string | undefined {
  const match = stderr.match(/(?:"(?:ref|request[_-]?id)"\s*:\s*"|\b)(err_[a-z0-9_-]{6,160}|req_[a-z0-9_-]{6,160})/i);
  return match?.[1];
}
