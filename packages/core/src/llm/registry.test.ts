import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerLlmRoutes } from './routes.js';
import type { LlmProfileWrite } from '@pulse-metric-studio/shared';
import {
  LlmModelCatalogError,
  LlmProviderError,
  ProviderRegistry,
  type LlmProvider,
} from './index.js';
import {
  type LlmProfileStore,
  type LlmRegistryStateStore,
  type StoredLlmProfile,
  type StoredLlmReadiness,
  toPublicProfile,
} from './profiles.js';

function provider(id: string, complete: () => Promise<'ok'> = async () => 'ok'): LlmProvider {
  return {
    id,
    label: id,
    isConfigured: async () => true,
    getHealth: async () => ({
      installed: true,
      configured: true,
      healthy: null,
      reasonCode: 'not_tested',
      reason: 'Not tested.',
      resolvedModel: `${id}-model`,
    }),
    complete: async () => {
      await complete();
      return { text: 'ok', provider: id, model: `${id}-model` };
    },
  };
}

test('clean installation profiles route offers no synthetic broken providers', async () => {
  const registry = new ProviderRegistry({ store: memoryProfiles([]), stateStore: memoryState(null), environment: {} });
  const app = Fastify();
  registerLlmRoutes(app, { service: registry });
  try {
    const response = await app.inject('/api/llm/profiles');
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { profiles: [] });
  } finally { await app.close(); }
});

test('clean setup discovers OpenCode models without creating a profile', async () => {
  const registry = new ProviderRegistry({ store: memoryProfiles([]), stateStore: memoryState(null), environment: {}, providerFactory: withModels(async () => [{ id: 'example/model', label: 'Example model' }]) });
  const app = Fastify();
  registerLlmRoutes(app, { service: registry });
  try {
    const response = await app.inject('/api/llm/setup/opencode/models');
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().models[0].id, 'example/model');
    assert.deepEqual(await registry.listProfiles(), []);
  } finally { await app.close(); }
});

test('saved profiles remain intact regardless of availability or empty environment', async () => {
  const profiles = [storedProfile('opencode', 'opencode', 'saved/model'), storedProfile('company', 'openai-responses', 'company-model')];
  const registry = new ProviderRegistry({ store: memoryProfiles(profiles), stateStore: memoryState('company'), environment: {} });
  assert.deepEqual(await registry.listProfiles(), profiles.map(toPublicProfile));
});

test('explicit environment profiles remain available and saved profiles take precedence', async () => {
  const saved = storedProfile('opencode', 'opencode', 'saved/model');
  const registry = new ProviderRegistry({ store: memoryProfiles([saved]), stateStore: memoryState('opencode'), environment: { OPENCODE_MODEL: 'environment/model', OPENAI_COMPAT_MODEL: 'api-model', OPENAI_COMPAT_BASE_URL: 'https://api.example.test/v1' } });
  const profiles = await registry.listProfiles();
  assert.equal(profiles.length, 2);
  assert.deepEqual(profiles.find(profile => profile.id === 'opencode'), toPublicProfile(saved));
  assert.equal(profiles.find(profile => profile.id === 'openai-compat')?.model, 'api-model');
});

test('OpenCode executable location alone is a setup preference, not a configured provider', async () => {
  let command = '';
  const registry = new ProviderRegistry({ store: memoryProfiles([]), stateStore: memoryState(null), environment: { OPENCODE_BIN: 'custom-opencode' }, providerFactory: withModels(async profile => { command = profile.command; return []; }) });
  assert.deepEqual(await registry.listProfiles(), []);
  await registry.listSetupModels();
  assert.equal(command, 'custom-opencode');
  await registry.listSetupModels('opencode', 'other-opencode');
  assert.equal(command, 'other-opencode');
});

test('stored automatic selection migrates to OpenCode and reports yellow readiness', async () => {
  const state = memoryState('auto');
  const registry = new ProviderRegistry({ providers: [provider('opencode')], stateStore: state });

  const status = await registry.status();

  assert.equal(status.active, 'opencode');
  assert.equal(status.resolvedProvider, 'opencode');
  assert.equal(status.readiness.state, 'yellow');
  assert.equal(state.getActive(), 'opencode');
});

test('OpenCode is the initial provider when no selection is stored', async () => {
  const registry = new ProviderRegistry({ providers: [provider('opencode')], stateStore: memoryState(null) });
  assert.equal((await registry.status()).active, 'opencode');
});

test('automatic provider selection cannot be selected', async () => {
  const registry = new ProviderRegistry({ providers: [provider('opencode')], stateStore: memoryState('opencode') });
  await assert.rejects(() => registry.setActive('auto'), LlmModelCatalogError);
});

test('successful provider completion persists green readiness across registry instances once the caller commits semantic success', async () => {
  const state = memoryState('opencode');
  const now = () => new Date('2026-08-29T12:00:00.000Z');
  const selectedProvider = provider('opencode');
  const first = new ProviderRegistry({ providers: [selectedProvider], stateStore: state, now });

  assert.equal((await first.status()).readiness.state, 'yellow');
  const tracked = await first.pick();
  await tracked.complete({ messages: [{ role: 'user', content: 'hello' }] });
  tracked.tracking!.commitSuccess();

  const restarted = new ProviderRegistry({ providers: [selectedProvider], stateStore: state, now });
  const status = await restarted.status();
  assert.equal(status.readiness.state, 'green');
  assert.equal(status.readiness.lastSuccessfulAt, '2026-08-29T12:00:00.000Z');
});

test('provider output alone never records chat success', async () => {
  const state = memoryState('opencode');
  const selectedProvider = provider('opencode');
  const registry = new ProviderRegistry({ providers: [selectedProvider], stateStore: state });

  await (await registry.pick()).complete({ messages: [{ role: 'user', content: 'hello' }] });

  const status = await registry.status();
  assert.equal(status.readiness.state, 'yellow');
  assert.equal(status.readiness.lastSuccessfulAt, null);
});

test('a caller-declared semantic failure turns readiness red after provider output', async () => {
  const state = memoryState('opencode');
  const now = () => new Date('2026-08-29T12:00:00.000Z');
  const selectedProvider = provider('opencode');
  const registry = new ProviderRegistry({ providers: [selectedProvider], stateStore: state, now });

  const tracked = await registry.pick();
  const result = await tracked.complete({ messages: [{ role: 'user', content: 'invalid request' }] });
  assert.equal(typeof result.text, 'string'); // provider returned something...
  tracked.tracking!.commitFailure('invalid_response', 'Model could not produce valid ops.');

  const status = await registry.status();
  assert.equal(status.readiness.state, 'red');
  assert.match(status.readiness.message ?? '', /Model could not produce valid ops\./);
  assert.equal(status.readiness.lastSuccessfulAt, null);
});

test('committing failure does not erase a prior distinct-launch success but does not keep it green', async () => {
  const state = memoryState('opencode');
  const now = (): Date => new Date('2026-08-29T12:00:00.000Z');
  const selectedProvider = provider('opencode');
  const registry = new ProviderRegistry({ providers: [selectedProvider], stateStore: state, now });

  const success = await registry.pick();
  await success.complete({ messages: [{ role: 'user', content: 'fine' }] });
  success.tracking!.commitSuccess();
  assert.equal((await registry.status()).readiness.state, 'green');

  const failed = await registry.pick();
  await failed.complete({ messages: [{ role: 'user', content: 'bad' }] });
  failed.tracking!.commitFailure('invalid_response', 'unparsable output');

  const status = await registry.status();
  assert.equal(status.readiness.state, 'red');
  assert.equal(status.readiness.lastSuccessfulAt, '2026-08-29T12:00:00.000Z');
});

test('double semantic commits on one picked provider keep the first outcome', async () => {
  const state = memoryState('opencode');
  const registry = new ProviderRegistry({ providers: [provider('opencode')], stateStore: state });

  const tracked = await registry.pick();
  tracked.tracking!.commitSuccess();
  tracked.tracking!.commitFailure('invalid_response', 'late failure');
  tracked.tracking!.commitFailure('transport_failed', 'later still');

  assert.equal((await registry.status()).readiness.state, 'green');
});

test('selecting the already-active unchanged profile preserves successful readiness', async () => {
  const state = memoryState('opencode');
  const selectedProvider = provider('opencode');
  const registry = new ProviderRegistry({ providers: [selectedProvider], stateStore: state });

  const tracked = await registry.pick();
  await tracked.complete({ messages: [{ role: 'user', content: 'reply' }] });
  tracked.tracking!.commitSuccess();
  assert.equal((await registry.status()).readiness.state, 'green');

  await registry.setActive('opencode');
  const status = await registry.status();
  assert.equal(status.readiness.state, 'green');
  assert.ok(status.readiness.lastSuccessfulAt, 'green success timestamp preserved');
});

test('provider failures are still recorded as failure by the tracked wrapper', async () => {
  const state = memoryState('opencode');
  let fails = false;
  const selectedProvider = provider('opencode', async () => {
    if (fails) throw new LlmProviderError({ code: 'provider_unavailable', message: 'Provider unavailable.', provider: 'opencode' });
    return 'ok';
  });
  const registry = new ProviderRegistry({
    providers: [selectedProvider],
    stateStore: state,
    now: () => new Date(fails ? '2026-08-29T12:05:00.000Z' : '2026-08-29T12:00:00.000Z'),
  });

  const first = await registry.pick();
  await first.complete({ messages: [{ role: 'user', content: 'first' }] });
  first.tracking!.commitSuccess();

  fails = true;
  await assert.rejects(() => registry.pick().then((chosen) => chosen.complete({ messages: [{ role: 'user', content: 'second' }] })));

  const status = await registry.status();
  assert.equal(status.readiness.state, 'red');
  assert.equal(status.readiness.lastSuccessfulAt, '2026-08-29T12:00:00.000Z');
});

test('connection test requires the expected semantic response before it records success', async () => {
  const state = memoryState('opencode');
  const unexpectedText: LlmProvider = {
    ...provider('opencode'),
    complete: async () => ({ text: 'The provider is available.', provider: 'opencode', model: 'opencode-model' }),
  };
  const registry = new ProviderRegistry({ providers: [unexpectedText], stateStore: state });

  await assert.rejects(
    () => registry.testProfile('opencode'),
    (error: unknown) => error instanceof LlmProviderError && error.code === 'invalid_model_output',
  );

  const status = await registry.status();
  assert.equal(status.readiness.state, 'red');
  assert.equal(status.readiness.lastSuccessfulAt, null);
});

test('connection test accepts a case-insensitive single-word OK response', async () => {
  const state = memoryState('opencode');
  const expectedText: LlmProvider = {
    ...provider('opencode'),
    complete: async () => ({ text: '  ok  ', provider: 'opencode', model: 'opencode-model' }),
  };
  const registry = new ProviderRegistry({ providers: [expectedText], stateStore: state });

  await registry.testProfile('opencode');

  assert.equal((await registry.status()).readiness.state, 'green');
});

test('changing the selected provider resets prior green readiness to yellow', async () => {
  const state = memoryState('first');
  const registry = new ProviderRegistry({ providers: [provider('first'), provider('second')], stateStore: state });
  await registry.testProfile('second');

  await registry.setActive('second');

  assert.equal((await registry.status()).readiness.state, 'yellow');
});

test('blank and unavailable OpenCode models cannot be saved or used', async () => {
  const store = memoryProfiles([storedProfile('opencode', 'opencode', '')]);
  const state = memoryState('opencode');
  const registry = new ProviderRegistry({
    store,
    stateStore: state,
    providerFactory: withModels(async () => [{ id: 'opencode/current', label: 'Current' }]),
  });

  await assert.rejects(
    () => registry.saveProfile(openCodeWrite('')),
    /Select a model from the current OpenCode model catalog/,
  );
  await assert.rejects(
    () => registry.saveProfile(openCodeWrite('opencode/stale')),
    /is not available in the current model catalog/,
  );
});

test('saving a current OpenCode model persists the explicit catalog model', async () => {
  const store = memoryProfiles([storedProfile('opencode', 'opencode', '')]);
  const registry = new ProviderRegistry({
    store,
    stateStore: memoryState('opencode'),
    providerFactory: withModels(async () => [{ id: 'opencode/current', label: 'Current' }]),
  });

  await registry.saveProfile(openCodeWrite('opencode/current'));
  assert.equal(store.get('opencode')?.model, 'opencode/current');
});

test('an unconfigured selected provider reports red readiness', async () => {
  const unconfigured = provider('opencode');
  unconfigured.getHealth = async () => ({
    installed: true,
    configured: false,
    healthy: false,
    reasonCode: 'not_configured',
    reason: 'Select a model.',
    resolvedModel: null,
  });
  const registry = new ProviderRegistry({ providers: [unconfigured], stateStore: memoryState('opencode') });
  assert.equal((await registry.status()).readiness.state, 'red');
});

test('configuration changes clear persisted readiness for that profile', async () => {
  const store = memoryProfiles([storedProfile('gateway', 'openai-chat', 'model-1')]);
  const state = memoryState('gateway');
  state.setReadiness('gateway', successfulReadiness('old-fingerprint'));
  const registry = new ProviderRegistry({ store, stateStore: state });

  await registry.saveProfile({
    id: 'gateway',
    label: 'Gateway',
    protocol: 'openai-chat',
    baseUrl: 'https://gateway.example.test/v1',
    model: 'model-2',
    authMode: 'none',
    headers: {},
  });

  assert.equal(state.getReadiness('gateway'), null);
  assert.equal((await registry.status()).readiness.state, 'yellow');
});

test('model catalog resolves an existing OpenCode profile through the shared registry', async () => {
  const profile = storedProfile('opencode-profile', 'opencode', 'opencode/current');
  const seen: StoredLlmProfile[] = [];
  const registry = new ProviderRegistry({
    store: memoryProfiles([profile]),
    stateStore: memoryState('opencode-profile'),
    providerFactory: withModels(async (resolved) => {
      seen.push(resolved);
      return [{ id: 'opencode/current', label: 'Current' }];
    }),
  });

  assert.deepEqual(await registry.listModels(profile.id), {
    provider: 'opencode',
    source: 'provider',
    selection: 'catalog',
    models: [{ id: 'opencode/current', label: 'Current' }],
  });
  assert.deepEqual(seen, [profile]);
});

test('model discovery rejects missing profiles and supports manual API models', async () => {
  const registry = new ProviderRegistry({
    store: memoryProfiles([storedProfile('gateway', 'openai-chat', 'model-1')]),
    stateStore: memoryState('gateway'),
    providerFactory: profile => provider(profile.id),
  });

  await assert.rejects(() => registry.listModels('missing'), LlmModelCatalogError);
  assert.deepEqual(await registry.listModels('gateway'), { provider: 'openai-chat', source: 'manual', selection: 'manual', models: [] });
});

function openCodeWrite(model: string): LlmProfileWrite {
  return {
    id: 'opencode',
    label: 'OpenCode',
    protocol: 'opencode',
    model,
    authMode: 'none',
    command: 'opencode',
  };
}

function storedProfile(id: string, protocol: StoredLlmProfile['protocol'], model: string): StoredLlmProfile {
  return {
    id,
    label: id,
    protocol,
    baseUrl: protocol === 'opencode' ? '' : 'https://gateway.example.test/v1',
    model,
    authMode: 'none',
    secret: '',
    headers: {},
    region: '',
    awsProfile: '',
    command: protocol === 'opencode' ? 'opencode' : '',
    source: 'saved',
  };
}

function memoryProfiles(initial: StoredLlmProfile[]): LlmProfileStore {
  let profiles = [...initial];
  return {
    list: () => [...profiles],
    get: (id) => profiles.find((profile) => profile.id === id) ?? null,
    save: (input) => {
      const existing = profiles.find((profile) => profile.id === input.id);
      const saved: StoredLlmProfile = {
        id: input.id,
        label: input.label,
        protocol: input.protocol,
        baseUrl: input.baseUrl ?? '',
        model: input.model ?? '',
        authMode: input.authMode ?? 'none',
        secret: input.clearSecret ? '' : input.secret ?? existing?.secret ?? '',
        headers: input.clearHeaders ? {} : input.headers ?? existing?.headers ?? {},
        region: input.region ?? '',
        awsProfile: input.awsProfile ?? '',
        command: input.command ?? '',
        allowPrivateNetwork: input.allowPrivateNetwork ?? false,
        source: 'saved',
      };
      profiles = [...profiles.filter((profile) => profile.id !== input.id), saved];
      return toPublicProfile(saved);
    },
    delete: (id) => { profiles = profiles.filter((profile) => profile.id !== id); },
    publicList: () => profiles.map(toPublicProfile),
  };
}

function memoryState(initialActive: string | null): LlmRegistryStateStore {
  let active = initialActive;
  const readiness = new Map<string, StoredLlmReadiness>();
  return {
    getActive: () => active,
    setActive: (id) => { active = id; },
    getReadiness: (id) => readiness.get(id) ?? null,
    setReadiness: (id, value) => { readiness.set(id, value); },
    deleteReadiness: (id) => { readiness.delete(id); },
  };
}

function successfulReadiness(fingerprint: string): StoredLlmReadiness {
  return {
    lastResult: {
      fingerprint,
      outcome: 'success',
      timestamp: '2026-08-29T12:00:00.000Z',
      reasonCode: 'ready',
      reason: null,
    },
    lastSuccessfulFingerprint: fingerprint,
    lastSuccessfulAt: '2026-08-29T12:00:00.000Z',
  };
}

test('deleting the active profile leaves no provider selected, including after restart', async () => {
  const store = memoryProfiles([storedProfile('local', 'codex-cli', 'model'), storedProfile('paid-api', 'openai-chat', 'model')]);
  const state = memoryState('local');
  const registry = new ProviderRegistry({ store, stateStore: state, environment: {} });
  await registry.deleteProfile('local');
  assert.equal(state.getActive(), '');
  const restarted = new ProviderRegistry({ store, stateStore: state, environment: {} });
  const status = await restarted.status();
  assert.equal(status.active, '');
  assert.equal(status.resolvedProvider, null);
  await assert.rejects(() => restarted.pick(), LlmProviderError);
});

test('live health failure overrides successful readiness', async () => {
  const selected = provider('local');
  const registry = new ProviderRegistry({ providers: [selected], stateStore: memoryState('local') });
  await registry.testProfile('local');
  assert.equal((await registry.status()).readiness.state, 'green');
  selected.getHealth = async () => ({ installed: true, configured: true, healthy: false, reasonCode: 'authentication_failed', reason: 'Sign in again.', resolvedModel: 'model' });
  const status = await registry.status();
  assert.equal(status.providers.local.healthy, false);
  assert.equal(status.readiness.state, 'red');
  await assert.rejects(() => registry.pick(), LlmProviderError);
});

test('registry close aborts pending completions and rejects later work', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const selected: LlmProvider = { ...provider('local'), complete: async options => new Promise((resolve, reject) => {
    started();
    options.signal?.addEventListener('abort', () => reject(new LlmProviderError({ code: 'provider_unavailable', message: 'Stopped.' })), { once: true });
  }) };
  const registry = new ProviderRegistry({ providers: [selected], stateStore: memoryState('local') });
  const tracked = await registry.pick();
  const pending = tracked.complete({ messages: [] });
  const rejected = assert.rejects(pending);
  await ready;
  await registry.close();
  await rejected;
  await assert.rejects(() => tracked.complete({ messages: [] }), /closed/);
});

test('local setup checks and model selection stay passive and support manual models', async () => {
  let completions = 0;
  const seen: StoredLlmProfile[] = [];
  const registry = new ProviderRegistry({ store: memoryProfiles([]), stateStore: memoryState(null), environment: {}, providerFactory: profile => {
    seen.push(profile);
    return { ...provider(profile.id), complete: async () => { completions++; return { text: 'OK' }; } };
  } });
  const app = Fastify();
  registerLlmRoutes(app, { service: registry });
  try {
    for (const [protocol, command] of [['codex-cli', 'codex'], ['claude-code', 'claude']]) {
      const models = await app.inject(`/api/llm/setup/${protocol}/models?command=${command}`);
      assert.equal(models.statusCode, 200, models.body);
      assert.deepEqual(models.json(), { provider: protocol, source: 'manual', selection: 'manual', models: [] });
      const status = await app.inject(`/api/llm/setup/${protocol}/status?command=${command}`);
      assert.equal(status.statusCode, 200, status.body);
      await registry.saveProfile({ id: protocol, label: protocol, protocol: protocol as 'codex-cli' | 'claude-code', model: 'manual-explicit', command, authMode: 'local-account' });
      assert.equal((await registry.listModels(protocol)).selection, 'manual');
    }
    assert.equal(completions, 0);
    assert.equal(seen[0].command, 'codex');
    assert.equal(seen[0].authMode, 'local-account');
  } finally { await app.close(); }
});

test('unverified local account success stays history without claiming durable green readiness', async () => {
  const profile = { ...storedProfile('local', 'codex-cli', 'explicit-model'), authMode: 'local-account' as const, baseUrl: '', command: 'codex' };
  const store = memoryProfiles([profile]);
  const state = memoryState('local');
  let signedIn = true;
  const factory = () => ({ ...provider('local'), getHealth: async () => ({ installed: true, configured: signedIn, healthy: signedIn ? null : false, reasonCode: signedIn ? 'not_tested' as const : 'authentication_failed' as const, reason: signedIn ? null : 'Sign in again.', resolvedModel: 'explicit-model' }) });
  const registry = new ProviderRegistry({ store, stateStore: state, environment: {}, providerFactory: factory });
  assert.equal((await registry.testProfile('local')).healthy, true);
  let status = await registry.status();
  assert.equal(status.readiness.state, 'yellow');
  assert.match(status.readiness.message, /does not expose account identity/);
  assert.ok(status.readiness.lastSuccessfulAt);
  assert.equal(status.providers.local.healthy, null);
  const restarted = new ProviderRegistry({ store, stateStore: state, environment: {}, providerFactory: factory });
  assert.equal((await restarted.status()).readiness.state, 'yellow');
  signedIn = false;
  assert.equal((await registry.status()).readiness.state, 'red');
  signedIn = true;
  assert.equal((await registry.status()).readiness.state, 'red', 'restored sign-in cannot revive a previous successful readiness record');
});

test('setup uses passive account capability rather than model-specific health', async () => {
  let setups = 0;
  const registry = new ProviderRegistry({ store: memoryProfiles([]), stateStore: memoryState(null), environment: {}, providerFactory: profile => ({
    ...provider(profile.id),
    getHealth: async () => { throw new Error('model health must not run'); },
    getSetupHealth: async () => { setups++; return { installed: true, configured: true, healthy: null, reasonCode: 'not_tested', reason: 'Signed in.', resolvedModel: null }; },
  }) });
  const health = await registry.setupStatus('codex-cli', 'codex');
  assert.equal(health.configured, true);
  assert.equal(setups, 1);
  assert.deepEqual(health, { installed: true, configured: true, healthy: null, reasonCode: 'not_tested', reason: 'Signed in.', resolvedModel: null });
});

test('Fastify preClose cancels in-flight requests and setup checks before waiting for requests', async () => {
  for (const setup of [false, true]) {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const wait = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      started();
      signal?.addEventListener('abort', () => reject(new LlmProviderError({ code: 'provider_unavailable', message: 'Stopped.' })), { once: true });
    });
    const registry = new ProviderRegistry({ providers: [ { ...provider('local'), complete: options => wait(options.signal) } ], providerFactory: profile => ({ ...provider(profile.id), getSetupHealth: signal => wait(signal) }), store: memoryProfiles([]), stateStore: memoryState('local') });
    const app = Fastify();
    registerLlmRoutes(app, { service: registry, authorOps: selected => selected.complete({ messages: [] }) });
    const response = app.inject(setup ? { url: '/api/llm/setup/codex-cli/status' } : { method: 'POST', url: '/api/llm/author', payload: { catalog: { datasourceLuid: 'source' }, userMessage: 'hello' } });
    const pending = response.then(result => result);
    await ready;
    await app.close();
    assert.equal((await pending).statusCode, 500);
  }
});

function withModels(listModels: (profile: StoredLlmProfile) => Promise<Array<{ id: string; label: string }>>): (profile: StoredLlmProfile) => LlmProvider {
  return profile => ({ ...provider(profile.id), label: profile.label, listModels: () => listModels(profile) });
}
