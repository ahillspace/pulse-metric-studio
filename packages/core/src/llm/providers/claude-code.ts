import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StoredLlmProfile } from '../profiles.js';
import type { CompleteOptions, CompleteResult, LlmProvider, LlmProviderHealth } from '../types.js';
import { LLM_REQUEST_TIMEOUT_MS, LlmProviderError, timeoutDescription } from '../types.js';
import { collectProcessOutput, OWN_PROCESS_GROUP, ProcessOutputError } from './process-tree.js';
import { buildLocalAgentEnv, localAgentCwd, resolveLaunchCommand } from './local-agent-runtime.js';

export interface ClaudeCodeRuntime {
  resolve(command: string): Promise<{ file: string } | null>;
  spawn(file: string, args: string[], options: SpawnOptionsWithoutStdio): ChildProcessWithoutNullStreams;
  env?: NodeJS.ProcessEnv;
}
const REQUIRED_FLAGS = ['--output-format', '--model'];

export class ClaudeCodeProvider implements LlmProvider {
  readonly id: string;
  readonly label: string;
  constructor(private readonly profile: StoredLlmProfile, private readonly runtime: ClaudeCodeRuntime = defaultRuntime) { this.id = profile.id; this.label = profile.label; }
  async isConfigured(): Promise<boolean> { return (await this.getHealth()).configured; }
  async getHealth(signal?: AbortSignal): Promise<LlmProviderHealth> {
    const account = await this.getSetupHealth(signal);
    if (account.configured && !this.profile.model.trim()) return this.health(true, false, 'not_configured', 'Enter a model ID available to the configured Claude Code CLI.');
    return account;
  }
  async getSetupHealth(signal?: AbortSignal): Promise<LlmProviderHealth> {
    try {
      await this.withContext(15_000, signal, async (context) => { await this.check(context); });
      return this.health(true, true, 'not_tested', 'The Claude launch command is available. Test the connection to verify model access.');
    } catch (error) {
      if (!(error instanceof LlmProviderError)) throw error;
      return this.health(error.code !== 'provider_not_installed', false, error.code === 'provider_not_installed' ? 'not_installed' : error.code === 'provider_authentication' ? 'authentication_failed' : error.code === 'provider_not_configured' ? 'not_configured' : 'transport_failed', error.message);
    }
  }
  async complete(options: CompleteOptions): Promise<CompleteResult> {
    if (!this.profile.model.trim()) throw this.error('provider_not_configured', 'Enter a Claude Code model ID available to your CLI configuration.');
    return this.withContext(options.timeoutMs ?? LLM_REQUEST_TIMEOUT_MS, options.signal, async (context) => {
      await this.check(context);
      const args = ['-p', '--output-format', 'json', '--model', this.profile.model.trim()];
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
    if (help.code !== 0) throw this.error('provider_not_configured', 'Claude Code could not check its launch options. Check Launch command and verify it works in your terminal.');
    if (!REQUIRED_FLAGS.every((flag) => help.stdout.includes(flag))) throw this.error('provider_execution', 'The Claude Code CLI does not support the required noninteractive JSON protocol. Update Claude Code or check the configured executable.');
  }
  private async withContext<T>(timeoutMs: number, signal: AbortSignal | undefined, work: (context: Context) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const deadline = Date.now() + timeoutMs;
    let launch: { file: string; args: string[] } | null;
    try { launch = await resolveLaunchCommand(this.profile.command || 'claude', command => this.runtime.resolve(command)); }
    catch { throw this.error('provider_not_configured', 'Enter a valid Claude launch command with an executable and optional arguments.'); }
    signal?.throwIfAborted();
    if (!launch) throw this.error('provider_not_installed', 'The Claude launch executable is not installed or cannot run directly. Use an explicit interpreter for script wrappers.');
    return work({ bin: launch.file, args: launch.args, cwd: localAgentCwd(), env: buildClaudeCodeChildEnv(this.runtime.env ?? process.env), deadline, timeoutMs, signal });
  }
  private async run(context: Context, args: string[], input = '') {
    context.signal?.throwIfAborted();
    if (context.deadline <= Date.now()) throw this.error('provider_timeout', `Claude Code did not respond within ${timeoutDescription(context.timeoutMs)}.`, true);
    try {
      const child = this.runtime.spawn(context.bin, [...context.args, ...args], { cwd: context.cwd, shell: false, windowsHide: true, detached: OWN_PROCESS_GROUP, env: context.env });
      return await collectProcessOutput(child, { input, timeoutMs: context.deadline - Date.now(), signal: context.signal });
    } catch (error) {
      if (error instanceof LlmProviderError || (error instanceof Error && error.name === 'AbortError')) throw error;
      if (error instanceof ProcessOutputError && error.kind === 'timeout') throw this.error('provider_timeout', `Claude Code did not respond within ${timeoutDescription(context.timeoutMs)}.`, true);
      throw this.error('provider_execution', error instanceof ProcessOutputError && error.kind === 'output_limit' ? 'Claude Code output exceeded the allowed size.' : 'Claude Code could not complete the request.');
    }
  }
  private failure(diagnostics: string): LlmProviderError {
    if (/unauth|not logged|sign.?in|authentication|token.*expired|401|403/i.test(diagnostics)) return this.error('provider_authentication', 'The configured Claude Code CLI rejected authentication. Check its sign-in or credential configuration.');
    if (/quota|rate.?limit|usage.?limit|429|credits/i.test(diagnostics)) return this.error('provider_quota', 'Claude Code usage or rate limits prevented the request.', true);
    if (/model.*(?:not|unavailable|unsupported)|unsupported.*model/i.test(diagnostics)) return this.error('provider_unavailable', 'This model is not available to the configured Claude Code CLI.');
    return this.error('provider_execution', 'Claude Code reported a failed request. Check the launch command and CLI configuration.');
  }
  private error(code: ConstructorParameters<typeof LlmProviderError>[0]['code'], message: string, retryable = false) { return new LlmProviderError({ code, message, provider: this.id, model: this.profile.model, retryable }); }
  private health(installed: boolean, configured: boolean, reasonCode: LlmProviderHealth['reasonCode'], reason: string): LlmProviderHealth { return { installed, configured, healthy: configured ? null : false, reasonCode, reason, resolvedModel: this.profile.model.trim() || null }; }
}
interface Context { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; deadline: number; timeoutMs: number; signal?: AbortSignal }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function buildClaudeCodeChildEnv(source: NodeJS.ProcessEnv, _platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv { return buildLocalAgentEnv(source); }

async function resolveClaude(command: string): Promise<{ file: string } | null> {
  const candidates: string[] = [];
  if (path.isAbsolute(command) || /[\\/]/.test(command)) candidates.push(path.resolve(localAgentCwd(), command));
  else {
    const searchPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '';
    const extensions = process.platform === 'win32' && !path.extname(command) ? ['.exe', '.com'] : [''];
    for (const directory of searchPath.split(path.delimiter).filter(entry => path.isAbsolute(entry))) for (const extension of extensions) candidates.push(path.join(directory, command + extension));
    if (/^claude(?:\.exe)?$/i.test(command)) {
      candidates.push(path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'));
      if (process.platform !== 'win32') candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude');
    }
  }
  for (const file of candidates) {
    try {
      if (process.platform === 'win32' && !/\.(exe|com)$/i.test(file)) continue;
      if ((await fs.stat(file)).isFile()) { await fs.access(file, constants.X_OK); return { file: path.resolve(file) }; }
    } catch {}
  }
  return null;
}
const defaultRuntime: ClaudeCodeRuntime = { resolve: resolveClaude, spawn: (file, args, options) => spawn(file, args, { ...options, stdio: 'pipe' }) };
