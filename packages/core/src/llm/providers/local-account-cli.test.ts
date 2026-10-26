import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { test } from 'node:test';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { StoredLlmProfile } from '../profiles.js';
import { CodexCliProvider, type CodexRuntime } from './codex-cli.js';
import { ClaudeCodeProvider, buildClaudeCodeChildEnv } from './claude-code.js';

const codexHelp = '--json --skip-git-repo-check --model';
const claudeHelp = '--output-format --model';
const codexResult = '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n{"type":"turn.completed"}\n';
const claudeResult = '{"type":"result","subtype":"success","is_error":false,"result":"answer"}';
const cases = [
  { name: 'Codex', protocol: 'codex-cli', create: (p: StoredLlmProfile, runtime: CodexRuntime) => new CodexCliProvider(p, runtime), help: codexHelp, output: codexResult, executable: 'codex' },
  { name: 'Claude', protocol: 'claude-code', create: (p: StoredLlmProfile, runtime: CodexRuntime) => new ClaudeCodeProvider(p, runtime), help: claudeHelp, output: claudeResult, executable: 'claude' },
] as const;
function profile(protocol: 'codex-cli' | 'claude-code', command = ''): StoredLlmProfile {
  return { id: protocol, label: protocol, protocol, command, model: 'chosen-model', baseUrl: '', authMode: 'local-account', secret: null, credentialCommand: null, credentialCommandHint: null, headers: {}, region: '', awsProfile: '', source: 'saved' };
}
function fixture(replies: Array<{ stdout: string; code?: number; stderr?: string; delay?: number }>) {
  const calls: Array<{ file: string; args: string[]; options: SpawnOptionsWithoutStdio; input: string }> = [];
  const resolutions: string[] = [];
  const runtime = {
    resolve: async (command: string) => { resolutions.push(command); return { file: command }; },
    env: { ...process.env, CUSTOM_TOOL_TOKEN: 'tool-secret', NODE_OPTIONS: '--trace-warnings', PULSE_METRIC_STUDIO_MACHINE_KEY: 'app-secret' },
    spawn: (file: string, args: string[], options: SpawnOptionsWithoutStdio) => {
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
  return { runtime, calls, resolutions };
}

for (const spec of cases) {
  test(`${spec.name} inherits native setup without forcing safety, isolation, or full access`, async () => {
    const { runtime, calls } = fixture([{ stdout: spec.help }, { stdout: spec.output }]);
    const result = await spec.create(profile(spec.protocol), runtime).complete({ system: 'App response contract', messages: [{ role: 'user', content: 'private & $(prompt)' }] });
    assert.equal(result.text, 'answer');
    const call = calls.at(-1)!;
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd, os.homedir());
    assert.equal(call.options.env?.CUSTOM_TOOL_TOKEN, 'tool-secret');
    assert.equal(call.options.env?.NODE_OPTIONS, '--trace-warnings');
    assert.equal(call.options.env?.PULSE_METRIC_STUDIO_MACHINE_KEY, undefined);
    for (const fragment of ['--safe-mode', '--tools', '--disallowedTools', '--settings', '--setting-sources', '--strict-mcp-config', '--ignore-user-config', '--ignore-rules', '--sandbox', 'danger-full-access', 'approval_policy', 'model_instructions_file', '--system-prompt', '--dangerously-skip-permissions']) assert.equal(call.args.some(arg => arg.includes(fragment)), false, fragment);
    assert.equal(call.args.includes('private & $(prompt)'), false);
    assert.deepEqual(JSON.parse(call.input), { system: 'App response contract', messages: [{ role: 'user', content: 'private & $(prompt)' }] });
    assert.ok(calls.every(call => !call.args.includes('login') && !call.args.includes('auth')), 'native provider authentication is verified by the explicit model request');
  });

  test(`${spec.name} preserves user launch flags and explicit wrapper executables`, async () => {
    const { runtime, calls, resolutions } = fixture([{ stdout: spec.help }, { stdout: spec.output }]);
    const result = await spec.create(profile(spec.protocol, '"C:\\Launch Tools\\account-runner.exe" --config "C:\\User Setup\\settings.json"'), runtime).complete({ messages: [] });
    assert.equal(result.text, 'answer');
    assert.deepEqual(resolutions, ['C:\\Launch Tools\\account-runner.exe']);
    for (const call of calls) assert.deepEqual(call.args.slice(0, 2), ['--config', 'C:\\User Setup\\settings.json']);
  });

  test(`${spec.name} passive setup checks the launcher without requiring subscription authentication`, async () => {
    const { runtime } = fixture([{ stdout: spec.help }]);
    const health = await spec.create({ ...profile(spec.protocol), model: '' }, runtime).getSetupHealth!();
    assert.equal(health.configured, true);
    assert.equal(health.healthy, null);
    assert.equal(health.resolvedModel, null);
  });

  test(`${spec.name} rejects incompatible output protocol flags before submitting a model request`, async () => {
    const { runtime, calls } = fixture([{ stdout: 'old CLI' }]);
    await assert.rejects(spec.create(profile(spec.protocol), runtime).complete({ messages: [] }), (error: any) => error.code === 'provider_execution');
    assert.equal(calls.length, 1);
  });

  test(`${spec.name} reports rejected launch options without blaming JSON support or exposing diagnostics`, async () => {
    const { runtime, calls } = fixture([{ stdout: spec.help, code: 2, stderr: 'Unexpected option. secret-token=private-token' }]);
    await assert.rejects(spec.create(profile(spec.protocol), runtime).complete({ messages: [] }), (error: any) => {
      assert.equal(error.code, 'provider_not_configured');
      assert.match(error.message, /launch command|launch options/i);
      assert.doesNotMatch(error.message, /JSON|secret-token|private-token/);
      return true;
    });
    assert.equal(calls.length, 1);
    const setup = fixture([{ stdout: '', code: 2, stderr: 'private-token' }]);
    const health = await spec.create(profile(spec.protocol), setup.runtime).getSetupHealth!();
    assert.equal(health.reasonCode, 'not_configured');
    assert.equal(health.configured, false);
    assert.doesNotMatch(health.reason ?? '', /private-token/);
  });

  test(`${spec.name} shares a deadline across preflight without starting a late completion`, async () => {
    const { runtime, calls } = fixture([{ stdout: spec.help, delay: 40 }]);
    await assert.rejects(spec.create(profile(spec.protocol), runtime).complete({ messages: [], timeoutMs: 10 }), (error: any) => error.code === 'provider_timeout');
    assert.equal(calls.length, 1);
  });
}

test('user-selected native safe/read-only flags reach completion without app overrides', async () => {
  for (const [spec, flags] of [[cases[0], ['--sandbox', 'read-only']], [cases[1], ['--safe-mode']]] as const) {
    const { runtime, calls } = fixture([{ stdout: spec.help }, { stdout: spec.output }]);
    await spec.create(profile(spec.protocol, `${spec.executable} ${flags.join(' ')}`), runtime).complete({ messages: [] });
    assert.deepEqual(calls.at(-1)!.args.slice(0, flags.length), flags);
  }
});

// Real process output exercises the adapter stream contract without contacting a model.
test('Codex accepts tools, recoverable ErrorItem, future items, and only its final message from split stdout', async () => {
  const events = [
    { type: 'thread.started', thread_id: 'fixture' },
    { type: 'item.completed', item: { type: 'agent_message', phase: 'commentary', text: 'Working.' } },
    { type: 'item.started', item: { type: 'command_execution', command: 'fixture' } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', result: {} } },
    { type: 'item.completed', item: { type: 'error', message: 'Recovered.' } },
    { type: 'item.completed', item: { type: 'future_item_type' } },
    { type: 'item.completed', item: { type: 'agent_message', phase: 'final_answer', text: '{"ok":true}' } },
    { type: 'turn.completed' },
  ];
  const script = `process.stdin.resume();process.stdin.on('end',async()=>{
    if(process.argv[1]==='help')return process.stdout.write(${JSON.stringify(codexHelp)});
    for(const event of ${JSON.stringify(events)}) {const line=JSON.stringify(event)+'\\n';process.stdout.write(line.slice(0,5));await new Promise(r=>setTimeout(r,2));process.stdout.write(line.slice(5));}
  });`;
  const runtime: CodexRuntime = {
    resolve: async () => ({ file: process.execPath }),
    spawn: (_file, args, options) => spawn(process.execPath, ['-e', script, args.includes('--help') ? 'help' : 'complete'], { ...options, stdio: 'pipe' }),
  };
  const result = await new CodexCliProvider(profile('codex-cli'), runtime).complete({ messages: [] });
  assert.equal(result.text, '{"ok":true}');
});

test('Codex rejects genuine errors, malformed output, missing final messages, and post-terminal events', async () => {
  for (const stdout of [
    '{"type":"item.started","item":{"type":"command_execution"}}\n{"type":"turn.failed","error":{"message":"failed"}}\n',
    '{"type":"error","message":"failed"}\n', 'not JSON\n',
    '{"type":"item.started","item":{}}\n',
    '{"type":"item.completed","item":{"type":"agent_message","phase":"commentary","text":"partial"}}\n{"type":"turn.completed"}\n',
    '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}\n',
    codexResult + '{"type":"item.completed","item":{"type":"reasoning"}}\n',
  ]) {
    const { runtime } = fixture([{ stdout: codexHelp }, { stdout }]);
    await assert.rejects(new CodexCliProvider(profile('codex-cli'), runtime).complete({ messages: [] }), (error: any) => ['provider_execution', 'invalid_provider_response'].includes(error.code));
  }
});

test('Claude rejects failed, empty, missing, or malformed terminal results', async () => {
  for (const stdout of ['{"type":"result","subtype":"error_max_turns","is_error":true,"result":"partial"}', '{"type":"result","subtype":"success","is_error":false,"result":""}', '{"type":"assistant","message":{}}', 'plain text']) {
    const { runtime } = fixture([{ stdout: claudeHelp }, { stdout }]);
    await assert.rejects(new ClaudeCodeProvider(profile('claude-code'), runtime).complete({ messages: [] }), (error: any) => ['provider_execution', 'invalid_provider_response'].includes(error.code));
  }
});

test('Claude returns authoritative single-model terminal usage metadata', async () => {
  const { runtime } = fixture([{ stdout: claudeHelp }, { stdout: '{"type":"result","subtype":"success","is_error":false,"result":"answer","modelUsage":{"actual-model":{"inputTokens":3}}}' }]);
  assert.equal((await new ClaudeCodeProvider(profile('claude-code'), runtime).complete({ messages: [] })).model, 'actual-model');
});

test('native CLI providers retain user tool environments and remove app-only secrets', () => {
  const env = buildClaudeCodeChildEnv({ Path: 'tools', CUSTOM_TOOL_TOKEN: 'tool-secret', OPENAI_API_KEY: 'native-key', ANTHROPIC_AUTH_TOKEN: 'native-token', AWS_PROFILE: 'native-cloud', NODE_OPTIONS: '--trace-warnings', PULSE_METRIC_STUDIO_MACHINE_KEY: 'secret', pulse_metric_studio_secret: 'secret' });
  assert.equal(env.CUSTOM_TOOL_TOKEN, 'tool-secret');
  assert.equal(env.NODE_OPTIONS, '--trace-warnings');
  assert.equal(env.OPENAI_API_KEY, 'native-key');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'native-token');
  assert.equal(env.AWS_PROFILE, 'native-cloud');
  assert.equal(env.PULSE_METRIC_STUDIO_MACHINE_KEY, undefined);
  assert.equal(env.pulse_metric_studio_secret, undefined);
});

test('production adapters run an explicit executable wrapper with user options and stdin through the native process boundary', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-native-wrapper-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const scriptPath = path.join(directory, 'account wrapper.cjs');
  const configPath = path.join(directory, 'native settings.txt');
  await fs.writeFile(configPath, 'USER_CONFIGURATION_SENTINEL');
  await fs.writeFile(scriptPath, `
    const fs = require('node:fs'); const args = process.argv.slice(2);
    process.stdin.setEncoding('utf8'); let input = '';
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      if(args.includes('--help')) return process.stdout.write(${JSON.stringify(codexHelp + ' ' + claudeHelp)});
      const config = fs.readFileSync(args[args.indexOf('--fixture-config')+1], 'utf8');
      const text = JSON.stringify({args,config,input:JSON.parse(input),cwd:process.cwd()});
      if(args.includes('exec')) {
        process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\\n'+JSON.stringify({type:'turn.completed'})+'\\n');
      } else process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:text}));
    });
  `);
  for (const spec of cases) {
    const command = `"${process.execPath}" "${scriptPath}" --fixture-config "${configPath}"`;
    const provider = spec.protocol === 'codex-cli' ? new CodexCliProvider(profile(spec.protocol, command)) : new ClaudeCodeProvider(profile(spec.protocol, command));
    const result = await provider.complete({ system: 'APP_CONTRACT', messages: [{ role: 'user', content: 'private & $(prompt)' }] });
    const observed = JSON.parse(result.text);
    assert.equal(observed.config, 'USER_CONFIGURATION_SENTINEL');
    assert.equal(observed.cwd, os.homedir());
    assert.equal(observed.input.system, 'APP_CONTRACT');
    assert.equal(observed.input.messages[0].content, 'private & $(prompt)');
    assert.deepEqual(observed.args.slice(0, 2), ['--fixture-config', configPath]);
    assert.equal(observed.args.includes('private & $(prompt)'), false);
  }
});

for (const spec of cases) {
  test(`${spec.name} cancellation stops its real owned child`, { timeout: 10_000 }, async () => {
    const controller = new AbortController();
    let childStarted!: () => void;
    const started = new Promise<void>(resolve => { childStarted = resolve; });
    let activeChild: ChildProcessWithoutNullStreams | undefined;
    const script = `process.stdin.resume();process.stdin.on('end',()=>{
      if(process.argv[1]==='help')return process.stdout.write(${JSON.stringify(spec.help)});
      process.stdout.write('started');setInterval(()=>{},1000);
    });`;
    const runtime: CodexRuntime = {
      resolve: async () => ({ file: process.execPath }),
      spawn: (_file, args, options) => {
        const stage = args.includes('--help') ? 'help' : 'complete';
        const child = spawn(process.execPath, ['-e', script, stage], { ...options, stdio: 'pipe' });
        if (stage === 'complete') { activeChild = child; child.stdout.once('data', () => childStarted()); }
        return child;
      },
    };
    const pending = spec.create(profile(spec.protocol), runtime).complete({ messages: [], signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await started;
    controller.abort();
    await rejected;
    assert.ok(activeChild!.exitCode !== null || activeChild!.signalCode !== null);
  });

  test(`${spec.name} maps native authentication and quota errors without fallback or raw diagnostics`, async () => {
    for (const [message, expected] of [['authentication expired secret-token', 'provider_authentication'], ['quota exceeded secret-token', 'provider_quota']] as const) {
      const stdout = spec.protocol === 'codex-cli' ? JSON.stringify({ type: 'error', message }) + '\n' : JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, error: { message } });
      const { runtime, calls } = fixture([{ stdout: spec.help }, { stdout, code: 1 }]);
      await assert.rejects(spec.create(profile(spec.protocol), runtime).complete({ messages: [] }), (error: any) => error.code === expected && !error.message.includes('secret-token'));
      assert.equal(calls.length, 2);
    }
  });

  test(`${spec.name} reports malformed launch commands without starting a process`, async () => {
    const { runtime, calls } = fixture([]);
    const health = await spec.create(profile(spec.protocol, '"unclosed'), runtime).getSetupHealth!();
    assert.equal(health.configured, false);
    assert.equal(health.reasonCode, 'not_configured');
    assert.equal(calls.length, 0);
  });
}
