import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Machine-local secret encryption (AES-256-GCM) under a key file in the data
 * dir. It protects the browser-development fallbacks: Tableau connections
 * saved without an OS credential store and the local secret vault. The
 * desktop app keeps saved secrets in the OS credential store instead.
 */

let cachedKey: Buffer | null = null;

function machineKey(): Buffer {
  if (cachedKey) return cachedKey;
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(config.machineKeyPath)) {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(config.machineKeyPath, key.toString('hex'), { mode: 0o600 });
  }
  cachedKey = Buffer.from(fs.readFileSync(config.machineKeyPath, 'utf8').trim(), 'hex');
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', machineKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptSecret(blob: string): string {
  return decryptSecretWithKey(blob, machineKey());
}

/** Decrypts with an explicit key; the saved-secrets migration reads data sealed under an earlier key. */
export function decryptSecretWithKey(blob: string, key: Buffer): string {
  if (typeof blob !== 'string' || !blob.startsWith('v1.')) {
    throw new Error('Stored secret is missing or in an unknown format');
  }
  const [version, ivB64, tagB64, dataB64] = blob.split('.');
  if (version !== 'v1') throw new Error(`Unknown secret format ${version}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}
