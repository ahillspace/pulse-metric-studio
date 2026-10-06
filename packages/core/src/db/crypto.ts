import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Machine-local secret encryption (AES-256-GCM) for AI provider profiles and
 * fallback Tableau credentials. The desktop app keeps the key in the OS
 * credential store (installDataKey, before any secret is read). Browser
 * development mode falls back to a key file inside the data dir.
 */

function ensureDataDir(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

let cachedKey: Buffer | null = null;

/**
 * Written once the OS store holds the data key. With it present a missing key
 * must never be replaced by a fresh key file: data encrypted under the OS key
 * would become unreadable and the next save would overwrite it.
 */
function osKeyMarkerPath(): string {
  return path.join(config.dataDir, 'data-key-in-os-store');
}

export class DataKeyUnavailableError extends Error {
  constructor() {
    super('Saved secrets are locked: the OS credential store did not provide the data key. Restart Pulse Metric Studio once Keychain or Credential Manager is available.');
    this.name = 'DataKeyUnavailableError';
  }
}

/** Uses an OS-held key instead of the key file. */
export function installDataKey(hexKey: string): void {
  if (!/^[a-f0-9]{64}$/i.test(hexKey)) throw new Error('Invalid data key.');
  cachedKey = Buffer.from(hexKey, 'hex');
}

/** The legacy key file's key, if one exists. */
export function readLegacyKeyFile(): string | null {
  if (!fs.existsSync(config.machineKeyPath)) return null;
  const value = fs.readFileSync(config.machineKeyPath, 'utf8').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}

/**
 * Moves the data key into the OS store. An existing key file is migrated and
 * removed once the store returns the same key; if the store already holds a
 * different key, the file key (which encrypted the existing data) stays in use.
 */
export async function adoptOsDataKey(store: { dataKey(candidate: string): Promise<string> }): Promise<'migrated' | 'kept-file' | 'os'> {
  const legacy = readLegacyKeyFile();
  const key = await store.dataKey(legacy ?? crypto.randomBytes(32).toString('hex'));
  if (legacy && key !== legacy) {
    installDataKey(legacy);
    return 'kept-file';
  }
  installDataKey(key);
  ensureDataDir();
  fs.writeFileSync(osKeyMarkerPath(), 'The local data key is held in the OS credential store.\n', { mode: 0o600 });
  if (!legacy) return 'os';
  fs.rmSync(config.machineKeyPath, { force: true });
  return 'migrated';
}

function machineKey(): Buffer {
  if (cachedKey) return cachedKey;
  if (fs.existsSync(osKeyMarkerPath()) && !fs.existsSync(config.machineKeyPath)) throw new DataKeyUnavailableError();
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
