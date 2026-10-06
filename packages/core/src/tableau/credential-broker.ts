import process from 'node:process';

export const CREDENTIAL_BROKER_URL_ENV = 'PULSE_METRIC_STUDIO_CREDENTIAL_BROKER_URL';
export const CREDENTIAL_BROKER_TOKEN_ENV = 'PULSE_METRIC_STUDIO_CREDENTIAL_BROKER_TOKEN';
export const CREDENTIAL_BROKER_RESOLVE_PATH = '/v1/credentials/resolve';
export const CREDENTIAL_BROKER_DELETE_PATH = '/v1/credentials/delete';
export const CREDENTIAL_BROKER_DATA_KEY_PATH = '/v1/data-key';
export const CREDENTIAL_BROKER_APPROVE_COMMAND_PATH = '/v1/approvals/credential-command';
/** The approval waits for a person to answer a native dialog. */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export type CredentialBrokerErrorCode =
  | 'unavailable'
  | 'unauthorized'
  | 'not_found'
  | 'invalid_response';

export class CredentialBrokerError extends Error {
  constructor(
    public readonly code: CredentialBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialBrokerError';
  }
}

export interface CredentialBrokerClient {
  resolve(credentialRef: string): Promise<string>;
}

export interface CredentialBrokerVaultClient extends CredentialBrokerClient {
  delete(credentialRef: string): Promise<boolean>;
  /** Returns the OS-held data key, storing `candidate` (64 hex characters) if none exists. */
  dataKey(candidate: string): Promise<string>;
  /** Asks the native layer (and, the first time, the person) whether a credential command may run. */
  approveCredentialCommand(command: string): Promise<boolean>;
}

/**
 * The broker bearer token arrives over the desktop launcher's stdin and lives
 * only in module state. Keeping it out of process.env means child processes
 * (credential commands, the AWS SDK credential_process, OpenCode) never inherit it.
 */
let configuredBrokerToken: string | null = null;

export function setCredentialBrokerToken(token: string | null): void {
  configuredBrokerToken = token?.trim() || null;
}

interface CredentialBrokerClientOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides the token set by setCredentialBrokerToken (tests). */
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;

export function createCredentialBrokerClient(
  options: CredentialBrokerClientOptions = {},
): CredentialBrokerVaultClient {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  async function request(path: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown, requestTimeoutMs = timeoutMs): Promise<unknown> {
    const brokerUrl = readBrokerUrl(env);
    const brokerToken = (options.token ?? configuredBrokerToken ?? '').trim();
    if (!brokerToken) {
      throw new CredentialBrokerError('unavailable', 'The OS credential broker token is unavailable.');
    }

    const requestBody = JSON.stringify(body);
    if (Buffer.byteLength(requestBody, 'utf8') > MAX_REQUEST_BYTES) {
      throw new CredentialBrokerError('unavailable', 'The OS credential broker request is too large.');
    }

    let response: Response;
    try {
      response = await fetchImpl(new URL(path, brokerUrl), {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${brokerToken}`,
          'Content-Type': 'application/json',
        },
        body: requestBody,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new CredentialBrokerError('unavailable', 'The OS credential broker is unavailable.');
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new CredentialBrokerError('unauthorized', 'The OS credential broker rejected the server token.');
      }
      if (response.status === 404) {
        throw new CredentialBrokerError('not_found', 'The saved OS credential was not found.');
      }
      throw new CredentialBrokerError('unavailable', 'The OS credential broker request failed.');
    }

    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_RESPONSE_BYTES) {
      throw new CredentialBrokerError('invalid_response', 'The OS credential broker returned an invalid response.');
    }

    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new CredentialBrokerError('invalid_response', 'The OS credential broker returned an invalid response.');
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new CredentialBrokerError('invalid_response', 'The OS credential broker returned an invalid response.');
    }
  }

  return {
    async resolve(credentialRef: string): Promise<string> {
      const normalizedRef = credentialRef.trim();
      if (!normalizedRef) {
        throw new CredentialBrokerError('not_found', 'The saved connection has no credential reference.');
      }

      const body = await request(CREDENTIAL_BROKER_RESOLVE_PATH, 'POST', { credentialRef: normalizedRef });
      const secret = (body as { secret?: unknown } | null)?.secret;
      if (typeof secret !== 'string' || !secret.trim()) {
        throw new CredentialBrokerError('invalid_response', 'The OS credential broker returned an invalid response.');
      }
      return secret;
    },
    async delete(credentialRef: string): Promise<boolean> {
      const normalizedRef = credentialRef.trim();
      if (!normalizedRef) {
        return false;
      }
      const body = await request(CREDENTIAL_BROKER_DELETE_PATH, 'DELETE', { credentialRef: normalizedRef });
      const removed = (body as { removed?: unknown } | null)?.removed;
      if (typeof removed !== 'boolean') {
        throw new CredentialBrokerError('invalid_response', 'The OS credential broker returned an invalid response.');
      }
      return removed;
    },
    async dataKey(candidate: string): Promise<string> {
      const body = await request(CREDENTIAL_BROKER_DATA_KEY_PATH, 'POST', { candidate });
      const key = (body as { key?: unknown } | null)?.key;
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key)) {
        throw new CredentialBrokerError('invalid_response', 'The OS credential broker returned an invalid response.');
      }
      return key.toLowerCase();
    },
    async approveCredentialCommand(command: string): Promise<boolean> {
      const body = await request(CREDENTIAL_BROKER_APPROVE_COMMAND_PATH, 'POST', { command }, APPROVAL_TIMEOUT_MS);
      const approved = (body as { approved?: unknown } | null)?.approved;
      if (typeof approved !== 'boolean') {
        throw new CredentialBrokerError('invalid_response', 'The OS credential broker returned an invalid response.');
      }
      return approved;
    },
  };
}

function readBrokerUrl(env: NodeJS.ProcessEnv): URL {
  const value = env[CREDENTIAL_BROKER_URL_ENV]?.trim();
  if (!value) {
    throw new CredentialBrokerError('unavailable', 'The OS credential broker is unavailable.');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CredentialBrokerError('unavailable', 'The OS credential broker configuration is invalid.');
  }

  const loopbackHosts = new Set(['127.0.0.1', '[::1]']);
  if (
    url.protocol !== 'http:'
    || !loopbackHosts.has(url.hostname)
    || !url.port
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new CredentialBrokerError('unavailable', 'The OS credential broker configuration is invalid.');
  }
  return url;
}
