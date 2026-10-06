import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import { config } from '../config.js';
import { adoptOsDataKey, decryptSecret, encryptSecret, readLegacyKeyFile } from './crypto.js';

test('the data key moves from the key file into the OS store without losing saved secrets', async () => {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const legacy = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(config.machineKeyPath, legacy, { mode: 0o600 });
  const sealed = encryptSecret('saved-provider-secret');
  const stored: string[] = [];
  const outcome = await adoptOsDataKey({ dataKey: async (candidate) => { stored.push(candidate); return candidate; } });
  assert.equal(outcome, 'migrated');
  assert.deepEqual(stored, [legacy]);
  assert.equal(fs.existsSync(config.machineKeyPath), false);
  assert.equal(readLegacyKeyFile(), null);
  assert.equal(decryptSecret(sealed), 'saved-provider-secret');
});

test('a different key already in the OS store never replaces the key that encrypted existing data', async () => {
  const legacy = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(config.machineKeyPath, legacy, { mode: 0o600 });
  const outcome = await adoptOsDataKey({ dataKey: async () => 'f'.repeat(64) });
  assert.equal(outcome, 'kept-file');
  assert.equal(fs.existsSync(config.machineKeyPath), true);
  const sealed = encryptSecret('value');
  fs.rmSync(config.machineKeyPath);
  assert.equal(decryptSecret(sealed), 'value');
});

test('without a key file the OS store supplies a fresh random key', async () => {
  let candidate = '';
  const outcome = await adoptOsDataKey({ dataKey: async (value) => { candidate = value; return value; } });
  assert.equal(outcome, 'os');
  assert.match(candidate, /^[a-f0-9]{64}$/);
  assert.equal(fs.existsSync(config.machineKeyPath), false);
  assert.equal(decryptSecret(encryptSecret('fresh')), 'fresh');
});
