import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { test } from 'node:test';
import fs from 'node:fs';
import type { StoredLlmProfile } from '../profiles.js';
import { CodexCliProvider, buildCodexChildEnv, type CodexRuntime } from './codex-cli.js';
import { ClaudeCodeProvider, buildClaudeCodeChildEnv } from './claude-code.js';

const createCodexProvider = (profile: StoredLlmProfile, runtime: CodexRuntime) => new CodexCliProvider(profile, runtime);
const createClaudeCodeProvider = (profile: StoredLlmProfile, runtime: CodexRuntime) => new ClaudeCodeProvider(profile, runtime);

const codexHelp = '--ignore-user-config --ignore-rules --ephemeral --json --skip-git-repo-check --strict-config --sandbox --model';
const claudeHelp = '--safe-mode --tools --strict-mcp-config --mcp-config --disable-slash-commands --no-session-persistence --output-format --settings --setting-sources --system-prompt --model --disallowedTools --permission-mode --permission-prompts --no-chrome';
function profile(protocol: 'codex-cli' | 'claude-code'): StoredLlmProfile {
  return { id: protocol, label: protocol, protocol, command: protocol === 'codex-cli' ? 'codex' : 'claude', model: 'chosen-model', baseUrl: '', authMode: 'local-account', secret: '', headers: {}, region: '', awsProfile: '', source: 'saved' };
}
function fixture(replies: Array<{ stdout: string; code?: number; stderr?: string; delay?: number }>) {
  const calls: Array<{ file: string; args: string[]; options: SpawnOptionsWithoutStdio; input: string }> = [];
  const runtime: CodexRuntime = {
    resolve: async (command) => ({ file: command.endsWith('claude') ? '/tools/claude' : '/tools/codex' }),
    env: { PATH: '/tools', HOME: '/home/user', CODEX_HOME: '/home/user/.codex', CLAUDE_CONFIG_DIR: '/home/user/.claude', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', NODE_OPTIONS: '--require=evil', PULSE_METRIC_STUDIO_MACHINE_KEY: 'secret' },
    spawn: (file, args, options) => {
      const reply = replies.shift();
      assert.ok(reply, `Unexpected process: ${args.join(' ')}`);
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      Object.assign(child, { exitCode: null, signalCode: null });
      const call = { file, args, options, input: '' };
      calls.push(call);
      child.stdin.on('data', (chunk) => { call.input += chunk.toString(); });
      child.stdin.on('finish', () => setTimeout(() => {
        (child.stdout as PassThrough).end(reply.stdout); (child.stderr as PassThrough).end(reply.stderr ?? '');
        Object.assign(child, { exitCode: reply.code ?? 0 });
        child.emit('exit', reply.code ?? 0, null);
        setImmediate(() => child.emit('close', reply.code ?? 0, null));
      }, reply.delay ?? 0));
      return child;
    },
  };
  return { runtime, calls };
}

test('Codex uses the existing ChatGPT account and validates terminal JSONL without putting prompts in arguments', async () => {
  const { runtime, calls } = fixture([
    { stdout: codexHelp }, { stdout: 'Logged in using ChatGPT\n' },
    { stdout: '{"type":"thread.started","thread_id":"t"}\n{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"{\\"ok\\":true}"}}\n{"type":"turn.completed","usage":{}}\n' },
  ]);
  const result = await createCodexProvider(profile('codex-cli'), runtime).complete({ system: 'Return a result', messages: [{ role: 'user', content: 'private & $(prompt)' }] });
  assert.equal(result.text, '{"ok":true}');
  const call = calls.at(-1)!;
  assert.equal(call.options.shell, false);
  assert.equal(call.args.includes('private & $(prompt)'), false);
  assert.match(call.input, /private & \$\(prompt\)/);
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--json']) assert.ok(call.args.includes(flag));
  assert.ok(call.args.includes('skills.include_instructions=false'));
  assert.ok(call.args.includes('features.shell_tool=false'));
  assert.equal(call.args.some((arg) => arg.includes('forced_login_method')), false);
  assert.equal(call.options.env?.OPENAI_API_KEY, undefined);
  assert.equal(call.options.env?.CODEX_HOME, '/home/user/.codex');
  assert.equal(fs.existsSync(String(call.options.cwd)), false, 'temporary workspace is removed after process closure');
});

test('Claude uses subscription auth, disables tools/customizations, and accepts only a successful terminal result', async () => {
  const { runtime, calls } = fixture([
    { stdout: claudeHelp }, { stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}' },
    { stdout: '{"type":"result","subtype":"success","is_error":false,"result":"answer"}' },
  ]);
  const result = await createClaudeCodeProvider(profile('claude-code'), runtime).complete({ messages: [{ role: 'user', content: 'private prompt' }] });
  assert.equal(result.text, 'answer');
  const call = calls.at(-1)!;
  assert.equal(call.args[call.args.indexOf('--tools') + 1], '');
  assert.ok(call.args.includes('--safe-mode'));
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.equal(call.args[call.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(calls[1].args[calls[1].args.indexOf('--mcp-config') + 2], '--safe-mode');
  assert.deepEqual(calls[1].args.slice(-2), ['auth', 'status']);
  assert.equal(call.args[call.args.indexOf('--disallowedTools') + 1], 'mcp__*');
  assert.equal(call.args[call.args.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(call.args[call.args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(call.options.env?.ANTHROPIC_API_KEY, undefined);
  assert.equal(call.options.env?.CLAUDE_CONFIG_DIR, '/home/user/.claude');
  assert.equal(call.args.includes('private prompt'), false);
  assert.match(call.input, /private prompt/);
});

for (const [name, factory, protocol, help, auth] of [
  ['Codex', createCodexProvider, 'codex-cli', codexHelp, 'Logged in using an API key'],
  ['Claude', createClaudeCodeProvider, 'claude-code', claudeHelp, '{"loggedIn":true,"authMethod":"api_key"}'],
] as const) {
  test(`${name} refuses API credentials without starting inference or logging out`, async () => {
    const { runtime, calls } = fixture([{ stdout: help }, { stdout: auth }]);
    await assert.rejects(factory(profile(protocol), runtime).complete({ messages: [] }), (error: any) => error.code === 'provider_authentication');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => !call.args.includes('logout')));
  });
  test(`${name} fails unsupported CLI flags before checking account or sending prompts`, async () => {
    const { runtime, calls } = fixture([{ stdout: 'old CLI' }]);
    await assert.rejects(factory(profile(protocol), runtime).complete({ messages: [] }), (error: any) => error.code === 'provider_execution');
    assert.equal(calls.length, 1);
  });
}

test('Codex rejects missing terminal events, tool attempts, and malformed JSONL', async () => {
  for (const stdout of [
    '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}\n',
    '{"type":"item.started","item":{"type":"command_execution","command":"cat secret"}}\n{"type":"turn.completed"}\n',
    'not JSON\n',
  ]) {
    const { runtime } = fixture([{ stdout: codexHelp }, { stdout: 'Logged in using ChatGPT' }, { stdout }]);
    await assert.rejects(createCodexProvider(profile('codex-cli'), runtime).complete({ messages: [] }), (error: any) => error.code === 'invalid_provider_response' || error.code === 'provider_execution');
  }
});

test('Claude rejects error and missing result envelopes even when the executable exits successfully', async () => {
  for (const stdout of ['{"type":"result","subtype":"error_max_turns","is_error":true,"result":"partial"}', '{"type":"assistant","message":{}}', 'plain text']) {
    const { runtime } = fixture([{ stdout: claudeHelp }, { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' }, { stdout }]);
    await assert.rejects(createClaudeCodeProvider(profile('claude-code'), runtime).complete({ messages: [] }));
  }
});

test('both account environments preserve auth locations but exclude injected billing, cloud, runtime and app credentials', () => {
  const source = { Path: 'tools', HOME: 'home', CODEX_HOME: 'codex', CLAUDE_CONFIG_DIR: 'claude', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', AWS_PROFILE: 'cloud', OPENAI_BASE_URL: 'gateway', NODE_OPTIONS: 'exec', PULSE_METRIC_STUDIO_MACHINE_KEY: 'secret' };
  for (const build of [buildCodexChildEnv, buildClaudeCodeChildEnv]) {
    const env = build(source, 'win32');
    assert.equal(env.Path, 'tools');
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_PROFILE', 'OPENAI_BASE_URL', 'NODE_OPTIONS', 'PULSE_METRIC_STUDIO_MACHINE_KEY']) assert.equal(env[key], undefined);
  }
});

for (const [name, factory, protocol, help, auth, output] of [
  ['Codex', createCodexProvider, 'codex-cli', codexHelp, 'Logged in using ChatGPT', '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n{"type":"turn.completed"}\n'],
  ['Claude', createClaudeCodeProvider, 'claude-code', claudeHelp, '{"loggedIn":true,"authMethod":"claude.ai"}', '{"type":"result","subtype":"success","is_error":false,"result":"answer"}'],
] as const) {
  test(`${name} passive setup reports signed in before a model is entered`, async () => {
    const { runtime } = fixture([{ stdout: help }, { stdout: auth }]);
    const provider = factory({ ...profile(protocol), model: '' }, runtime);
    const health = await provider.getSetupHealth!();
    assert.equal(health.configured, true);
    assert.equal(health.resolvedModel, null);
    assert.equal(health.healthy, null);
  });
  test(`${name} cancellation waits for child closure and removes the request workspace`, async () => {
    const { runtime, calls } = fixture([{ stdout: help }, { stdout: auth }, { stdout: output, delay: 60 }]);
    const originalSpawn = runtime.spawn;
    const controller = new AbortController();
    let reachedCompletion!: () => void;
    const started = new Promise<void>((resolve) => { reachedCompletion = resolve; });
    runtime.spawn = (file, args, options) => {
      const child = originalSpawn(file, args, options);
      if (calls.length === 3) reachedCompletion();
      return child;
    };
    const pending = factory(profile(protocol), runtime).complete({ messages: [], signal: controller.signal });
    const rejected = assert.rejects(pending, (error: any) => error.name === 'AbortError');
    await started;
    controller.abort();
    await rejected;
    assert.equal(fs.existsSync(String(calls.at(-1)!.options.cwd)), false);
  });
  test(`${name} one deadline covers account preflight and refuses to start inference after expiration`, async () => {
    const { runtime, calls } = fixture([{ stdout: help, delay: 40 }]);
    await assert.rejects(factory(profile(protocol), runtime).complete({ messages: [], timeoutMs: 10 }), (error: any) => error.code === 'provider_timeout');
    assert.equal(calls.length, 1);
  });
  test(`${name} oversized output is rejected and raw diagnostics never appear in errors`, async () => {
    const { runtime } = fixture([{ stdout: help }, { stdout: auth }, { stdout: 'secret'.repeat(350_000) }]);
    await assert.rejects(factory(profile(protocol), runtime).complete({ messages: [] }), (error: any) => error.code === 'provider_execution' && !error.message.includes('secret'));
  });
  test(`${name} network executables and command wrappers are rejected before invocation`, async () => {
    for (const command of ['\\\\server\\bin\\' + (protocol === 'codex-cli' ? 'codex.exe' : 'claude.exe'), protocol === 'codex-cli' ? 'codex.cmd' : 'claude.cmd']) {
      const { runtime, calls } = fixture([]);
      await assert.rejects(factory({ ...profile(protocol), command }, runtime).complete({ messages: [] }), (error: any) => error.code === 'provider_not_installed');
      assert.equal(calls.length, 0);
    }
  });
}

test('Claude reports the actual single model from authoritative terminal usage metadata', async () => {
  const { runtime } = fixture([{ stdout: claudeHelp }, { stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' }, { stdout: '{"type":"result","subtype":"success","is_error":false,"result":"answer","modelUsage":{"claude-actual-model":{"inputTokens":3}}}' }]);
  assert.equal((await createClaudeCodeProvider(profile('claude-code'), runtime).complete({ messages: [] })).model, 'claude-actual-model');
});

test('account provider failures map auth and quota errors without exposing process diagnostics', async () => {
  for (const [factory, protocol, help, auth, type] of [
    [createCodexProvider, 'codex-cli', codexHelp, 'Logged in using ChatGPT', 'error'],
    [createClaudeCodeProvider, 'claude-code', claudeHelp, '{"loggedIn":true,"authMethod":"claude.ai"}', 'result'],
  ] as const) {
    for (const [message, expected] of [['authentication expired secret-token', 'provider_authentication'], ['quota exceeded secret-token', 'provider_quota']] as const) {
      const { runtime } = fixture([{ stdout: help }, { stdout: auth }, { stdout: JSON.stringify({ type, error: { message }, is_error: true, subtype: 'error_during_execution' }), code: 1 }]);
      await assert.rejects(factory(profile(protocol), runtime).complete({ messages: [] }), (error: any) => error.code === expected && !error.message.includes('secret-token'));
    }
  }
});

test('local account status never accepts injected, third-party, absent, or malformed account modes', async () => {
  for (const stdout of [
    '{"loggedIn":false,"authMethod":"claude.ai"}', '{"loggedIn":true,"authMethod":"oauth_token"}',
    '{"loggedIn":true,"authMethod":"third_party"}', '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"bedrock"}', '{}',
  ]) {
    const { runtime, calls } = fixture([{ stdout: claudeHelp }, { stdout }]);
    await assert.rejects(createClaudeCodeProvider(profile('claude-code'), runtime).complete({ messages: [] }), (error: any) => error.code === 'provider_authentication');
    assert.equal(calls.length, 2);
  }
});

test('unrecognized CLI status output reports a compatibility failure rather than asking the user to sign in again', async () => {
  for (const [factory, protocol, help] of [[createCodexProvider, 'codex-cli', codexHelp], [createClaudeCodeProvider, 'claude-code', claudeHelp]] as const) {
    const { runtime } = fixture([{ stdout: help }, { stdout: 'new unrecognized status format' }]);
    await assert.rejects(factory(profile(protocol), runtime).complete({ messages: [] }), (error: any) => error.code === 'provider_execution');
  }
});
