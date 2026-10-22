import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { StoredLlmProfile } from '../profiles.js';
import {
  buildOpenCodeChildEnv,
  buildOpenCodeRequestEnv,
  assertOpenCodeRequestConfig,
  classifyOpenCodeFailure,
  OpencodeCliProvider,
  parseOpenCodeVerboseModels,
  type OpencodeRuntime,
} from './opencode-cli.js';

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
  assert.deepEqual(invocation.args, ['--pure', 'run', '--model', 'provider/model-1']);
  assert.equal(invocation.args.includes('value & whoami'), false);
  assert.match(invocation.prompt, /value & whoami/);
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

test('OpenCode child environment excludes unrelated application secrets and enforces isolation config', () => {
  const env = buildOpenCodeChildEnv({
    PATH: 'C:\\tools',
    APPDATA: 'C:\\appdata',
    ANTHROPIC_API_KEY: 'allowed-provider-secret',
    SF_OAUTH_CLIENT_SECRET: 'salesforce-secret',
    PULSE_METRIC_STUDIO_MACHINE_KEY: 'pulse-metric-studio-secret',
    OPENCODE_CONFIG_CONTENT: '{"provider":{"company":{"npm":"@ai-sdk/anthropic"}},"permission":{"*":"allow"}}',
  });
  assert.equal(env.SF_OAUTH_CLIENT_SECRET, undefined);
  assert.equal(env.PULSE_METRIC_STUDIO_MACHINE_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, 'allowed-provider-secret');
  assert.equal(env.PATH, 'C:\\tools');
  assert.deepEqual(JSON.parse(String(env.OPENCODE_CONFIG_CONTENT)), {
    provider: { company: { npm: '@ai-sdk/anthropic' } },
    permission: { '*': 'deny' },
    share: 'disabled',
  });
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
  assert.deepEqual(invocations, [{ file: 'C:\\tools\\opencode.exe', args: ['--pure', 'models', '--verbose'] }]);
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

test('OpenCode completion selects an app-owned approval agent and disables every inherited MCP server', () => {
  const env = buildOpenCodeChildEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { local: { name: 'Local' } } }) });
  const request = buildOpenCodeRequestEnv(env, {
    permission: { '*': 'allow' },
    agent: { build: { permission: { '*': 'allow' } } },
    mcp: { local: { enabled: true, command: ['unsafe'] }, remote: { url: 'https://example.test' } },
  }, 'pulse-metric-studio-test');
  const config = JSON.parse(request.OPENCODE_CONFIG_CONTENT!);
  assert.deepEqual(config.agent, { 'pulse-metric-studio-test': { mode: 'primary', permission: { '*': 'ask' } } });
  assert.deepEqual(config.mcp, { local: { enabled: false }, remote: { enabled: false } });
  assert.deepEqual(config.provider, { local: { name: 'Local' } });
  assert.equal(request.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.doesNotThrow(() => assertOpenCodeRequestConfig(config, 'pulse-metric-studio-test'));
});

test('OpenCode refuses a completion when effective configuration overrides its restrictions', () => {
  const valid = {
    agent: { 'pulse-metric-studio-test': { mode: 'primary', permission: { '*': 'ask' } } },
    mcp: { local: { enabled: false } }, share: 'disabled',
  };
  for (const changed of [
    { ...valid, agent: {} },
    { ...valid, agent: { 'pulse-metric-studio-test': { ...valid.agent['pulse-metric-studio-test'], disable: true } } },
    { ...valid, agent: { 'pulse-metric-studio-test': { ...valid.agent['pulse-metric-studio-test'], hidden: true } } },
    { ...valid, agent: { 'pulse-metric-studio-test': { mode: 'primary', permission: { '*': 'ask', bash: 'allow' } } } },
    { ...valid, agent: { 'pulse-metric-studio-test': { mode: 'primary', permission: { '*': 'allow' } } } },
    { ...valid, mcp: { injected: { command: ['unsafe'] } } },
    { ...valid, mcp: { injected: { enabled: true } } },
    { ...valid, share: 'auto' },
  ]) assert.throws(() => assertOpenCodeRequestConfig(changed, 'pulse-metric-studio-test'), /tool restrictions/);
});

test('OpenCode preserves Windows environment casing for executable lookup and required system paths', () => {
  const child = buildOpenCodeChildEnv({ Path: 'C:\\Windows;C:\\tools', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', Temp: 'C:\\temp', PULSE_METRIC_STUDIO_MACHINE_KEY: 'fixture-private-value' }, 'win32');
  assert.equal(child.Path, 'C:\\Windows;C:\\tools');
  assert.equal(child.SystemRoot, 'C:\\Windows');
  assert.equal(child.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(child.Temp, 'C:\\temp');
  assert.equal(child.PULSE_METRIC_STUDIO_MACHINE_KEY, undefined);
  assert.deepEqual(JSON.parse(child.OPENCODE_CONFIG_CONTENT!).permission, { '*': 'deny' });
  assert.equal(buildOpenCodeChildEnv({ path: '/untrusted', PATH: '/usr/bin' }, 'darwin').path, undefined);
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
