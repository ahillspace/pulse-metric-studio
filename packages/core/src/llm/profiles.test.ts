import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { ProviderRegistry } from './registry.js';
import { registerLlmRoutes } from './routes.js';
import { encryptSecret } from '../db/crypto.js';
import { credentialCommandHint, DbLlmRegistryStateStore, EncryptedLlmProfileStore, LlmProfileStoreError } from './profiles.js';

function setLegacyProfiles(db: Database.Database, profiles: unknown[]): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('llm.profiles.v1', encryptSecret(JSON.stringify(profiles)));
}

test('editing an environment-backed profile through settings preserves its credential in encrypted storage', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const store = new EncryptedLlmProfileStore(() => db);
  const registry = new ProviderRegistry({ store, stateStore: new DbLlmRegistryStateStore(() => db), environment: { OPENAI_COMPAT_API_KEY: 'environment-test-secret', OPENAI_COMPAT_MODEL: 'original-model', OPENAI_COMPAT_BASE_URL: 'https://gateway.example.test/v1' } });
  const app = Fastify();
  await app.register(sensible);
  registerLlmRoutes(app, { service: registry });
  try {
    const payload = { label: 'Renamed provider', protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1', model: 'new-model', authMode: 'bearer' };
    const response = await app.inject({ method: 'PUT', url: '/api/llm/profiles/openai-compat', payload });
    assert.equal(response.statusCode, 200);
    assert.equal(store.get('openai-compat')?.secret, 'environment-test-secret');
    assert.equal(response.json().hasSecret, true);
    assert.equal(response.body.includes('environment-test-secret'), false);
    assert.equal(String(db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get('llm.profiles.v1')).includes('environment-test-secret'), false);
    const cleared = await app.inject({ method: 'PUT', url: '/api/llm/profiles/openai-compat', payload: { ...payload, clearSecret: true } });
    assert.equal(cleared.statusCode, 200);
    assert.equal(store.get('openai-compat')?.secret, '');
    assert.equal(cleared.json().hasSecret, false);
  } finally { await app.close(); db.close(); }
});

test('changing only the saved credential command invalidates previously green readiness', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const store = new EncryptedLlmProfileStore(() => db);
  const stateStore = new DbLlmRegistryStateStore(() => db);
  const profile = { id: 'gateway', label: 'Gateway', protocol: 'openai-chat' as const, baseUrl: 'https://gateway.example.test/v1', model: 'model', authMode: 'bearer' as const, credentialCommand: 'original-token-command' };
  store.save(profile);
  stateStore.setActive('gateway');
  const registry = new ProviderRegistry({ store, stateStore, environment: {} });
  const app = Fastify();
  await app.register(sensible);
  registerLlmRoutes(app, { service: registry });
  try {
    (await registry.pick()).tracking!.commitSuccess();
    assert.equal((await registry.status()).readiness.state, 'green');
    const response = await app.inject({ method: 'PUT', url: '/api/llm/profiles/gateway', payload: { ...profile, credentialCommand: 'replacement-token-command' } });
    assert.equal(response.statusCode, 200);
    assert.equal(stateStore.getReadiness('gateway'), null);
    assert.equal((await registry.status()).readiness.state, 'yellow');
    assert.equal(store.get('gateway')?.credentialCommand, 'replacement-token-command');
  } finally { await app.close(); db.close(); }
});

test('settings protocol and authentication changes honor explicit secret and header clearing', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const store = new EncryptedLlmProfileStore(() => db);
  const registry = new ProviderRegistry({ store, stateStore: new DbLlmRegistryStateStore(() => db), environment: {}, providerFactory: profile => ({ id: profile.id, label: profile.label, isConfigured: async () => true, complete: async () => ({ text: 'OK' }), ...(profile.protocol === 'opencode' ? { listModels: async () => [{ id: 'test/model', label: 'Test model' }] } : {}) }) });
  const app = Fastify();
  await app.register(sensible);
  registerLlmRoutes(app, { service: registry });
  try {
    for (const [protocol, authMode] of [['openai-chat', 'none'], ['bedrock-converse', 'aws'], ['opencode', 'none']]) {
      store.save({ id: 'gateway', label: 'Gateway', protocol: 'openai-chat', model: 'old-model', baseUrl: 'https://gateway.example.test/v1', authMode: 'bearer', secret: 'prior-test-secret', headers: { 'x-route': 'prior-test-route' }, credentialCommand: 'prior-token-command' });
      const response = await app.inject({ method: 'PUT', url: '/api/llm/profiles/gateway', payload: { label: 'Gateway', protocol, authMode, model: 'test/model', baseUrl: protocol === 'opencode' ? '' : 'https://gateway.example.test/v1', command: 'opencode', clearSecret: true, clearHeaders: true, credentialCommand: '' } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(store.get('gateway')?.secret, '');
      assert.deepEqual(store.get('gateway')?.headers, {});
      assert.equal(store.get('gateway')?.credentialCommand, '');
      assert.equal(response.body.includes('prior-test-secret'), false);
      assert.equal(response.body.includes('prior-test-route'), false);
    }
  } finally { await app.close(); db.close(); }
});

test('runtime profiles encrypt secrets at rest and return masked metadata', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const store = new EncryptedLlmProfileStore(() => db);
  try {
    const saved = store.save({
      id: 'gateway',
      label: 'Company gateway',
      protocol: 'anthropic-messages',
      baseUrl: 'https://gateway.example.test/v1',
      model: 'claude-model',
      authMode: 'bearer',
      secret: 'runtime-secret-1234',
      clearSecret: false,
      headers: { 'x-company-route': 'private-route' },
      region: '',
      awsProfile: '',
      command: '',
    });
    const raw = db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get('llm.profiles.v1') as string;
    assert.equal(raw.includes('runtime-secret-1234'), false);
    assert.equal(raw.includes('private-route'), false);
    assert.equal(saved.hasSecret, true);
    assert.equal(saved.secretHint, '...1234');
    assert.deepEqual(saved.headers, { 'x-company-route': '[configured]' });

    store.save({
      id: 'gateway', label: 'Renamed gateway', protocol: 'anthropic-messages', baseUrl: 'https://gateway.example.test/v1',
      model: 'claude-model', authMode: 'bearer', clearSecret: false, region: '', awsProfile: '', command: '',
    });
    assert.equal(store.get('gateway')?.secret, 'runtime-secret-1234');
    assert.equal(store.get('gateway')?.headers['x-company-route'], 'private-route');
    store.save({
      id: 'gateway', label: 'Renamed gateway', protocol: 'anthropic-messages', baseUrl: 'https://gateway.example.test/v1',
      model: 'claude-model', authMode: 'bearer', clearSecret: false, clearHeaders: true, region: '', awsProfile: '', command: '',
    });
    assert.deepEqual(store.get('gateway')?.headers, {});
    store.save({
      id: 'gateway', label: 'Renamed gateway', protocol: 'anthropic-messages', baseUrl: 'https://gateway.example.test/v1',
      model: 'claude-model', authMode: 'bearer', clearSecret: true, headers: {}, region: '', awsProfile: '', command: '',
    });
    assert.equal(store.get('gateway')?.secret, '');
  } finally {
    db.close();
  }
});

test('real settings conversion clears cloud configuration while preserving unrelated profiles and same-protocol credentials', async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const store = new EncryptedLlmProfileStore(() => db);
  const registry = new ProviderRegistry({ store, stateStore: new DbLlmRegistryStateStore(() => db), environment: {} });
  const app = Fastify();
  await app.register(sensible);
  registerLlmRoutes(app, { service: registry });
  try {
    const api = { id: 'gateway', label: 'API', protocol: 'openai-chat' as const, baseUrl: 'https://api.example.test/v1', model: 'model', authMode: 'bearer' as const, secret: 'private-api-secret', headers: { 'x-route': 'private-route' }, credentialCommand: 'mint --secret private-command' };
    store.save(api);
    store.save({ ...api, id: 'untouched' });
    let response = await app.inject({ method: 'PUT', url: '/api/llm/profiles/gateway', payload: { ...api, label: 'Renamed', secret: undefined, headers: undefined, credentialCommand: undefined } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(store.get('gateway')?.secret, api.secret);
    assert.deepEqual(store.get('gateway')?.headers, api.headers);
    assert.equal(store.get('gateway')?.credentialCommand, api.credentialCommand);
    response = await app.inject({ method: 'PUT', url: '/api/llm/profiles/gateway', payload: { ...api, protocol: 'openai-responses', secret: undefined, headers: undefined, credentialCommand: undefined } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(store.get('gateway')?.secret, api.secret);
    assert.deepEqual(store.get('gateway')?.headers, api.headers);
    assert.equal(store.get('gateway')?.credentialCommand, api.credentialCommand);
    for (const [protocol, command] of [['codex-cli', 'codex'], ['claude-code', 'claude']]) {
      response = await app.inject({ method: 'PUT', url: '/api/llm/profiles/gateway', payload: { label: 'Local', protocol, command, model: 'explicit-model', authMode: 'local-account' } });
      assert.equal(response.statusCode, 200, response.body);
      const local = store.get('gateway')!;
      assert.equal(local.secret, '');
      assert.deepEqual(local.headers, {});
      assert.equal(local.credentialCommand, '');
      assert.equal(local.baseUrl, '');
      assert.equal(local.region, '');
      assert.equal(local.awsProfile, '');
      assert.equal(local.allowPrivateNetwork, false);
      assert.equal(local.authMode, 'local-account');
    }
    response = await app.inject({ method: 'PUT', url: '/api/llm/profiles/gateway', payload: { label: 'API again', protocol: 'openai-chat', baseUrl: api.baseUrl, model: 'model', authMode: 'bearer' } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(store.get('gateway')?.command, '');
    assert.equal(store.get('gateway')?.secret, '');
    assert.equal(store.get('untouched')?.secret, api.secret);
  } finally { await app.close(); db.close(); }
});

test('short secrets are never disclosed by their metadata hint', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const store = new EncryptedLlmProfileStore(() => db);
  try {
    const saved = store.save({
      id: 'short-secret', label: 'Short secret', protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1',
      model: 'model-1', authMode: 'bearer', secret: 'abc', headers: {}, region: '', awsProfile: '', command: '',
    });
    assert.equal(saved.secretHint, '[configured]');
    assert.equal(saved.secretHint?.includes('abc'), false);
  } finally {
    db.close();
  }
});

test('corrupt profile storage fails closed and is not overwritten by a save', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('llm.profiles.v1', 'corrupt-ciphertext');
  const store = new EncryptedLlmProfileStore(() => db);
  try {
    assert.throws(() => store.list(), LlmProfileStoreError);
    assert.throws(() => store.save({
      id: 'gateway', label: 'Gateway', protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1',
      model: 'model-1', authMode: 'bearer', secret: 'secret', headers: {}, region: '', awsProfile: '', command: '',
    }), LlmProfileStoreError);
    assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').pluck().get('llm.profiles.v1'), 'corrupt-ciphertext');
  } finally {
    db.close();
  }
});

test('credential command hints show only the executable name', () => {
  assert.equal(credentialCommandHint('/usr/local/bin/devbar credential get --secret abc'), 'devbar ...');
  assert.equal(credentialCommandHint('"C:\\Program Files\\mint.exe" --key x'), 'mint.exe ...');
  assert.equal(credentialCommandHint('mint'), 'mint');
  assert.equal(credentialCommandHint('  '), null);
});

test('credential commands persist, stay out of public metadata, and tolerate legacy stored profiles', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const store = new EncryptedLlmProfileStore(() => db);
  try {
    const saved = store.save({
      id: 'gateway', label: 'Gateway', protocol: 'anthropic-messages', baseUrl: 'https://gateway.example.test/v1',
      model: 'claude-model', authMode: 'x-api-key', clearSecret: false, headers: {}, region: '', awsProfile: '', command: '',
      credentialCommand: 'printf %s MINTED-TOKEN',
    });
    assert.equal(saved.hasCredentialCommand, true);
    assert.equal(saved.credentialCommandHint, 'printf ...');
    assert.doesNotMatch(JSON.stringify(saved), /MINTED-TOKEN/);
    assert.equal(store.get('gateway')?.credentialCommand, 'printf %s MINTED-TOKEN');

    // Omitting the command keeps it; clearing removes it.
    store.save({ id: 'gateway', label: 'Gateway', protocol: 'anthropic-messages', baseUrl: 'https://gateway.example.test/v1', model: 'claude-model', authMode: 'x-api-key' });
    assert.equal(store.get('gateway')?.credentialCommand, 'printf %s MINTED-TOKEN');
    store.save({ id: 'gateway', label: 'Gateway', protocol: 'anthropic-messages', baseUrl: 'https://gateway.example.test/v1', model: 'claude-model', authMode: 'x-api-key', clearCredentialCommand: true });
    assert.equal(store.get('gateway')?.credentialCommand, '');

    // A stored profile written before the field existed still validates on read.
    const legacy = [{
      id: 'legacy', label: 'Legacy', protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1',
      model: 'model-1', authMode: 'bearer', secret: 'legacy-secret', headers: {}, region: '', awsProfile: '', command: '',
      allowPrivateNetwork: false, source: 'saved',
    }];
    setLegacyProfiles(db, legacy);
    const restored = new EncryptedLlmProfileStore(() => db);
    const publicLegacy = restored.publicList().find((profile) => profile.id === 'legacy');
    assert.ok(publicLegacy);
    assert.equal(publicLegacy?.hasCredentialCommand, false);
    assert.equal(publicLegacy?.credentialCommandHint, null);
  } finally {
    db.close();
  }
});

test('LLM registry state persists active selection and readiness timestamps', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const state = new DbLlmRegistryStateStore(() => db);
  try {
    state.setActive('opencode');
    state.setReadiness('opencode', {
      lastResult: {
        fingerprint: 'fingerprint-1',
        outcome: 'success',
        timestamp: '2026-08-29T12:00:00.000Z',
        reasonCode: 'ready',
        reason: null,
      },
      lastSuccessfulFingerprint: 'fingerprint-1',
      lastSuccessfulAt: '2026-08-29T12:00:00.000Z',
    });

    const restarted = new DbLlmRegistryStateStore(() => db);
    assert.equal(restarted.getActive(), 'opencode');
    assert.deepEqual(restarted.getReadiness('opencode'), {
      lastResult: {
        fingerprint: 'fingerprint-1',
        outcome: 'success',
        timestamp: '2026-08-29T12:00:00.000Z',
        reasonCode: 'ready',
        reason: null,
      },
      lastSuccessfulFingerprint: 'fingerprint-1',
      lastSuccessfulAt: '2026-08-29T12:00:00.000Z',
    });

    restarted.deleteReadiness('opencode');
    assert.equal(state.getReadiness('opencode'), null);
  } finally {
    db.close();
  }
});
