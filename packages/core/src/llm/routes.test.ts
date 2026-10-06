import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { LlmProfileWriteSchema, type LlmModelCatalogResponse, type LlmProfileWrite, type LlmStatusResponse } from '@pulse-metric-studio/shared';
import { registerLlmRoutes, type LlmProviderService } from './routes.js';

function publicProfile(id: string) {
  return {
    id,
    label: 'Gateway',
    protocol: 'openai-chat' as const,
    baseUrl: 'https://gateway.example.test/v1',
    model: 'model-1',
    authMode: 'bearer' as const,
    hasSecret: true,
    secretHint: '...1234',
    headers: {},
    region: '',
    awsProfile: '',
    command: '',
    credentialCommand: '',
    allowPrivateNetwork: false,
    source: 'saved' as const,
  };
}

test('LLM settings routes return masked profiles and never echo secrets', async () => {
  let saved: LlmProfileWrite | undefined;
  const service: LlmProviderService = {
    status: async (): Promise<LlmStatusResponse> => ({
      active: 'opencode',
      resolvedProvider: null,
      providers: {},
      models: {},
      readiness: { state: 'red', providerId: 'opencode', message: 'Select a model.', lastSuccessfulAt: null },
    }),
    listProfiles: async () => [publicProfile('gateway')],
    listModels: async (): Promise<LlmModelCatalogResponse> => ({ provider: 'opencode', source: 'opencode-cli-cache', models: [] }),
    listSetupModels: async (): Promise<LlmModelCatalogResponse> => ({ provider: 'opencode', source: 'opencode-cli-cache', models: [] }),
    saveProfile: async (profile) => {
      saved = profile;
      return publicProfile(profile.id);
    },
    deleteProfile: async () => undefined,
    setActive: async (id) => id,
    testProfile: async () => ({ ...publicProfile('gateway'), installed: true, configured: true, available: true, healthy: true, reasonCode: 'ready', reason: null, resolvedModel: 'model-1' }),
    pick: async () => { throw new Error('not used'); },
  };
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerLlmRoutes(app, { service });
  await app.ready();

  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/llm/profiles/gateway',
      payload: {
        id: 'gateway',
        label: 'Gateway',
        protocol: 'openai-chat',
        baseUrl: 'https://gateway.example.test/v1',
        model: 'model-1',
        authMode: 'bearer',
        secret: 'super-secret-1234',
        headers: {},
      },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(saved?.secret, 'super-secret-1234');
    assert.equal(response.body.includes('super-secret-1234'), false);
    assert.equal(response.json().hasSecret, true);
  } finally {
    await app.close();
  }
});

test('LLM model route returns the shared OpenCode model catalog', async () => {
  let requestedId = '';
  const service = {
    listModels: async (id: string): Promise<LlmModelCatalogResponse> => {
      requestedId = id;
      return {
        provider: 'opencode',
        source: 'opencode-cli-cache',
        models: [{ id: 'opencode/big-pickle', label: 'Big Pickle' }],
      };
    },
  } as unknown as LlmProviderService;
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerLlmRoutes(app, { service });
  await app.ready();
  try {
    const response = await app.inject({ method: 'GET', url: '/api/llm/profiles/opencode/models' });
    assert.equal(response.statusCode, 200);
    assert.equal(requestedId, 'opencode');
    assert.deepEqual(response.json(), {
      provider: 'opencode',
      source: 'opencode-cli-cache',
      models: [{ id: 'opencode/big-pickle', label: 'Big Pickle' }],
    });
  } finally {
    await app.close();
  }
});

test('LLM model route rejects invalid profile IDs before catalog lookup', async () => {
  const service = { listModels: async () => { throw new Error('must not run'); } } as unknown as LlmProviderService;
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerLlmRoutes(app, { service });
  await app.ready();
  try {
    const response = await app.inject({ method: 'GET', url: '/api/llm/profiles/not%20valid/models' });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('LLM provider route rejects the removed automatic selection', async () => {
  const service = { setActive: async () => { throw new Error('must not run'); } } as unknown as LlmProviderService;
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerLlmRoutes(app, { service });
  await app.ready();
  try {
    const response = await app.inject({ method: 'POST', url: '/api/llm/provider', payload: { provider: 'auto' } });
    assert.equal(response.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('LLM settings routes reject security-sensitive custom headers', async () => {
  const service = {} as LlmProviderService;
  const app = Fastify({ logger: false });
  await app.register(sensible);
  registerLlmRoutes(app, { service });
  await app.ready();
  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/llm/profiles/gateway',
      payload: {
        id: 'gateway',
        label: 'Gateway',
        protocol: 'openai-chat',
        baseUrl: 'https://gateway.example.test/v1',
        model: 'model-1',
        authMode: 'bearer',
        headers: { Authorization: 'must-not-pass' },
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body.includes('must-not-pass'), false);
  } finally {
    await app.close();
  }
});

test('LLM profile validation rejects endpoint query and fragment components', () => {
  const base = {
    id: 'gateway', label: 'Gateway', protocol: 'openai-chat', model: 'model-1', authMode: 'bearer', headers: {},
  } as const;
  assert.equal(LlmProfileWriteSchema.safeParse({ ...base, baseUrl: 'https://gateway.example.test/v1?token=secret' }).success, false);
  assert.equal(LlmProfileWriteSchema.safeParse({ ...base, baseUrl: 'https://gateway.example.test/v1#fragment' }).success, false);
});

test('LLM profile validation rejects control characters in custom header values', () => {
  const result = LlmProfileWriteSchema.safeParse({
    id: 'gateway', label: 'Gateway', protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1',
    model: 'model-1', authMode: 'bearer', headers: { 'x-company-route': 'route-a\r\nx-injected: yes' },
  });
  assert.equal(result.success, false);
});

test('LLM profile validation rejects masked header placeholders', () => {
  const result = LlmProfileWriteSchema.safeParse({
    id: 'gateway', label: 'Gateway', protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1',
    model: 'model-1', authMode: 'bearer', headers: { 'x-company-route': '[configured]' },
  });
  assert.equal(result.success, false);
});

test('LLM profile validation accepts a credential command for HTTP protocols', () => {
  const result = LlmProfileWriteSchema.safeParse({
    id: 'gateway', label: 'Gateway', protocol: 'anthropic-messages', baseUrl: 'https://gateway.example.test/v1',
    model: 'claude-model', authMode: 'bearer', headers: {}, credentialCommand: 'mint-token --scope llm',
  });
  assert.equal(result.success, true);
});

test('LLM profile validation rejects a credential command for OpenCode profiles', () => {
  const result = LlmProfileWriteSchema.safeParse({
    id: 'opencode', label: 'OpenCode', protocol: 'opencode', model: 'opencode/model',
    authMode: 'none', command: 'opencode', credentialCommand: 'mint-token',
  });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.some((issue) => issue.path[0] === 'credentialCommand'), true);
});

test('LLM profile validation rejects a credential command with AWS credential mode', () => {
  const result = LlmProfileWriteSchema.safeParse({
    id: 'bedrock', label: 'Bedrock', protocol: 'bedrock-converse', model: 'us.anthropic.claude-model',
    authMode: 'aws', headers: {}, region: 'us-west-2', credentialCommand: 'mint-token',
  });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.some((issue) => issue.path[0] === 'credentialCommand'), true);
});

test('LLM profile validation requires an explicit OpenCode model', () => {
  const result = LlmProfileWriteSchema.safeParse({
    id: 'opencode',
    label: 'OpenCode',
    protocol: 'opencode',
    model: '',
    authMode: 'none',
    command: 'opencode',
  });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.some((issue) => issue.path[0] === 'model'), true);
});
