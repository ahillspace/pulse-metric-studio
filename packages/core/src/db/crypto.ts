import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Machine-local secret encryption (AES-256-GCM).
 * Key file is generated on first use inside the data dir. This protects PAT
 * secrets at rest from casual disk access — a local tool, not a HSM.
 */

function ensureDataDir(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

let cachedKey: Buffer | null = null;

function machineKey(): Buffer {
  if (cachedKey) return cachedKey;
  ensureDataDir();
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
  if (typeof blob !== 'string' || !blob.startsWith('v1.')) {
    throw new Error('Stored secret is missing or in an unknown format');
  }
  const [version, ivB64, tagB64, dataB64] = blob.split('.');
  if (version !== 'v1') throw new Error(`Unknown secret format ${version}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', machineKey(), Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}
