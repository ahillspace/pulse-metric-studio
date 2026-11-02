import crypto from 'node:crypto';
import { getDb, type Db } from '../db/index.js';
import { decryptSecret, encryptSecret } from '../db/crypto.js';
import { CredentialBrokerError, type CredentialBrokerVaultClient } from '../tableau/credential-broker.js';

/**
 * Saved AI provider secrets (API keys, header values, credential commands).
 * Each secret is its own entry addressed by an opaque reference, and is read
 * only when a request needs it, so listing or editing profiles never touches
 * the OS credential store.
 */
export interface SecretVault {
  /** Where secrets live, for messages ("the macOS Keychain"). */
  readonly location: string;
  store(secret: string): Promise<string>;
  resolve(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
}

export class SecretVaultError extends Error {
  readonly statusCode: number;

  constructor(
    readonly code: 'not_found' | 'unavailable',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SecretVaultError';
    this.statusCode = code === 'not_found' ? 409 : 503;
  }
}

export function osCredentialStoreName(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return 'the macOS Keychain';
  if (platform === 'win32') return 'Windows Credential Manager';
  return 'the OS credential store';
}

/** The desktop vault: one OS credential store entry per secret, through the native broker. */
export class BrokerSecretVault implements SecretVault {
  readonly location = osCredentialStoreName();

  constructor(private readonly broker: CredentialBrokerVaultClient) {}

  async store(secret: string): Promise<string> {
    try {
      return await this.broker.store('llm-secret', secret);
    } catch (error) {
      throw new SecretVaultError('unavailable', `The secret could not be saved in ${this.location}. Unlock it or allow access when asked, then save again.`, { cause: error });
    }
  }

  async resolve(ref: string): Promise<string> {
    try {
      return await this.broker.resolve(ref);
    } catch (error) {
      if (error instanceof CredentialBrokerError && error.code === 'not_found') {
        throw new SecretVaultError('not_found', `The saved secret is missing from ${this.location}.`, { cause: error });
      }
      throw new SecretVaultError('unavailable', `${capitalize(this.location)} did not provide the saved secret. Unlock it or allow access when asked, then try again.`, { cause: error });
    }
  }

  async delete(ref: string): Promise<void> {
    try {
      await this.broker.delete(ref);
    } catch (error) {
      throw new SecretVaultError('unavailable', `The secret could not be removed from ${this.location}.`, { cause: error });
    }
  }
}

/** Browser development has no OS broker; secrets are sealed under the local key file instead. */
export class LocalSecretVault implements SecretVault {
  readonly location = 'the local encrypted store';

  constructor(private readonly db: () => Db = getDb) {}

  async store(secret: string): Promise<string> {
    const ref = `local_${crypto.randomUUID().replaceAll('-', '')}`;
    this.db().prepare('INSERT INTO local_secrets (ref, secret_enc) VALUES (?, ?)').run(ref, encryptSecret(secret));
    return ref;
  }

  async resolve(ref: string): Promise<string> {
    const sealed = this.db().prepare('SELECT secret_enc FROM local_secrets WHERE ref = ?').pluck().get(ref) as string | undefined;
    if (sealed === undefined) throw new SecretVaultError('not_found', `The saved secret is missing from ${this.location}.`);
    try {
      return decryptSecret(sealed);
    } catch (error) {
      throw new SecretVaultError('unavailable', `The saved secret in ${this.location} cannot be read.`, { cause: error });
    }
  }

  async delete(ref: string): Promise<void> {
    this.db().prepare('DELETE FROM local_secrets WHERE ref = ?').run(ref);
  }
}

let configuredVault: SecretVault | null = null;

/** The desktop host installs the broker-backed vault before serving requests. */
export function setSecretVault(vault: SecretVault | null): void {
  configuredVault = vault;
}

export function secretVault(): SecretVault {
  configuredVault ??= new LocalSecretVault();
  return configuredVault;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
