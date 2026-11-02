import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { LlmProfileWrite } from '@pulse-metric-studio/shared';
import type { SecretVault } from '../secrets/vault.js';

const temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-metric-studio-profiles-'));
const previousDataDir = process.env.PULSE_METRIC_STUDIO_DATA_DIR;
process.env.PULSE_METRIC_STUDIO_DATA_DIR = temporaryDataDir;

const { closeDb, getDb } = await import('../db/index.js');
const { ProviderRegistry } = await import('./registry.js');
const { registerLlmRoutes } = await import('./routes.js');
const { credentialCommandHint, DbLlmProfileStore, DbLlmRegistryStateStore, LlmProfileStoreError, LlmProfilesMigratingError, resolveLlmProfile } = await import('./profiles.js');

test.after(() => {
  closeDb();
  fs.rmSync(temporaryDataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.PULSE_METRIC_STUDIO_DATA_DIR;
  else process.env.PULSE_METRIC_STUDIO_DATA_DIR = previousDataDir;
});

class MemoryVault implements SecretVault {
  readonly location = 'the test vault';
  readonly secrets = new Map<string, string>();
  failStore = false;
  private next = 0;

  async store(secret: string): Promise<string> {
    if (this.failStore) throw new Error('The test vault is locked.');
    const ref = `ref_${++this.next}`;
    this.secrets.set(ref, secret);
    return ref;
  }

  async resolve(ref: string): Promise<string> {
    const secret = this.secrets.get(ref);
    if (secret === undefined) throw new Error('missing');
    return secret;
  }

  async delete(ref: string): Promise<void> {
    this.secrets.delete(ref);
  }
}

function fixture() {
  const db = getDb();
  db.exec('DELETE FROM llm_profiles; DELETE FROM settings; DELETE FROM local_secrets;');
  const vault = new MemoryVault();
  const store = new DbLlmProfileStore(() => db, () => vault);
  const stateStore = new DbLlmRegistryStateStore(() => db);
  /** The saved profile with every vault reference replaced by the secret it holds. */
  const saved = (id: string) => {
    const profile = store.list().find((entry) => entry.id === id);
    if (!profile) return undefined;
    const reveal = (source: { ref: string } | { value: string } | null) => {
      if (!source) return null;
      assert.ok('ref' in source, 'saved profiles hold references only');
      return vault.secrets.get(source.ref) ?? null;
    };
    return {
      ...profile,
      secret: reveal(profile.secret),
      headers: Object.fromEntries(Object.entries(profile.headers).map(([name, value]) => [name, reveal(value)])),
      credentialCommand: reveal(profile.credentialCommand),
    };
  };
  const save = (input: LlmProfileWrite) => store.save(resolveLlmProfile(input, store.list().find((entry) => entry.id === input.id)));
  return { db, vault, store, stateStore, saved, save };
}

async function routes(registry: InstanceType<typeof ProviderRegistry>) {
  const app = Fastify();
  await app.register(sensible);
  registerLlmRoutes(app, { service: registry });
  return app;
}

test('editing an environment-backed profile through settings saves its credential in the vault', async () => {
  const { db, vault, store, stateStore, saved } = fixture();
  const registry = new ProviderRegistry({ store, stateStore, environment: { OPENAI_COMPAT_API_KEY: 'environment-test-secret', OPENAI_COMPAT_MODEL: 'original-model', OPENAI_COMPAT_BASE_URL: 'https://gateway.example.test/v1' } });
  const app = await routes(registry);
  try {
    const payload = { label: 'Renamed provider', protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1', model: 'new-model', authMode: 'bearer' };
    const response = await app.inject({ method: 'PUT', url: '/api/llm/profiles/openai-compat', payload });
    assert.equal(response.statusCode, 200);
    assert.equal(saved('openai-compat')?.secret, 'environment-test-secret');
    assert.equal(response.json().hasSecret, true);
    assert.equal(response.body.includes('environment-test-secret'), false);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM llm_profiles').all()).includes('environment-test-secret'), false);
    const cleared = await app.inject({ method: 'PUT', url: '/api/llm/profiles/openai-compat', payload: { ...payload, clearSecret: true } });
    assert.equal(cleared.statusCode, 200);
    assert.equal(saved('openai-compat')?.secret, null);
    assert.equal(cleared.json().hasSecret, false);
    assert.equal(vault.secrets.size, 0, 'the cleared secret leaves the vault');
  } finally { await app.close(); }
});

test('changing only the saved credential command invalidates previously green readiness', async () => {
  const { store, stateStore, saved, save } = fixture();
  const profile = { id: 'gateway', label: 'Gateway', protocol: 'openai-chat' as const, baseUrl: 'https://gateway.example.test/v1', model: 'model', authMode: 'bearer' as const, credentialCommand: 'original-token-command' };
  await save(profile);
  stateStore.setActive('gateway');
  const registry = new ProviderRegistry({ store, stateStore, environment: {} });
  const app = await routes(registry);
  try {
    (await registry.pick()).tracking!.commitSuccess();
    assert.equal((await registry.status()).readiness.state, 'green');
    const response = await app.inject({ method: 'PUT', url: '/api/llm/profiles/gateway', payload: { ...profile, credentialCommand: 'replacement-token-command' } });
    assert.equal(response.statusCode, 200);
    assert.equal(stateStore.getReadiness('gateway'), null);
    assert.equal((await registry.status()).readiness.state, 'yellow');
    assert.equal(saved('gateway')?.credentialCommand, 'replacement-token-command');
  } finally { await app.close(); }
});

test('settings protocol and authentication changes honor explicit secret and header clearing', async () => {
  const { vault, store, stateStore, saved, save } = fixture();
  const registry = new ProviderRegistry({ store, stateStore, environment: {}, providerFactory: profile => ({ id: profile.id, label: profile.label, isConfigured: async () => true, complete: async () => ({ text: 'OK' }), ...(profile.protocol === 'opencode' ? { listModels: async () => [{ id: 'test/model', label: 'Test model' }] } : {}) }) });
  const app = await routes(registry);
  try {
    for (const [protocol, authMode] of [['openai-chat', 'none'], ['bedrock-converse', 'aws'], ['opencode', 'none']]) {
      await save({ id: 'gateway', label: 'Gateway', protocol: 'openai-chat', model: 'old-model', baseUrl: 'https://gateway.example.test/v1', authMode: 'bearer', secret: 'prior-test-secret', headers: { 'x-route': 'prior-test-route' }, credentialCommand: 'prior-token-command' });
      const response = await app.inject({ method: 'PUT', url: '/api/llm/profiles/gateway', payload: { label: 'Gateway', protocol, authMode, model: 'test/model', baseUrl: protocol === 'opencode' ? '' : 'https://gateway.example.test/v1', command: 'opencode', clearSecret: true, clearHeaders: true, credentialCommand: '' } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(saved('gateway')?.secret, null);
      assert.deepEqual(saved('gateway')?.headers, {});
      assert.equal(saved('gateway')?.credentialCommand, null);
      assert.equal(response.body.includes('prior-test-secret'), false);
      assert.equal(response.body.includes('prior-test-route'), false);
      assert.equal(vault.secrets.size, 0);
    }
  } finally { await app.close(); }
});

test('saved profiles keep secrets in the vault and return masked metadata', async () => {
  const { db, vault, saved, save } = fixture();
  const base = { id: 'gateway', label: 'Company gateway', protocol: 'anthropic-messages' as const, baseUrl: 'https://gateway.example.test/v1', model: 'claude-model', authMode: 'bearer' as const, region: '', awsProfile: '', command: '' };
  const stored = await save({ ...base, secret: 'runtime-secret-1234', clearSecret: false, headers: { 'x-company-route': 'private-route' } });
  const raw = JSON.stringify(db.prepare('SELECT * FROM llm_profiles').all());
  assert.equal(raw.includes('runtime-secret-1234'), false);
  assert.equal(raw.includes('private-route'), false);
  assert.ok(stored.secret && 'ref' in stored.secret);
  assert.equal(vault.secrets.size, 2);

  await save({ ...base, label: 'Renamed gateway', clearSecret: false });
  assert.equal(saved('gateway')?.secret, 'runtime-secret-1234');
  assert.equal(saved('gateway')?.headers['x-company-route'], 'private-route');
  assert.equal(vault.secrets.size, 2, 'kept secrets are not copied');
  await save({ ...base, label: 'Renamed gateway', clearSecret: false, clearHeaders: true });
  assert.deepEqual(saved('gateway')?.headers, {});
  await save({ ...base, label: 'Renamed gateway', secret: 'replacement-secret' });
  assert.equal(saved('gateway')?.secret, 'replacement-secret');
  assert.deepEqual([...vault.secrets.values()], ['replacement-secret'], 'a replaced secret leaves the vault');
  await save({ ...base, label: 'Renamed gateway', clearSecret: true, headers: {} });
  assert.equal(saved('gateway')?.secret, null);
  assert.equal(vault.secrets.size, 0);
});

test('a profile that cannot reach the vault is not saved and leaves nothing behind', async () => {
  const { vault, store, save } = fixture();
  await save({ id: 'gateway', label: 'Gateway', protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1', model: 'model', authMode: 'bearer', secret: 'first-secret' });
  vault.failStore = true;
  await assert.rejects(save({ id: 'gateway', label: 'Renamed', protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1', model: 'model', authMode: 'bearer', secret: 'second-secret' }), /locked/);
  assert.equal(store.list()[0]?.label, 'Gateway');
  assert.deepEqual([...vault.secrets.values()], ['first-secret']);
});

test('deleting a profile removes its secrets from the vault', async () => {
  const { vault, store, save } = fixture();
  await save({ id: 'gateway', label: 'Gateway', protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1', model: 'model', authMode: 'bearer', secret: 'private-secret', headers: { 'x-route': 'route' }, credentialCommand: 'mint' });
  assert.equal(vault.secrets.size, 3);
  await store.delete('gateway');
  assert.deepEqual(store.list(), []);
  assert.equal(vault.secrets.size, 0);
});

test('real settings conversion clears cloud configuration while preserving unrelated profiles and same-protocol credentials', async () => {
  const { store, stateStore, saved, save } = fixture();
  const registry = new ProviderRegistry({ store, stateStore, environment: {} });
  const app = await routes(registry);
  try {
    const api = { id: 'gateway', label: 'API', protocol: 'openai-chat' as const, baseUrl: 'https://api.example.test/v1', model: 'model', authMode: 'bearer' as const, secret: 'private-api-secret', headers: { 'x-route': 'private-route' }, credentialCommand: 'mint --secret private-command' };
    await save(api);
    await save({ ...api, id: 'untouched' });
    let response = await app.inject({ method: 'PUT', url: '/api/llm/profiles/gateway', payload: { ...api, label: 'Renamed', secret: undefined, headers: undefined, credentialCommand: undefined } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(saved('gateway')?.secret, api.secret);
    assert.deepEqual(saved('gateway')?.headers, api.headers);
    assert.equal(saved('gateway')?.credentialCommand, api.credentialCommand);
    response = await app.inject({ method: 'PUT', url: '/api/llm/profiles/gateway', payload: { ...api, protocol: 'openai-responses', secret: undefined, headers: undefined, credentialCommand: undefined } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(saved('gateway')?.secret, api.secret);
    assert.deepEqual(saved('gateway')?.headers, api.headers);
    assert.equal(saved('gateway')?.credentialCommand, api.credentialCommand);
    for (const [protocol, command] of [['codex-cli', 'codex'], ['claude-code', 'claude']]) {
      response = await app.inject({ method: 'PUT', url: '/api/llm/profiles/gateway', payload: { label: 'Local', protocol, command, model: 'explicit-model', authMode: 'local-account' } });
      assert.equal(response.statusCode, 200, response.body);
      const local = saved('gateway')!;
      assert.equal(local.secret, null);
      assert.deepEqual(local.headers, {});
      assert.equal(local.credentialCommand, null);
      assert.equal(local.baseUrl, '');
      assert.equal(local.region, '');
      assert.equal(local.awsProfile, '');
      assert.equal(local.allowPrivateNetwork, false);
      assert.equal(local.authMode, 'local-account');
    }
    response = await app.inject({ method: 'PUT', url: '/api/llm/profiles/gateway', payload: { label: 'API again', protocol: 'openai-chat', baseUrl: api.baseUrl, model: 'model', authMode: 'bearer' } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(saved('gateway')?.command, '');
    assert.equal(saved('gateway')?.secret, null);
    assert.equal(saved('untouched')?.secret, api.secret);
  } finally { await app.close(); }
});

test('profile metadata never describes a saved secret', async () => {
  const { store, stateStore, save } = fixture();
  await save({ id: 'short-secret', label: 'Short secret', protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1', model: 'model-1', authMode: 'bearer', secret: 'abc', headers: {} });
  const response = await (await routes(new ProviderRegistry({ store, stateStore, environment: {} }))).inject({ method: 'GET', url: '/api/llm/profiles' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.body.includes('abc'), false);
  assert.equal(response.body.includes('secretHint'), false);
});

test('corrupt profile storage fails closed', () => {
  const { db, store } = fixture();
  db.prepare(`INSERT INTO llm_profiles (id, label, protocol, base_url, model, auth_mode, header_refs_json, region, aws_profile, command, allow_private_network, created_at, updated_at)
    VALUES ('gateway', 'Gateway', 'openai-chat', '', 'model', 'bearer', 'not json', '', '', '', 0, 0, 0)`).run();
  assert.throws(() => store.list(), LlmProfileStoreError);
});

test('profiles from an earlier release are unavailable until they are moved, with a clear reason', () => {
  const { db, store } = fixture();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('llm.profiles.v1', 'v1.sealed');
  assert.throws(() => store.list(), (error: unknown) => error instanceof LlmProfilesMigratingError && error.statusCode === 503 && /moving to the test vault/.test(error.message));
});

test('credential command hints show only the executable name', () => {
  assert.equal(credentialCommandHint('/usr/local/bin/devbar credential get --secret abc'), 'devbar ...');
  assert.equal(credentialCommandHint('"C:\\Program Files\\mint.exe" --key x'), 'mint.exe ...');
  assert.equal(credentialCommandHint('mint'), 'mint');
  assert.equal(credentialCommandHint('  '), null);
});

test('credential commands persist in the vault and stay out of public metadata', async () => {
  const { store, stateStore, saved, save } = fixture();
  const base = { id: 'gateway', label: 'Gateway', protocol: 'anthropic-messages' as const, baseUrl: 'https://gateway.example.test/v1', model: 'claude-model', authMode: 'x-api-key' as const };
  await save({ ...base, clearSecret: false, headers: {}, region: '', awsProfile: '', command: '', credentialCommand: 'printf %s MINTED-TOKEN' });
  const listed = await (await routes(new ProviderRegistry({ store, stateStore, environment: {} }))).inject({ method: 'GET', url: '/api/llm/profiles' });
  const gateway = listed.json().profiles.find((profile: { id: string }) => profile.id === 'gateway');
  assert.equal(gateway.hasCredentialCommand, true);
  assert.equal(gateway.credentialCommandHint, 'printf ...');
  assert.doesNotMatch(listed.body, /MINTED-TOKEN/);
  assert.equal(saved('gateway')?.credentialCommand, 'printf %s MINTED-TOKEN');

  // Omitting the command keeps it; clearing removes it.
  await save(base);
  assert.equal(saved('gateway')?.credentialCommand, 'printf %s MINTED-TOKEN');
  await save({ ...base, clearCredentialCommand: true });
  assert.equal(saved('gateway')?.credentialCommand, null);
  assert.equal(saved('gateway')?.credentialCommandHint, null);
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
