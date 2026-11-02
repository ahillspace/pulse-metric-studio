import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import { config } from '../config.js';
import { decryptSecret, decryptSecretWithKey, encryptSecret } from './crypto.js';

test('secrets round-trip under the key file, which is created owner-only on first use', () => {
  const sealed = encryptSecret('saved-provider-secret');
  assert.equal(sealed.includes('saved-provider-secret'), false);
  assert.equal(decryptSecret(sealed), 'saved-provider-secret');
  if (process.platform !== 'win32') assert.equal(fs.statSync(config.machineKeyPath).mode & 0o777, 0o600);
});

test('an explicit key opens data sealed under a different key, and only that key does', () => {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update('earlier', 'utf8'), cipher.final()]);
  const blob = `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
  assert.equal(decryptSecretWithKey(blob, key), 'earlier');
  assert.throws(() => decryptSecret(blob));
});
