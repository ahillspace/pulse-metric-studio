import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoredLlmProfile } from '../profiles.js';
import { BedrockProvider, classifyBedrockError } from './bedrock.js';
import { clearCredentialCache } from './credential.js';
import { LlmProviderError } from '../types.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { ProviderRegistry } from '../registry.js';

const allowEndpoint = async () => undefined;

test('ordinary registry completion resolves an installed SDK credential_process once and reuses the client', async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-bedrock-sdk-'));
  const keys = ['AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const counter = path.join(temporary, 'count');
  const expiration = path.join(temporary, 'expiration');
  fs.writeFileSync(expiration, '2099-01-01T00:00:00Z');
  const helper = path.join(temporary, 'credentials.cjs');
  fs.writeFileSync(helper, `const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(counter)}, 'called\\n'); process.stdout.write(JSON.stringify({Version:1,AccessKeyId:'fixture-access',SecretAccessKey:'fixture-secret',SessionToken:'fixture-token',Expiration:fs.readFileSync(${JSON.stringify(expiration)},'utf8')}));`);
  fs.writeFileSync(path.join(temporary, 'config'), `[profile fixture]\ncredential_process = "${process.execPath}" "${helper}"\n`);
  fs.writeFileSync(path.join(temporary, 'credentials'), '');
  for (const key of keys) delete process.env[key];
  process.env.AWS_CONFIG_FILE = path.join(temporary, 'config');
  process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(temporary, 'credentials');
  const originalSend = BedrockRuntimeClient.prototype.send;
  let sends = 0;
  t.mock.method(BedrockRuntimeClient.prototype, 'send', function (this: BedrockRuntimeClient, ...args: any[]) {
    this.config.requestHandler = {
      handle: async () => {
        sends++;
        return { response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ output: { message: { role: 'assistant', content: [{ text: 'OK' }] } }, stopReason: 'end_turn' })) } };
      },
      updateHttpClientConfig: () => {}, httpHandlerConfigs: () => ({}),
    };
    return Reflect.apply(originalSend, this, args);
  });
  const profile: StoredLlmProfile = {
    id: 'sdk-fixture', label: 'SDK fixture', protocol: 'bedrock-converse', baseUrl: '', model: 'fixture-model',
    authMode: 'aws', secret: null, headers: {}, region: 'us-east-1', awsProfile: 'fixture', command: '',
    credentialCommand: null, credentialCommandHint: null, source: 'saved',
  };
  const created: BedrockProvider[] = [];
  const registry = new ProviderRegistry({
    environment: {}, store: { list: () => [profile], save: async (value) => value, delete: async () => {} },
    stateStore: { getActive: () => profile.id, setActive: () => {}, getReadiness: () => null, setReadiness: () => {}, deleteReadiness: () => {} },
    providerFactory: (value) => { const provider = new BedrockProvider(value); created.push(provider); return provider; },
  });
  try {
    assert.equal((await (await registry.pick()).complete({ messages: [{ role: 'user', content: 'hello' }] })).text, 'OK');
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1);
    await (await registry.pick()).complete({ messages: [{ role: 'user', content: 'again' }] });
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1);
    assert.equal(sends, 2);
    assert.equal(created.length, 1, 'unchanged registry profile reuses its provider');
    assert.equal(created[0].client(), created[0].client());
    await registry.status();
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 1, 'passive status never executes AWS credential helpers');
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2099-01-02T00:00:00Z') });
    fs.writeFileSync(expiration, '2100-01-01T00:00:00Z');
    await (await registry.pick()).complete({ messages: [{ role: 'user', content: 'refresh' }] });
    assert.equal(fs.readFileSync(counter, 'utf8').trim().split('\n').length, 2, 'the installed SDK refreshes expired credentials');
    assert.equal(sends, 3);
  } finally {
    await registry.close();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('Bedrock bearer and SDK requests honor caller cancellation', async () => {
  for (const authMode of ['bearer', 'aws'] as const) {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const waitForCancellation = (signal?: AbortSignal | null): Promise<never> => new Promise((_resolve, reject) => {
      started();
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const provider = new BedrockProvider({
      id: 'bedrock', label: 'Bedrock', protocol: 'bedrock-converse', baseUrl: '', model: 'test-model',
      authMode, secret: { value: 'test-secret' }, headers: {}, credentialCommand: null, credentialCommandHint: null, region: 'us-west-2', awsProfile: '', command: '', source: 'saved',
    }, async (_input, init) => waitForCancellation(init?.signal), allowEndpoint);
    provider.getHealth = async () => ({ installed: true, configured: true, healthy: null, reasonCode: 'not_tested', reason: null, resolvedModel: 'test-model' });
    provider.client = () => ({ send: async (_command: unknown, options: { abortSignal?: AbortSignal }) => waitForCancellation(options.abortSignal) }) as unknown as ReturnType<BedrockProvider['client']>;
    const pending = provider.complete({ messages: [], signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await ready;
    controller.abort();
    await rejected;
  }
});

test('retiring a Bedrock provider drains an admitted SDK request before destroying its client', async () => {
  const provider = new BedrockProvider({
    id: 'retiring', label: 'Retiring', protocol: 'bedrock-converse', baseUrl: '', model: 'fixture-model',
    authMode: 'aws', secret: null, headers: {}, region: 'us-east-1', awsProfile: '', command: '',
    credentialCommand: null, credentialCommandHint: null, source: 'saved',
  });
  const client = provider.client();
  let destroyed = 0;
  let finish!: (response: any) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  client.send = (() => { started(); return new Promise((resolve) => { finish = resolve; }); }) as typeof client.send;
  client.destroy = () => { destroyed++; };
  const pending = provider.complete({ messages: [] });
  await ready;
  provider.dispose();
  assert.equal(destroyed, 0);
  await assert.rejects(() => provider.complete({ messages: [] }), /no longer active/);
  finish({ output: { message: { content: [{ text: 'done' }] } } });
  assert.equal((await pending).text, 'done');
  assert.equal(destroyed, 1);
  provider.dispose();
  assert.equal(destroyed, 1);
});

test('Bedrock bearer profiles use the verified Converse HTTP contract', async () => {
  const profile: StoredLlmProfile = {
    id: 'bedrock-key', label: 'Bedrock API key', protocol: 'bedrock-converse', baseUrl: '',
    model: 'us.anthropic.claude-model', authMode: 'bearer', secret: { value: 'bedrock-secret' }, headers: {}, credentialCommand: null, credentialCommandHint: null,
    region: 'us-west-2', awsProfile: '', command: '', source: 'saved',
  };
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const provider = new BedrockProvider(profile, async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Response.json({ output: { message: { content: [{ text: 'done' }] } } });
  }, allowEndpoint);
  const result = await provider.complete({ system: 'system', messages: [{ role: 'user', content: 'hello' }] });
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.url, 'https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-model/converse');
  assert.equal((request.init.headers as Record<string, string>).Authorization, 'Bearer bedrock-secret');
  assert.equal(request.init.redirect, 'error');
  assert.equal(JSON.parse(String(request.init.body)).messages[0].content[0].text, 'hello');
  // Current Claude models reject sampling parameters such as temperature.
  assert.deepEqual(JSON.parse(String(request.init.body)).inferenceConfig, { maxTokens: 4096 });
  assert.equal(result.text, 'done');
});

test('Bedrock bearer profiles mint the token from a credential command', async () => {
  clearCredentialCache();
  const profile: StoredLlmProfile = {
    id: 'bedrock-key', label: 'Bedrock API key', protocol: 'bedrock-converse', baseUrl: '',
    model: 'us.anthropic.claude-model', authMode: 'bearer', secret: null, headers: {},
    region: 'us-west-2', awsProfile: '', command: '', credentialCommand: { value: `node -e "process.stdout.write('MINTED-TOKEN')"` }, credentialCommandHint: 'node ...', source: 'saved',
  };
  const requests: Array<{ init: RequestInit }> = [];
  const provider = new BedrockProvider(profile, async (_input, init) => {
    requests.push({ init: init ?? {} });
    return Response.json({ output: { message: { content: [{ text: 'done' }] } } });
  }, allowEndpoint);
  assert.equal((await provider.getHealth()).configured, true);
  const result = await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.text, 'done');
  assert.equal((requests[0]?.init.headers as Record<string, string>).Authorization, 'Bearer MINTED-TOKEN');
});

test('Bedrock bearer timeout failures are classified as provider timeouts', async () => {
  const profile: StoredLlmProfile = {
    id: 'bedrock-key', label: 'Bedrock API key', protocol: 'bedrock-converse', baseUrl: '',
    model: 'us.anthropic.claude-model', authMode: 'bearer', secret: { value: 'bedrock-secret' }, headers: {}, credentialCommand: null, credentialCommandHint: null,
    region: 'us-west-2', awsProfile: '', command: '', source: 'saved',
  };
  const provider = new BedrockProvider(profile, async () => {
    throw new DOMException('Timed out', 'TimeoutError');
  }, allowEndpoint);
  await assert.rejects(
    () => provider.complete({ messages: [{ role: 'user', content: 'hello' }] }),
    (error: any) => error?.code === 'provider_timeout' && error?.retryable === true,
  );
});

test('Bedrock SDK errors use AWS names and status metadata for classification', () => {
  assert.equal(classifyBedrockError({ name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }).code, 'provider_authentication');
  assert.equal(classifyBedrockError({ name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } }).code, 'provider_quota');
  assert.equal(classifyBedrockError({ name: 'ServiceUnavailableException', $metadata: { httpStatusCode: 503 } }).code, 'provider_unavailable');
});

test('Bedrock bearer failures surface the gateway explanation and truncation', async () => {
  const profile: StoredLlmProfile = {
    id: 'gateway', label: 'Gateway', protocol: 'bedrock-converse', baseUrl: 'https://gateway.example.test/bedrock',
    model: 'claude-model', authMode: 'bearer', secret: { value: 'gateway-secret' }, headers: {}, credentialCommand: null, credentialCommandHint: null,
    region: 'us-east-2', awsProfile: '', command: '', source: 'saved',
  };
  const rejecting = new BedrockProvider(profile, async () => Response.json(
    { detail: { error: JSON.stringify({ message: 'The model returned the following errors: `temperature` is deprecated for this model.' }) } },
    { status: 400 },
  ), allowEndpoint);
  await assert.rejects(() => rejecting.complete({ messages: [{ role: 'user', content: 'hello' }] }), (error: unknown) =>
    error instanceof LlmProviderError && error.message === 'Amazon Bedrock request failed with HTTP 400: The model returned the following errors: `temperature` is deprecated for this model.');
  const truncating = new BedrockProvider(profile, async () => Response.json({ output: { message: { content: [{ text: '{"ops":[' }] } }, stopReason: 'max_tokens' }), allowEndpoint);
  assert.equal((await truncating.complete({ messages: [{ role: 'user', content: 'hello' }] })).truncated, true);
});
