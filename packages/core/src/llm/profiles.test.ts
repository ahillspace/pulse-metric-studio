import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { encryptSecret } from '../db/crypto.js';
import { DbLlmRegistryStateStore, EncryptedLlmProfileStore, LlmProfileStoreError } from './profiles.js';

function setLegacyProfiles(db: Database.Database, profiles: unknown[]): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('llm.profiles.v1', encryptSecret(JSON.stringify(profiles)));
}

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

test('credential commands persist, echo in public metadata, and tolerate legacy stored profiles', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const store = new EncryptedLlmProfileStore(() => db);
  try {
    const saved = store.save({
      id: 'gateway', label: 'Gateway', protocol: 'anthropic-messages', baseUrl: 'https://gateway.example.test/v1',
      model: 'claude-model', authMode: 'x-api-key', clearSecret: false, headers: {}, region: '', awsProfile: '', command: '',
      credentialCommand: 'printf %s MINTED-TOKEN',
    });
    assert.equal(saved.credentialCommand, 'printf %s MINTED-TOKEN');
    assert.equal(store.get('gateway')?.credentialCommand, 'printf %s MINTED-TOKEN');

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
    assert.equal(publicLegacy?.credentialCommand, '');
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
