import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StoredLlmProfile } from '../profiles.js';
import type { CompleteOptions, CompleteResult, LlmProvider, LlmProviderHealth } from '../types.js';
import { LLM_REQUEST_TIMEOUT_MS, LlmProviderError, timeoutDescription } from '../types.js';
import { collectProcessOutput, OWN_PROCESS_GROUP, ProcessOutputError } from './process-tree.js';

export interface ClaudeCodeRuntime {
  resolve(command: string): Promise<{ file: string } | null>;
  spawn(file: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
  env?: NodeJS.ProcessEnv;
}
const REQUIRED_FLAGS = ['--safe-mode', '--tools', '--strict-mcp-config', '--mcp-config', '--disable-slash-commands', '--no-session-persistence', '--output-format', '--settings', '--setting-sources', '--system-prompt', '--model', '--disallowedTools', '--permission-mode', '--permission-prompts', '--no-chrome'];
// A boolean flag terminates --mcp-config's variadic values before an auth subcommand.
const ISOLATION_ARGS = ['--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--safe-mode'];

export class ClaudeCodeProvider implements LlmProvider {
  readonly id: string;
  readonly label: string;
  constructor(private readonly profile: StoredLlmProfile, private readonly runtime: ClaudeCodeRuntime = defaultRuntime) { this.id = profile.id; this.label = profile.label; }
  async isConfigured(): Promise<boolean> { return (await this.getHealth()).configured; }
  async getHealth(signal?: AbortSignal): Promise<LlmProviderHealth> {
    const account = await this.getSetupHealth(signal);
    if (account.configured && !this.profile.model.trim()) return this.health(true, false, 'not_configured', 'Claude Code is signed in with Claude. Enter a model ID available to that account.');
    return account;
  }
  async getSetupHealth(signal?: AbortSignal): Promise<LlmProviderHealth> {
    try {
      await this.withContext(15_000, signal, async (context) => { await this.check(context); });
      return this.health(true, true, 'not_tested', 'Claude Code is signed in with Claude. Test the connection to verify this model.');
    } catch (error) {
      if (!(error instanceof LlmProviderError)) throw error;
      return this.health(error.code !== 'provider_not_installed', false, error.code === 'provider_not_installed' ? 'not_installed' : error.code === 'provider_authentication' ? 'authentication_failed' : 'transport_failed', error.message);
    }
  }
  async complete(options: CompleteOptions): Promise<CompleteResult> {
    if (!this.profile.model.trim()) throw this.error('provider_not_configured', 'Enter a Claude Code model ID available to your account.');
    return this.withContext(options.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS, options.signal, async (context) => {
      await this.check(context);
      const args = [...ISOLATION_ARGS, '-p', '--tools', '', '--disallowedTools', 'mcp__*', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-chrome', '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json', '--model', this.profile.model.trim(), '--system-prompt', 'Answer the supplied conversation as a text completion. Do not use tools. Follow the supplied system instructions.'];
      const result = await this.run(context, args, JSON.stringify({ system: options.system ?? '', messages: options.messages }));
      let envelope: unknown;
      try { envelope = JSON.parse(result.stdout); } catch { if (result.code !== 0) throw this.failure(result.stderr); throw this.error('invalid_provider_response', 'Claude Code returned invalid JSON.'); }
      if (!record(envelope) || envelope.type !== 'result') throw this.error('invalid_provider_response', 'Claude Code did not return a terminal result.');
      if (result.code !== 0 || envelope.is_error !== false || envelope.subtype !== 'success') throw this.failure(JSON.stringify(envelope));
      if (typeof envelope.result !== 'string' || !envelope.result.trim()) throw this.error('invalid_provider_response', 'Claude Code returned an empty response.');
      const models = record(envelope.modelUsage) ? Object.keys(envelope.modelUsage) : [];
      return { text: envelope.result, provider: this.id, model: models.length === 1 ? models[0] : this.profile.model.trim() };
    });
  }
  private async check(context: Context): Promise<void> {
    const help = await this.run(context, ['--help']);
    if (help.code !== 0 || !REQUIRED_FLAGS.every((flag) => help.stdout.includes(flag))) throw this.error('provider_execution', 'Update Claude Code. This version does not support the required isolated completion options.');
    const status = await this.run(context, [...ISOLATION_ARGS, 'auth', 'status']);
    let account: unknown;
    try { account = JSON.parse(status.stdout); } catch { throw this.error('provider_execution', 'Claude Code could not report its account status as JSON. Update Claude Code and check its configuration.'); }
    if (status.code !== 0 || !record(account) || account.loggedIn !== true || account.authMethod !== 'claude.ai' || (account.apiProvider !== undefined && account.apiProvider !== 'firstParty')) throw this.error('provider_authentication', 'Sign in to Claude Code with your Claude account, then test again. API-key, injected OAuth-token, and cloud-provider accounts are not accepted by this provider.');
  }
  private async withContext<T>(timeoutMs: number, signal: AbortSignal | undefined, work: (context: Context) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const command = this.profile.command || 'claude';
    if (!allowed(command)) throw this.error('provider_not_installed', 'Select a directly executable Claude Code binary. Shell scripts and command wrappers are not supported on Windows.');
    const bin = await this.runtime.resolve(command);
    if (!bin || !allowed(bin.file)) throw this.error('provider_not_installed', 'Claude Code is not installed or is not directly executable.');
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-claude-'));
    try { return await work({ bin: bin.file, cwd, env: buildClaudeCodeChildEnv(this.runtime.env ?? process.env), deadline: Date.now() + timeoutMs, timeoutMs, signal }); }
    finally { await fs.rm(cwd, { recursive: true, force: true }); }
  }
  private async run(context: Context, args: string[], input = '') {
    context.signal?.throwIfAborted();
    if (context.deadline <= Date.now()) throw this.error('provider_timeout', `Claude Code did not respond within ${timeoutDescription(context.timeoutMs)}.`, true);
    try {
      const child = this.runtime.spawn(context.bin, args, { cwd: context.cwd, shell: false, windowsHide: true, detached: OWN_PROCESS_GROUP, env: context.env });
      return await collectProcessOutput(child, { input, timeoutMs: context.deadline - Date.now(), signal: context.signal });
    } catch (error) {
      if (error instanceof LlmProviderError || (error instanceof Error && error.name === 'AbortError')) throw error;
      if (error instanceof ProcessOutputError && error.kind === 'timeout') throw this.error('provider_timeout', `Claude Code did not respond within ${timeoutDescription(context.timeoutMs)}.`, true);
      throw this.error('provider_execution', error instanceof ProcessOutputError && error.kind === 'output_limit' ? 'Claude Code output exceeded the allowed size.' : 'Claude Code could not complete the request.');
    }
  }
  private failure(diagnostics: string): LlmProviderError {
    if (/unauth|not logged|sign.?in|authentication|token.*expired|401|403/i.test(diagnostics)) return this.error('provider_authentication', 'Claude Code rejected the saved account. Sign in through Claude Code again.');
    if (/quota|rate.?limit|usage.?limit|429|credits/i.test(diagnostics)) return this.error('provider_quota', 'Claude account usage or rate limits prevented the request.', true);
    if (/model.*(?:not|unavailable|unsupported)|unsupported.*model/i.test(diagnostics)) return this.error('provider_unavailable', 'This model is not available to the Claude account.');
    return this.error('provider_execution', 'Claude Code reported a failed request. Update Claude Code and test the connection again.');
  }
  private error(code: ConstructorParameters<typeof LlmProviderError>[0]['code'], message: string, retryable = false) { return new LlmProviderError({ code, message, provider: this.id, model: this.profile.model, retryable }); }
  private health(installed: boolean, configured: boolean, reasonCode: LlmProviderHealth['reasonCode'], reason: string): LlmProviderHealth { return { installed, configured, healthy: configured ? null : false, reasonCode, reason, resolvedModel: this.profile.model.trim() || null }; }
}
interface Context { bin: string; cwd: string; env: NodeJS.ProcessEnv; deadline: number; timeoutMs: number; signal?: AbortSignal }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function allowed(command: string): boolean { return !/^[\\/]{2}/.test(command) && /^(claude|claude\.exe)$/i.test(command.replace(/\\/g, '/').split('/').at(-1) ?? ''); }
export function buildClaudeCodeChildEnv(source: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const names = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'CLAUDE_CONFIG_DIR', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].map((key) => platform === 'win32' ? key.toUpperCase() : key));
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && names.has(platform === 'win32' ? key.toUpperCase() : key)));
}
async function resolveClaude(command: string): Promise<{ file: string } | null> {
  const candidates = path.isAbsolute(command) ? [command] : [];
  if (!candidates.length && /^(claude|claude\.exe)$/i.test(command)) {
    const searchPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
    for (const directory of searchPath.split(path.delimiter).filter((entry) => path.isAbsolute(entry) && !/^[\\/]{2}/.test(entry))) candidates.push(path.join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude'));
    candidates.push(path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'));
    if (process.platform !== 'win32') candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  }
  for (const file of candidates) {
    try { if (allowed(file) && !/^[\\/]{2}/.test(await fs.realpath(file)) && (await fs.stat(file)).isFile()) { await fs.access(file, constants.X_OK); return { file: path.resolve(file) }; } } catch {}
  }
  return null;
}
const defaultRuntime: ClaudeCodeRuntime = { resolve: resolveClaude, spawn: (file, args, options) => spawn(file, args, { ...options, stdio: 'pipe' }) };
