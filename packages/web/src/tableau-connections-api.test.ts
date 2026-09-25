import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canCompensateStagedCredential,
  createTableauConnectionsApi,
  CredentialMutationError,
  credentialActionLabel,
  deleteNativeCredential,
  getCredentialCapability,
  restoredConnectionFields,
  storeNativeCredential,
  isTauriRuntime,
} from './tableau-connections-api.js';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

test('uses the platform-specific credential action labels', () => {
  assert.equal(credentialActionLabel('windows'), 'Add to Windows Credential Manager');
  assert.equal(credentialActionLabel('macos'), 'Add to macOS Keychain');
  assert.equal(credentialActionLabel('browser'), null);
  assert.equal(credentialActionLabel('unsupported'), null);
});

test('reports browser fallback without presenting a native credential action', async () => {
  const capability = await getCredentialCapability();
  assert.deepEqual(capability, {
    available: false,
    platform: 'browser',
    actionLabel: null,
    reason: 'OS credential storage is available only in the desktop app.',
  });
});

test('calls narrow Tauri credential commands with the PAT only in command arguments', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    if (command === 'tableau_store_credential') return { credentialRef: 'credential-ref-1' } as T;
    return { removed: true } as T;
  };

  const credentialRef = await storeNativeCredential({
    serverUrl: 'https://example.online.tableau.com',
    siteContentUrl: 'sales',
    patName: 'desktop-pat',
    patSecret: 'native-only-secret',
  }, invoke);
  await deleteNativeCredential(credentialRef, invoke);

  assert.equal(credentialRef, 'credential-ref-1');
  assert.equal(calls[0].command, 'tableau_store_credential');
  assert.equal(calls[1].command, 'tableau_delete_credential');
  assert.deepEqual(calls[1].args, { request: { credentialRef: 'credential-ref-1' } });
});

test('sends only a credential reference in the OS-managed public request', async () => {
  let requestBody = '';
  const api = createTableauConnectionsApi(async (_input, init) => {
    requestBody = String(init?.body);
    return new Response(JSON.stringify({
      ok: true,
      connection: {
        id: 'connection-1',
        label: 'Tableau Cloud',
        serverUrl: 'https://example.online.tableau.com',
        siteContentUrl: 'sales',
        patName: 'desktop-pat',
        storageKind: 'os',
        credentialRef: 'credential-ref-1',
      },
      session: {
        serverUrl: 'https://example.online.tableau.com',
        siteContentUrl: 'sales',
        siteId: 'site-id',
        userId: 'user-id',
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, () => OPERATION_ID);

  await api.connect({
    serverUrl: 'https://example.online.tableau.com',
    siteContentUrl: 'sales',
    patName: 'desktop-pat',
    storageKind: 'os',
    credentialRef: 'credential-ref-1',
  });

  assert.deepEqual(JSON.parse(requestBody), {
    serverUrl: 'https://example.online.tableau.com',
    siteContentUrl: 'sales',
    patName: 'desktop-pat',
    storageKind: 'os',
    credentialRef: 'credential-ref-1',
    operationId: OPERATION_ID,
  });
  assert.equal(requestBody.includes('patSecret'), false);
});

test('restores connection coordinates and PAT name without a PAT secret', () => {
  const restored = restoredConnectionFields({
    id: 'connection-1',
    label: 'Tableau Cloud',
    serverUrl: 'https://example.online.tableau.com',
    siteContentUrl: 'sales',
    patName: 'desktop-pat',
    storageKind: 'os',
    credentialRef: 'credential-ref-1',
    isActive: true,
  });

  assert.deepEqual(restored, {
    serverUrl: 'https://example.online.tableau.com',
    siteContentUrl: 'sales',
    patName: 'desktop-pat',
  });
  assert.equal('patSecret' in restored, false);
});

test('replaceCredential API sends only the new credential reference, not the PAT secret', async () => {
  let requestBody = '';
  const api = createTableauConnectionsApi(async (_input, init) => {
    requestBody = String(init?.body);
    return new Response(JSON.stringify({
      ok: true,
      connection: { id: 'connection-1', label: 'Tableau Cloud', serverUrl: 'https://example.online.tableau.com', siteContentUrl: 'sales', patName: 'desktop-pat', storageKind: 'os', credentialRef: 'credential-ref-new' },
      session: { serverUrl: 'https://example.online.tableau.com', siteContentUrl: 'sales', siteId: 'site-id', userId: 'user-id' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, () => OPERATION_ID);

  await api.replaceCredential('connection-1', {
    storageKind: 'os',
    credentialRef: 'credential-ref-new',
    patName: 'desktop-pat',
  });

  assert.deepEqual(JSON.parse(requestBody), {
    storageKind: 'os',
    credentialRef: 'credential-ref-new',
    patName: 'desktop-pat',
    operationId: OPERATION_ID,
  });
  assert.equal(requestBody.includes('patSecret'), false);
});

test('replaceCredential API with encrypted fallback requires explicit consent and sends PAT secret', async () => {
  let requestBody = '';
  const api = createTableauConnectionsApi(async (_input, init) => {
    requestBody = String(init?.body);
    return new Response(JSON.stringify({
      ok: true,
      connection: { id: 'connection-1', label: 'Tableau Cloud', serverUrl: 'https://example.online.tableau.com', siteContentUrl: 'sales', patName: 'desktop-pat', storageKind: 'encrypted', credentialRef: null },
      session: { serverUrl: 'https://example.online.tableau.com', siteContentUrl: 'sales', siteId: 'site-id', userId: 'user-id' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, () => OPERATION_ID);

  await api.replaceCredential('connection-1', {
    storageKind: 'encrypted',
    patSecret: 'new-secret',
    patName: 'desktop-pat',
    explicitFallback: true,
  });

  const body = JSON.parse(requestBody);
  assert.equal(body.storageKind, 'encrypted');
  assert.equal(body.patSecret, 'new-secret');
  assert.equal(body.explicitFallback, true);
  assert.equal(body.credentialRef, undefined);
  assert.equal(body.operationId, OPERATION_ID);
});

test('retries a lost create response with the same idempotency key and credential reference', async () => {
  const requestBodies: string[] = [];
  const api = createTableauConnectionsApi(async (_input, init) => {
    requestBodies.push(String(init?.body));
    if (requestBodies.length === 1) throw new TypeError('response lost');
    return successfulOsMutationResponse('credential-ref-1');
  }, () => OPERATION_ID);

  const result = await api.connect({
    serverUrl: 'https://example.online.tableau.com',
    siteContentUrl: 'sales',
    patName: 'desktop-pat',
    storageKind: 'os',
    credentialRef: 'credential-ref-1',
  });

  assert.equal(result.connection.credentialRef, 'credential-ref-1');
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0], requestBodies[1]);
  assert.deepEqual(JSON.parse(requestBodies[0]), {
    serverUrl: 'https://example.online.tableau.com',
    siteContentUrl: 'sales',
    patName: 'desktop-pat',
    storageKind: 'os',
    credentialRef: 'credential-ref-1',
    operationId: OPERATION_ID,
  });
});

test('retries a lost replacement response with the same idempotency key and credential reference', async () => {
  const requestBodies: string[] = [];
  const api = createTableauConnectionsApi(async (_input, init) => {
    requestBodies.push(String(init?.body));
    if (requestBodies.length === 1) throw new TypeError('response lost');
    return successfulOsMutationResponse('credential-ref-new');
  }, () => OPERATION_ID);

  await api.replaceCredential('connection-1', {
    storageKind: 'os',
    credentialRef: 'credential-ref-new',
    patName: 'desktop-pat',
  });

  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0], requestBodies[1]);
  assert.equal(JSON.parse(requestBodies[0]).operationId, OPERATION_ID);
});

test('permits compensation only after the server confirms rejection', async () => {
  const api = createTableauConnectionsApi(async (input) => {
    if (String(input) === '/api/tableau/connections/reconcile') {
      return jsonResponse({ status: 'not_committed' });
    }
    return jsonResponse({ message: 'Tableau sign-in failed.' }, 401);
  }, () => OPERATION_ID);

  await assert.rejects(
    api.connect({
      serverUrl: 'https://example.online.tableau.com',
      siteContentUrl: 'sales',
      patName: 'desktop-pat',
      storageKind: 'os',
      credentialRef: 'credential-ref-1',
    }),
    (error: unknown) => error instanceof CredentialMutationError
      && canCompensateStagedCredential(error)
      && error.message === 'Tableau sign-in failed.',
  );
});

test('treats a rejected mutation as committed when reconciliation finds the credential reference', async () => {
  const requests: string[] = [];
  const api = createTableauConnectionsApi(async (input) => {
    requests.push(String(input));
    if (String(input) === '/api/tableau/connections/reconcile') {
      return jsonResponse({
        status: 'committed',
        connection: {
          id: OPERATION_ID,
          label: 'Tableau Cloud',
          serverUrl: 'https://example.online.tableau.com',
          siteContentUrl: 'sales',
          patName: 'desktop-pat',
          storageKind: 'os',
          credentialRef: 'credential-ref-1',
        },
      });
    }
    return jsonResponse({ message: 'Internal response failure.' }, 500);
  }, () => OPERATION_ID);

  const result = await api.connect({
    serverUrl: 'https://example.online.tableau.com',
    siteContentUrl: 'sales',
    patName: 'desktop-pat',
    storageKind: 'os',
    credentialRef: 'credential-ref-1',
  });

  assert.equal(result.connection.credentialRef, 'credential-ref-1');
  assert.equal(result.session, null);
  assert.deepEqual(requests, ['/api/tableau/connect', '/api/tableau/connections/reconcile']);
});

test('retains the staged credential when reconciliation also loses its response', async () => {
  let attempts = 0;
  const api = createTableauConnectionsApi(async () => {
    attempts += 1;
    throw new TypeError('network unavailable');
  }, () => OPERATION_ID);

  await assert.rejects(
    api.connect({
      serverUrl: 'https://example.online.tableau.com',
      siteContentUrl: 'sales',
      patName: 'desktop-pat',
      storageKind: 'os',
      credentialRef: 'credential-ref-1',
    }),
    (error: unknown) => error instanceof CredentialMutationError
      && !canCompensateStagedCredential(error)
      && error.message.includes('credential was retained')
      && !error.message.includes('network unavailable'),
  );
  assert.equal(attempts, 2);
});

test('isTauriRuntime detects Tauri environment', () => {
  const originalWindow = global.window;
  try {
    global.window = {} as any;
    assert.equal(isTauriRuntime(), false);
    (global.window as any).__TAURI_INTERNALS__ = true;
    assert.equal(isTauriRuntime(), true);
  } finally {
    global.window = originalWindow;
  }
});

function successfulOsMutationResponse(credentialRef: string): Response {
  return new Response(JSON.stringify({
    ok: true,
    connection: {
      id: OPERATION_ID,
      label: 'Tableau Cloud',
      serverUrl: 'https://example.online.tableau.com',
      siteContentUrl: 'sales',
      patName: 'desktop-pat',
      storageKind: 'os',
      credentialRef,
    },
    session: {
      serverUrl: 'https://example.online.tableau.com',
      siteContentUrl: 'sales',
      siteId: 'site-id',
      userId: 'user-id',
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
