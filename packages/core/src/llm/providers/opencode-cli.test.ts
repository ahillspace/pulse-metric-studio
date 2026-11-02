import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { StoredLlmProfile } from '../profiles.js';
import {
  buildOpenCodeChildEnv,
  classifyOpenCodeFailure,
  OpencodeCliProvider,
  parseOpenCodeVerboseModels,
  type OpencodeRuntime,
} from './opencode-cli.js';

const processProfile: StoredLlmProfile = {
  id: 'opencode', label: 'OpenCode', protocol: 'opencode', command: 'opencode', model: 'provider/model', baseUrl: '', authMode: 'none',
  secret: null, credentialCommand: null, credentialCommandHint: null, headers: {}, region: '', awsProfile: '', source: 'saved',
};

test('OpenCode discovery retries an executable that was installed after a failed lookup', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-opencode-install-'));
  const executable = path.join(directory, process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  const originalAccess = fs.promises.access;
  // Other installed copies must not make the missing-executable case pass.
  fs.promises.access = async (candidate, mode) => {
    if (String(candidate) !== executable) throw new Error('Not in this installation fixture');
    return originalAccess(candidate, mode);
  };
  const profile: StoredLlmProfile = { id: 'opencode', label: 'OpenCode', protocol: 'opencode', baseUrl: '', model: 'provider/model', authMode: 'none', secret: null, credentialCommand: null, credentialCommandHint: null, headers: {}, region: '', awsProfile: '', command: executable, source: 'saved' };
  try {
    assert.equal((await new OpencodeCliProvider(profile).getHealth()).installed, false);
    fs.writeFileSync(executable, '', { mode: 0o755 });
    assert.equal((await new OpencodeCliProvider(profile).getHealth()).installed, true);
  } finally {
    fs.promises.access = originalAccess;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('OpenCode sends prompts separately from shell-free process arguments and reports the resolved model', async () => {
  const profile: StoredLlmProfile = {
    id: 'opencode', label: 'OpenCode', protocol: 'opencode', baseUrl: '', model: 'provider/model-1', authMode: 'none', secret: null, credentialCommand: null, credentialCommandHint: null,
    headers: {}, region: '', awsProfile: '', command: 'opencode', source: 'saved',
  };
  const invocations: Array<{ args: string[]; prompt: string }> = [];
  const runtime: OpencodeRuntime = {
    resolve: async () => ({ file: 'C:\\tools\\opencode.exe' }),
    run: async (_bin, args, prompt) => {
      invocations.push({ args, prompt });
      return '\u001b[32m{"ok":true}\u001b[0m';
    },
  };
  const provider = new OpencodeCliProvider(profile, runtime);
  const result = await provider.complete({ system: 'system', messages: [{ role: 'user', content: 'value & whoami' }] });
  assert.equal(result.model, 'provider/model-1');
  assert.equal(result.text, '{"ok":true}');
  const invocation = invocations[0];
  assert.ok(invocation);
  assert.deepEqual(invocation.args, ['run', '--format', 'json', '--title', 'Pulse Metric Studio', '--model', 'provider/model-1']);
  assert.equal(invocation.args.includes('value & whoami'), false);
  assert.match(invocation.prompt, /value & whoami/);
});

test('OpenCode preserves a quoted executable launch command and user prefix arguments for completion and models', async () => {
  const profile: StoredLlmProfile = { ...processProfile, command: '"C:\\Program Files\\Custom Agent\\launch.exe" --company-mode "project one" --auto' };
  const calls: Array<{ file: string; args: string[] }> = [];
  const runtime: OpencodeRuntime = {
    resolve: async (file) => { assert.equal(file, 'C:\\Program Files\\Custom Agent\\launch.exe'); return { file }; },
    run: async (bin, args) => { calls.push({ file: bin.file, args }); return 'answer'; },
    listModels: async (bin, args) => { calls.push({ file: bin.file, args }); return ''; },
  };
  const provider = new OpencodeCliProvider(profile, runtime);
  assert.equal((await provider.getHealth()).installed, true);
  assert.equal((await provider.complete({ messages: [] })).text, 'answer');
  await provider.listModels();
  assert.deepEqual(calls, [
    { file: 'C:\\Program Files\\Custom Agent\\launch.exe', args: ['--company-mode', 'project one', '--auto', 'run', '--format', 'json', '--title', 'Pulse Metric Studio', '--model', 'provider/model'] },
    { file: 'C:\\Program Files\\Custom Agent\\launch.exe', args: ['--company-mode', 'project one', '--auto', 'models', '--verbose'] },
  ]);
});

test('OpenCode supports an explicit executable interpreter wrapper without launching an implicit shell', async () => {
  const profile: StoredLlmProfile = { ...processProfile, command: 'pwsh -NoProfile -File "C:\\Agent Scripts\\company-opencode.ps1"' };
  const calls: string[][] = [];
  const provider = new OpencodeCliProvider(profile, {
    resolve: async (file) => { assert.equal(file, 'pwsh'); return { file: 'C:\\tools\\pwsh.exe' }; },
    run: async (_bin, args) => { calls.push(args); return 'answer'; },
  });
  await provider.complete({ messages: [] });
  assert.deepEqual(calls[0], ['-NoProfile', '-File', 'C:\\Agent Scripts\\company-opencode.ps1', 'run', '--format', 'json', '--title', 'Pulse Metric Studio', '--model', 'provider/model']);
});

test('native OpenCode options follow run and only catalog-supported options reach models', async () => {
  const profile = { ...processProfile, command: 'opencode --auto --pure --agent company --variant high --log-level WARN --dir "project one"' };
  const calls: string[][] = [];
  const provider = new OpencodeCliProvider(profile, {
    resolve: async (file) => { assert.equal(file, 'opencode'); return { file: 'C:\\tools\\opencode.exe' }; },
    run: async (_bin, args) => { calls.push(args); return 'answer'; },
    listModels: async (_bin, args) => { calls.push(args); return ''; },
  });
  await provider.complete({ messages: [] });
  await provider.listModels();
  assert.deepEqual(calls, [
    ['run', '--auto', '--pure', '--agent', 'company', '--variant', 'high', '--log-level', 'WARN', '--dir', 'project one', '--format', 'json', '--title', 'Pulse Metric Studio', '--model', 'provider/model'],
    ['models', '--pure', '--log-level', 'WARN', '--verbose'],
  ]);
});

test('native OpenCode model discovery uses the configured local run directory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-opencode-catalog-'));
  try {
    const runtime = processFixture(verboseModel('company/model', { id: 'model', name: 'Model', providerID: 'company' }), 0, `
      assert.equal(process.cwd(), ${JSON.stringify(directory)});
      assert.deepEqual(process.argv.slice(1), ['models', '--pure', '--verbose']);
    `);
    const profile = { ...processProfile, command: `opencode --auto --pure --dir "${directory}"` };
    const result = await new OpencodeCliProvider(profile, runtime).listModels();
    assert.deepEqual(result, [{ id: 'company/model', label: 'Model' }]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('OpenCode reports malformed or conflicting native launch options without running a provider', async () => {
  for (const command of ['opencode "unfinished', 'opencode --interactive', 'opencode --format=text', 'opencode --model other/model']) {
    let invocations = 0;
    const provider = new OpencodeCliProvider({ ...processProfile, command }, {
      resolve: async () => ({ file: 'opencode' }),
      run: async () => { invocations += 1; return 'must not run'; },
    });
    const health = await provider.getHealth();
    assert.equal(health.configured, false);
    assert.equal(health.reasonCode, 'not_configured');
    await assert.rejects(provider.complete({ messages: [] }), (error: any) => error.code === 'provider_not_configured');
    assert.equal(invocations, 0);
  }
});

test('OpenCode rejects a blank model instead of using an inherited default', async () => {
  const profile: StoredLlmProfile = {
    id: 'opencode', label: 'OpenCode', protocol: 'opencode', baseUrl: '', model: '', authMode: 'none', secret: null, credentialCommand: null, credentialCommandHint: null,
    headers: {}, region: '', awsProfile: '', command: 'opencode', source: 'saved',
  };
  const runtime: OpencodeRuntime = {
    resolve: async () => ({ file: 'C:\\tools\\opencode.exe' }),
    run: async () => { throw new Error('OpenCode must not run without an explicit model.'); },
  };
  const provider = new OpencodeCliProvider(profile, runtime);
  const health = await provider.getHealth();
  assert.equal(health.configured, false);
  assert.equal(health.reasonCode, 'not_configured');
  await assert.rejects(
    () => provider.complete({ messages: [{ role: 'user', content: 'hello' }] }),
    (error: any) => error?.code === 'provider_not_configured',
  );
});

test('OpenCode preserves native user configuration and tool credentials without app-internal secrets', () => {
  const source = {
    PATH: 'C:\\tools', APPDATA: 'C:\\appdata', XDG_DATA_HOME: '/native/account-data',
    ANTHROPIC_API_KEY: 'provider-secret', SF_OAUTH_CLIENT_SECRET: 'user-tool-secret',
    PULSE_METRIC_STUDIO_MACHINE_KEY: 'internal-secret', pulse_metric_studio_desktop_token: 'internal-token',
    OPENCODE_CONFIG: 'user-config.json', OPENCODE_CONFIG_DIR: 'user-config-dir', OPENCODE_PERMISSION: '{"*":"allow"}',
    OPENCODE_CONFIG_CONTENT: '{"instructions":["USER.md"],"mcp":{"company":{"enabled":true}},"plugin":["company-tools"]}',
    NODE_OPTIONS: '--max-old-space-size=4096', PWD: '/user/project',
  };
  const env = buildOpenCodeChildEnv(source);
  for (const [name, value] of Object.entries(source)) {
    assert.equal(env[name], name.toUpperCase().startsWith('PULSE_METRIC_STUDIO_') ? undefined : value);
  }
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined);
  assert.equal(env.OPENCODE_DISABLE_CLAUDE_CODE, undefined);
  assert.equal(env.OPENCODE_DISABLE_EXTERNAL_SKILLS, undefined);
  assert.equal(env.OPENCODE_DB, undefined);
  assert.equal(source.OPENCODE_PERMISSION, '{"*":"allow"}');
});

test('OpenCode classifies upstream errors and retains only a safe provider reference', () => {
  assert.deepEqual(
    classifyOpenCodeFailure('request failed: upstream server error {"ref":"err_b55b6e98"} token=must-not-escape'),
    { code: 'provider_unavailable', retryable: true, reference: 'err_b55b6e98' },
  );
});

test('OpenCode parses current models from every provider in its verbose catalog', () => {
  const output = [
    verboseModel('opencode/zeta', { id: 'zeta', name: 'Zeta', providerID: 'opencode', cost: { input: 0, output: 0 } }),
    'opencode/malformed',
    '{ invalid json',
    verboseModel('opencode/alpha', { id: 'alpha', name: 'Alpha', providerID: 'opencode', cost: { input: 0, output: 0 } }),
    verboseModel('opencode/paid-input', { id: 'paid-input', name: 'Paid input', providerID: 'opencode', status: 'active', cost: { input: 0.1, output: 0 } }),
    verboseModel('opencode/paid-output', { id: 'paid-output', name: 'Paid output', providerID: 'opencode', status: 'active', cost: { input: 0, output: 1 } }),
    verboseModel('opencode/string-cost', { id: 'string-cost', name: 'String cost', providerID: 'opencode', status: 'active', cost: { input: '0', output: 0 } }),
    verboseModel('opencode/deprecated', { id: 'deprecated', name: 'Deprecated', providerID: 'opencode', status: 'deprecated', cost: { input: 0, output: 0 } }),
    verboseModel('opencode/wrong-provider', { id: 'wrong-provider', name: 'Wrong provider', providerID: 'openai', status: 'active', cost: { input: 0, output: 0 } }),
    verboseModel('opencode/header-mismatch', { id: 'different-id', name: 'Mismatch', providerID: 'opencode', status: 'active', cost: { input: 0, output: 0 } }),
    verboseModel('openai/not-opencode', { id: 'not-opencode', name: 'Other', providerID: 'openai', status: 'active', cost: { input: 2, output: 8 } }),
    verboseModel('opencode/alpha', { id: 'alpha', name: 'Duplicate', providerID: 'opencode', status: 'active', cost: { input: 0, output: 0 } }),
  ].join('\n');

  assert.deepEqual(parseOpenCodeVerboseModels(output), [
    { id: 'openai/not-opencode', label: 'Other' },
    { id: 'opencode/alpha', label: 'Alpha' },
    { id: 'opencode/paid-input', label: 'Paid input' },
    { id: 'opencode/paid-output', label: 'Paid output' },
    { id: 'opencode/string-cost', label: 'String cost' },
    { id: 'opencode/zeta', label: 'Zeta' },
  ]);
});

test('OpenCode returns the complete sorted model response', () => {
  const output = Array.from({ length: 105 }, (_, index) => {
    const id = `model-${String(index).padStart(3, '0')}`;
    return verboseModel(`opencode/${id}`, {
      id,
      name: id,
      providerID: 'opencode',
      status: 'active',
      cost: { input: 0, output: 0 },
    });
  }).reverse().join('\n');

  const models = parseOpenCodeVerboseModels(output);
  assert.equal(models.length, 105);
  assert.equal(models[0]?.id, 'opencode/model-000');
  assert.equal(models.at(-1)?.id, 'opencode/model-104');
});

test('OpenCode model discovery uses the resolved executable and exact non-refresh arguments', async () => {
  const profile: StoredLlmProfile = {
    id: 'opencode', label: 'OpenCode', protocol: 'opencode', baseUrl: '', model: '', authMode: 'none', secret: null, credentialCommand: null, credentialCommandHint: null,
    headers: {}, region: '', awsProfile: '', command: 'C:\\tools\\opencode.exe', source: 'saved',
  };
  const invocations: Array<{ file: string; args: string[] }> = [];
  const runtime: OpencodeRuntime = {
    resolve: async () => ({ file: 'C:\\tools\\opencode.exe' }),
    run: async () => 'unused',
    listModels: async (bin, args) => {
      invocations.push({ file: bin.file, args });
      return verboseModel('opencode/free', {
        id: 'free',
        name: 'Free',
        providerID: 'opencode',
        status: 'active',
        cost: { input: 0, output: 0 },
      });
    },
  };

  const models = await new OpencodeCliProvider(profile, runtime).listModels();
  assert.deepEqual(models, [{ id: 'opencode/free', label: 'Free' }]);
  assert.deepEqual(invocations, [{ file: 'C:\\tools\\opencode.exe', args: ['models', '--verbose'] }]);
});

function verboseModel(header: string, model: Record<string, unknown>): string {
  return `${header}\n${JSON.stringify(model, null, 2)}`;
}


test('OpenCode identifies the free-tier restriction without exposing process diagnostics', () => {
  const failure = classifyOpenCodeFailure('Error from provider (Console): OpenCode\'s free tier can only be used from within OpenCode\nAuthorization: Bearer fixture-private-value');
  assert.equal(failure.code, 'provider_execution');
  assert.equal(failure.retryable, false);
  assert.match(failure.reason ?? '', /launch configuration/i);
  assert.doesNotMatch(failure.reason ?? '', /authenticated|sign in/i);
  assert.equal(failure.reason?.includes('fixture-private-value'), false);
});

test('OpenCode preserves Windows environment casing and user runtime configuration', () => {
  const child = buildOpenCodeChildEnv({ Path: 'C:\\Windows;C:\\tools', SystemRoot: 'C:\\Windows', Temp: 'C:\\temp', NODE_OPTIONS: '--require=hook', PULSE_METRIC_STUDIO_MACHINE_KEY: 'fixture-private-value' });
  assert.equal(child.Path, 'C:\\Windows;C:\\tools');
  assert.equal(child.SystemRoot, 'C:\\Windows');
  assert.equal(child.Temp, 'C:\\temp');
  assert.equal(child.PULSE_METRIC_STUDIO_MACHINE_KEY, undefined);
  assert.equal(child.NODE_OPTIONS, '--require=hook');
  assert.equal(child.OPENCODE_PERMISSION, undefined);
});

test('OpenCode passive setup checks installation without pretending to verify account or model access', async () => {
  const profile: StoredLlmProfile = { id: 'opencode', label: 'OpenCode', protocol: 'opencode', baseUrl: '', model: '', authMode: 'none', secret: null, credentialCommand: null, credentialCommandHint: null, headers: {}, region: '', awsProfile: '', command: 'opencode', source: 'saved' };
  const provider = new OpencodeCliProvider(profile, {
    resolve: async () => ({ file: 'opencode' }),
    run: async () => { throw new Error('Passive setup cannot call the provider.'); },
  });
  const health = await provider.getSetupHealth();
  assert.equal(health.installed, true);
  assert.equal(health.configured, true);
  assert.equal(health.healthy, null);
  assert.match(health.reason ?? '', /Account access is checked by an explicit connection test/);
});

test('OpenCode completion forwards cancellation and does not return partial output after abort', async () => {
  const profile: StoredLlmProfile = { id: 'opencode', label: 'OpenCode', protocol: 'opencode', baseUrl: '', model: 'provider/model', authMode: 'none', secret: null, credentialCommand: null, credentialCommandHint: null, headers: {}, region: '', awsProfile: '', command: 'opencode', source: 'saved' };
  const controller = new AbortController();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const provider = new OpencodeCliProvider(profile, {
    resolve: async () => ({ file: 'opencode' }),
    run: async (_bin, _args, _prompt, _provider, _model, _timeout, signal) => {
      assert.equal(signal, controller.signal);
      return new Promise<string>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
        started();
      });
    },
  });
  const pending = provider.complete({ messages: [], signal: controller.signal });
  const rejected = assert.rejects(pending, (error: any) => error.name === 'AbortError');
  await running;
  controller.abort();
  await rejected;
});

test('OpenCode model discovery forwards the owned operation signal', async () => {
  const profile: StoredLlmProfile = { id: 'opencode', label: 'OpenCode', protocol: 'opencode', baseUrl: '', model: '', authMode: 'none', secret: null, credentialCommand: null, credentialCommandHint: null, headers: {}, region: '', awsProfile: '', command: 'opencode', source: 'saved' };
  const controller = new AbortController();
  const provider = new OpencodeCliProvider(profile, {
    resolve: async () => ({ file: 'opencode' }), run: async () => '',
    listModels: async (_bin, _args, signal) => { assert.equal(signal, controller.signal); return ''; },
  });
  assert.deepEqual(await provider.listModels(controller.signal), []);
  controller.abort();
  await assert.rejects(provider.listModels(controller.signal), (error: any) => error.name === 'AbortError');
});

function processFixture(stdout: string, code = 0, checks = ''): OpencodeRuntime {
  return {
    resolve: async () => ({ file: 'opencode' }),
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: '{"mcp":{"company":{"enabled":true}},"plugin":["company-tools"]}',
      CUSTOM_TOOL_TOKEN: 'fixture-tool-token',
      PULSE_METRIC_STUDIO_MACHINE_KEY: 'internal-secret',
    },
    spawn: (_file, args, options) => spawn(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      let input = '';
      process.stdin.on('data', (chunk) => input += chunk);
      process.stdin.on('end', () => {
        ${checks}
        process.stdout.write(${JSON.stringify(stdout)});
        process.exitCode = ${code};
      });
    `, '--', ...args], options),
  };
}

const events = (...values: unknown[]) => values.map((value) => JSON.stringify(value)).join('\n') + '\n';

test('OpenCode uses native configuration, tool events, and reconciled final text without adding permission flags', async () => {
  const runtime = processFixture(events(
    { type: 'step_start', part: { messageID: 'tool-step' } },
    { type: 'text', part: { messageID: 'tool-step', text: 'Checking with a user tool.' } },
    { type: 'tool_use', part: { tool: 'read', state: { status: 'completed', output: 'user tool output' } } },
    { type: 'step_finish', part: { messageID: 'tool-step', reason: 'tool-calls' } },
    { type: 'step_start', part: { messageID: 'final-step' } },
    { type: 'reasoning', part: { text: 'private reasoning' } },
    { type: 'text', part: { id: 'live-part-id', messageID: 'final-step', text: 'Final answer:\nna' } },
    { type: 'step_finish', part: { messageID: 'final-step', reason: 'stop' } },
    // Native reconciliation runs after the terminal event and changes part IDs.
    { type: 'text', part: { id: 'tool-step:text-0', messageID: 'tool-step', text: ' Earlier tool-step suffix.' } },
    { type: 'tool_use', part: { tool: 'read', state: { status: 'completed', output: 'late tool reconciliation' } } },
    { type: 'text', part: { id: 'final-step:text-0', messageID: 'final-step', text: 'tive text' } },
  ), 0, `
    assert.equal(process.cwd(), ${JSON.stringify(os.homedir())});
    assert.deepEqual(process.argv.slice(1), ['run', '--format', 'json', '--title', 'Pulse Metric Studio', '--model', 'provider/model']);
    assert.equal(process.env.CUSTOM_TOOL_TOKEN, 'fixture-tool-token');
    assert.equal(process.env.PULSE_METRIC_STUDIO_MACHINE_KEY, undefined);
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(config.mcp, {company:{enabled:true}});
    assert.deepEqual(config.plugin, ['company-tools']);
    assert.equal(process.env.OPENCODE_DISABLE_PROJECT_CONFIG, undefined);
    assert.match(input, /private & prompt/);
  `);
  const result = await new OpencodeCliProvider(processProfile, runtime).complete({ messages: [{ role: 'user', content: 'private & prompt' }] });
  assert.equal(result.text, 'Final answer:\nnative text');
});

test('OpenCode rejects failed or unfinished requests instead of returning partial answers', async () => {
  for (const fixture of [
    { output: events({ type: 'text', part: { text: 'partial answer' } }), code: 0, expected: 'provider_execution' },
    { output: events({ type: 'text', part: { text: 'partial answer' } }, { type: 'error', error: { message: 'invalid API key fixture-secret' } }), code: 0, expected: 'provider_authentication' },
    { output: events({ type: 'error', error: { data: { message: 'rate limit reached' } } }), code: 1, expected: 'provider_quota' },
    { output: events({ type: 'text', part: { messageID: 'final', text: 'answer' } }, { type: 'step_finish', part: { messageID: 'final', reason: 'stop' } }), code: 1, expected: 'provider_execution' },
    { output: events({ type: 'text', part: { messageID: 'final', text: 'answer' } }, { type: 'step_finish', part: { messageID: 'final', reason: 'length' } }), code: 0, expected: 'provider_execution' },
    { output: 'unrecognized output\n', code: 0, expected: 'provider_execution' },
  ]) {
    const provider = new OpencodeCliProvider(processProfile, processFixture(fixture.output, fixture.code));
    await assert.rejects(provider.complete({ messages: [] }), (error: any) => {
      assert.equal(error.code, fixture.expected);
      assert.doesNotMatch(error.message, /fixture-secret|partial answer/);
      return true;
    });
  }
});

test('OpenCode keeps a completed answer after recoverable tool errors and plugin diagnostics', async () => {
  const stdout = 'Company plugin initialized\n' + events(
    { type: 'step_start', part: { messageID: 'tool' } },
    { type: 'tool_use', part: { tool: 'read', state: { status: 'error', error: 'Permission rejected for optional file' } } },
    { type: 'step_finish', part: { messageID: 'tool', reason: 'tool-calls' } },
    { type: 'step_start', part: { messageID: 'answer' } },
    { type: 'text', part: { messageID: 'answer', text: 'Completed without that file.' } },
    { type: 'step_finish', part: { messageID: 'answer', reason: 'stop' } },
  );
  const result = await new OpencodeCliProvider(processProfile, processFixture(stdout)).complete({ messages: [] });
  assert.equal(result.text, 'Completed without that file.');
});

test('OpenCode reports unavailable headless tool approval without silently changing user permissions', async () => {
  const stdout = events(
    { type: 'step_start', part: { messageID: 'tool' } },
    { type: 'tool_use', part: { tool: 'bash', state: { status: 'error', error: 'Permission request rejected because no interactive approval is available' } } },
    { type: 'step_finish', part: { messageID: 'tool', reason: 'tool-calls' } },
  );
  const runtime = processFixture(stdout);
  const originalSpawn = runtime.spawn!;
  runtime.spawn = (file, args, options) => {
    assert.equal(args.includes('--auto'), false);
    assert.equal(args.includes('--pure'), false);
    return originalSpawn(file, args, options);
  };
  await assert.rejects(new OpencodeCliProvider(processProfile, runtime).complete({ messages: [] }), (error: any) => {
    assert.match(error.message, /needs tool approval.*headless/);
    assert.equal(error.retryable, false);
    return true;
  });
});
