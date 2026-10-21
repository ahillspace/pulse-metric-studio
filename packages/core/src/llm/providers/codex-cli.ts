import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StoredLlmProfile } from '../profiles.js';
import type { CompleteOptions, CompleteResult, LlmProvider, LlmProviderHealth } from '../types.js';
import { LLM_REQUEST_TIMEOUT_MS, LlmProviderError, timeoutDescription } from '../types.js';
import { collectProcessOutput, OWN_PROCESS_GROUP, ProcessOutputError } from './process-tree.js';

export interface CodexRuntime {
  resolve(command: string): Promise<{ file: string } | null>;
  spawn(file: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
  env?: NodeJS.ProcessEnv;
}

const REQUIRED_FLAGS = ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--json', '--skip-git-repo-check', '--strict-config', '--sandbox', '--model'];
// These keys come from the official Codex config schema. Strict config rejects unsupported versions.
const RESTRICTIONS = [
  'model_provider="openai"', 'approval_policy="never"', 'project_doc_max_bytes=0',
  'skills.include_instructions=false', 'cloud.skills.enabled=false', 'orchestrator.mcp.enabled=false',
  'mcp_servers={}', 'web_search="disabled"',
  ...['shell_tool', 'unified_exec', 'code_mode', 'code_mode_host', 'js_repl', 'multi_agent', 'apps', 'plugins', 'remote_plugin', 'plugin_hooks', 'hooks', 'memories', 'view_image', 'shell_snapshot'].map((name) => `features.${name}=false`),
];

export class CodexCliProvider implements LlmProvider {
  readonly id: string;
  readonly label: string;
  constructor(private readonly profile: StoredLlmProfile, private readonly runtime: CodexRuntime = defaultRuntime) {
    this.id = profile.id;
    this.label = profile.label;
  }

  async isConfigured(): Promise<boolean> { return (await this.getHealth()).configured; }

  async getHealth(signal?: AbortSignal): Promise<LlmProviderHealth> {
    const account = await this.getSetupHealth(signal);
    if (account.configured && !this.profile.model.trim()) return this.health(true, false, 'not_configured', 'Codex is signed in with ChatGPT. Enter a model ID available to that account.');
    return account;
  }

  async getSetupHealth(signal?: AbortSignal): Promise<LlmProviderHealth> {
    try {
      await this.withContext(15_000, signal, async (context) => { await this.check(context); });
      return this.health(true, true, 'not_tested', 'Codex is signed in with ChatGPT. Test the connection to verify this model.');
    } catch (error) {
      if (!(error instanceof LlmProviderError)) throw error;
      return this.health(error.code !== 'provider_not_installed', false, error.code === 'provider_not_installed' ? 'not_installed' : error.code === 'provider_authentication' ? 'authentication_failed' : 'transport_failed', error.message);
    }
  }

  async complete(options: CompleteOptions): Promise<CompleteResult> {
    if (!this.profile.model.trim()) throw this.error('provider_not_configured', 'Enter a Codex model ID available to your ChatGPT account.');
    return this.withContext(options.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS, options.signal, async (context) => {
      await this.check(context);
      const instructions = path.join(context.cwd, 'instructions.txt');
      await fs.writeFile(instructions, 'Answer the supplied conversation as a text completion. Do not use tools or access files, networks, commands, skills, or other agents. Follow the supplied system instructions.');
      const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--strict-config', '--json', '--color', 'never', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', this.profile.model.trim()];
      for (const restriction of [...RESTRICTIONS, `model_instructions_file=${JSON.stringify(instructions.replace(/\\/g, '/'))}`]) args.push('-c', restriction);
      let buffered = '';
      const onStdout = (chunk: string) => {
        buffered += chunk;
        for (;;) {
          const newline = buffered.indexOf('\n');
          if (newline < 0) break;
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line) this.inspectEvent(line);
        }
      };
      const result = await this.run(context, [...args, '-'], JSON.stringify({ system: options.system ?? '', messages: options.messages }), onStdout);
      if (result.code !== 0) throw this.failure(result.stderr || result.stdout);
      return { text: this.parseCompletion(result.stdout), provider: this.id, model: this.profile.model.trim() };
    });
  }

  private async check(context: Context): Promise<void> {
    const help = await this.run(context, ['exec', '--help']);
    if (help.code !== 0 || !REQUIRED_FLAGS.every((flag) => help.stdout.includes(flag))) throw this.error('provider_execution', 'Update Codex CLI. This version does not support the required isolated completion options.');
    const status = await this.run(context, ['login', 'status']);
    // Codex 0.163.0 documents text status only. Accept its exact ChatGPT status, never guess from arbitrary diagnostics.
    const text = `${status.stdout}\n${status.stderr}`.trim();
    if (status.code === 0 && text === 'Logged in using ChatGPT') return;
    if (/not logged in|api[ -]?key|unauthenticated/i.test(text)) throw this.error('provider_authentication', 'Sign in to Codex CLI with ChatGPT, then test the connection again. API-key accounts are not accepted by this provider.');
    throw this.error('provider_execution', 'Codex CLI could not report a recognized account status. Update Codex and check its configuration.');
  }

  private inspectEvent(line: string): Record<string, unknown> {
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw this.error('invalid_provider_response', 'Codex returned invalid JSON events.'); }
    if (!record(event) || typeof event.type !== 'string') throw this.error('invalid_provider_response', 'Codex returned an invalid event.');
    if (event.type.startsWith('item.') && (!record(event.item) || typeof event.item.type !== 'string')) throw this.error('invalid_provider_response', 'Codex returned an invalid item event.');
    const item = record(event.item) ? event.item : null;
    if (item && typeof item.type === 'string' && !['agent_message', 'reasoning', 'todo_list'].includes(item.type)) throw this.error('provider_execution', 'Codex attempted to use a tool during a text completion.');
    if (event.type === 'turn.failed' || event.type === 'error') throw this.failure(JSON.stringify(event.error ?? event));
    return event;
  }

  private parseCompletion(output: string): string {
    let completed = false;
    let text = '';
    for (const line of output.split(/\r?\n/).filter((line) => line.trim())) {
      const event = this.inspectEvent(line);
      if (completed) throw this.error('invalid_provider_response', 'Codex returned events after its terminal response.');
      if (event.type === 'item.completed' && record(event.item) && event.item.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text;
      if (event.type === 'turn.completed') completed = true;
    }
    if (!completed || !text.trim()) throw this.error('invalid_provider_response', 'Codex did not return a completed text response.');
    return text;
  }

  private async withContext<T>(timeoutMs: number, signal: AbortSignal | undefined, work: (context: Context) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const command = this.profile.command || 'codex';
    if (!allowed(command)) throw this.error('provider_not_installed', 'Select a directly executable Codex CLI binary. Shell scripts and command wrappers are not supported on Windows.');
    const bin = await this.runtime.resolve(command);
    if (!bin || !allowed(bin.file)) throw this.error('provider_not_installed', 'Codex CLI is not installed or is not directly executable.');
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-codex-'));
    try { return await work({ bin: bin.file, cwd, env: buildCodexChildEnv(this.runtime.env ?? process.env), deadline: Date.now() + timeoutMs, timeoutMs, signal }); }
    finally { await fs.rm(cwd, { recursive: true, force: true }); }
  }

  private async run(context: Context, args: string[], input = '', onStdout?: (chunk: string) => void) {
    context.signal?.throwIfAborted();
    if (context.deadline <= Date.now()) throw this.error('provider_timeout', `Codex did not respond within ${timeoutDescription(context.timeoutMs)}.`, true);
    try {
      const child = this.runtime.spawn(context.bin, args, { cwd: context.cwd, shell: false, windowsHide: true, detached: OWN_PROCESS_GROUP, env: context.env });
      return await collectProcessOutput(child, { input, timeoutMs: context.deadline - Date.now(), signal: context.signal, onStdout });
    } catch (error) {
      if (error instanceof LlmProviderError || (error instanceof Error && error.name === 'AbortError')) throw error;
      if (error instanceof ProcessOutputError && error.kind === 'timeout') throw this.error('provider_timeout', `Codex did not respond within ${timeoutDescription(context.timeoutMs)}.`, true);
      throw this.error('provider_execution', error instanceof ProcessOutputError && error.kind === 'output_limit' ? 'Codex output exceeded the allowed size.' : 'Codex CLI could not complete the request.');
    }
  }

  private failure(diagnostics: string): LlmProviderError {
    if (/unauth|not logged|sign.?in|authentication|token.*expired|401|403/i.test(diagnostics)) return this.error('provider_authentication', 'Codex rejected the saved account. Sign in through Codex CLI again.');
    if (/quota|rate.?limit|usage.?limit|429|credits/i.test(diagnostics)) return this.error('provider_quota', 'Codex account usage or rate limits prevented the request.', true);
    if (/model.*(?:not|unavailable|unsupported)|unsupported.*model/i.test(diagnostics)) return this.error('provider_unavailable', 'This model is not available to the Codex account.');
    return this.error('provider_execution', 'Codex CLI reported a failed request. Update Codex and test the connection again.');
  }

  private error(code: ConstructorParameters<typeof LlmProviderError>[0]['code'], message: string, retryable = false) { return new LlmProviderError({ code, message, provider: this.id, model: this.profile.model, retryable }); }
  private health(installed: boolean, configured: boolean, reasonCode: LlmProviderHealth['reasonCode'], reason: string): LlmProviderHealth { return { installed, configured, healthy: configured ? null : false, reasonCode, reason, resolvedModel: this.profile.model.trim() || null }; }
}

interface Context { bin: string; cwd: string; env: NodeJS.ProcessEnv; deadline: number; timeoutMs: number; signal?: AbortSignal }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function allowed(command: string): boolean { return !/^[\\/]{2}/.test(command) && /^(codex|codex\.exe)$/i.test(command.replace(/\\/g, '/').split('/').at(-1) ?? ''); }

export function buildCodexChildEnv(source: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const names = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'CODEX_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].map((key) => platform === 'win32' ? key.toUpperCase() : key));
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && names.has(platform === 'win32' ? key.toUpperCase() : key)));
}

async function resolveCodex(command: string): Promise<{ file: string } | null> {
  const candidates = path.isAbsolute(command) ? [command] : [];
  if (!candidates.length && /^(codex|codex\.exe)$/i.test(command)) {
    const searchPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
    for (const directory of searchPath.split(path.delimiter).filter((entry) => path.isAbsolute(entry) && !/^[\\/]{2}/.test(entry))) candidates.push(path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex'));
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
    if (process.platform === 'darwin') candidates.push('/Applications/Codex.app/Contents/Resources/codex', '/opt/homebrew/bin/codex', '/usr/local/bin/codex');
  }
  for (const file of candidates) {
    try { if (allowed(file) && !/^[\\/]{2}/.test(await fs.realpath(file)) && (await fs.stat(file)).isFile()) { await fs.access(file, constants.X_OK); return { file: path.resolve(file) }; } } catch {}
  }
  return null;
}
const defaultRuntime: CodexRuntime = { resolve: resolveCodex, spawn: (file, args, options) => spawn(file, args, { ...options, stdio: 'pipe' }) };
