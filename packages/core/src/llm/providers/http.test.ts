import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmProtocol } from '@pulse-metric-studio/shared';
import type { StoredLlmProfile } from '../profiles.js';
import { HttpLlmProvider } from './openai-compat.js';
import { assertSafeLlmEndpoint } from './network-policy.js';
import { clearCredentialCache } from './credential.js';
import { LlmProviderError } from '../types.js';

const allowEndpoint = async () => undefined;

function profile(protocol: LlmProtocol): StoredLlmProfile {
  return {
    id: protocol,
    label: protocol,
    protocol,
    baseUrl: 'https://gateway.example.test/v1',
    model: 'model-1',
    authMode: protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer',
    secret: { value: 'secret-value' },
    headers: { 'x-company-route': { value: 'route-a' } },
    credentialCommand: null,
    credentialCommandHint: null,
    region: '',
    awsProfile: '',
    command: '',
    source: 'saved',
  };
}

test('Chat Completions profiles use bearer auth, safe headers, and the configured model', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const provider = new HttpLlmProvider(profile('openai-chat'), async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Response.json({ choices: [{ message: { content: 'done' } }] });
  }, allowEndpoint);
  const result = await provider.complete({ system: 'system', messages: [{ role: 'user', content: 'hello' }] });
  const request = requests[0];
  assert.ok(request);
  assert.equal(result.text, 'done');
  assert.equal(request.url, 'https://gateway.example.test/v1/chat/completions');
  assert.equal((request.init.headers as Record<string, string>).Authorization, 'Bearer secret-value');
  assert.equal((request.init.headers as Record<string, string>)['x-company-route'], 'route-a');
  assert.equal(JSON.parse(String(request.init.body)).model, 'model-1');
});

test('HTTP protocols omit sampling parameters that current Claude models reject', async () => {
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages'] as const) {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new HttpLlmProvider(profile(protocol), async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content: 'done' } }], output_text: 'done', content: [{ type: 'text', text: 'done' }] });
    }, allowEndpoint);
    await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(bodies.length, 1, protocol);
    assert.equal('temperature' in bodies[0]!, false, protocol);
  }
});

test('credential commands mint the x-api-key token per request and satisfy configuration', async () => {
  clearCredentialCache();
  const credentialed: StoredLlmProfile = {
    ...profile('anthropic-messages'),
    secret: null,
    credentialCommand: { value: `node -e "process.stdout.write('MINTED-TOKEN')"` },
    credentialCommandHint: 'node ...',
  };
  const requests: Array<{ init: RequestInit }> = [];
  const provider = new HttpLlmProvider(credentialed, async (_input, init) => {
    requests.push({ init: init ?? {} });
    return Response.json({ content: [{ type: 'text', text: 'done' }] });
  }, allowEndpoint);
  assert.equal(await provider.isConfigured(), true);
  const result = await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.text, 'done');
  assert.equal((requests[0]?.init.headers as Record<string, string>)['x-api-key'], 'MINTED-TOKEN');
});

test('Responses and Anthropic Messages profiles use protocol-specific request and response shapes', async () => {
  const seen: string[] = [];
  const responses = new HttpLlmProvider(profile('openai-responses'), async (input) => {
    seen.push(String(input));
    return Response.json({ output_text: 'response text' });
  }, allowEndpoint);
  const anthropic = new HttpLlmProvider(profile('anthropic-messages'), async (input, init) => {
    seen.push(String(input));
    assert.equal((init?.headers as Record<string, string>)['x-api-key'], 'secret-value');
    assert.equal((init?.headers as Record<string, string>)['anthropic-version'], '2023-06-01');
    return Response.json({ content: [{ type: 'text', text: 'anthropic text' }] });
  }, allowEndpoint);
  assert.equal((await responses.complete({ messages: [{ role: 'user', content: 'hello' }] })).text, 'response text');
  assert.equal((await anthropic.complete({ messages: [{ role: 'user', content: 'hello' }] })).text, 'anthropic text');
  assert.deepEqual(seen, ['https://gateway.example.test/v1/responses', 'https://gateway.example.test/v1/messages']);
});

test('HTTP provider failures never include response bodies or secrets', async () => {
  const provider = new HttpLlmProvider(profile('openai-chat'), async () => new Response('server leaked secret-value', { status: 500 }), allowEndpoint);
  await assert.rejects(
    () => provider.complete({ messages: [{ role: 'user', content: 'hello' }] }),
    (error: Error) => !error.message.includes('secret-value') && /HTTP 500/.test(error.message),
  );
});

test('HTTP provider error explanations never echo the request credential', async () => {
  const provider = new HttpLlmProvider(profile('openai-chat'), async () => Response.json(
    { error: { message: 'Key secret-value is not valid for this model.' } },
    { status: 400 },
  ), allowEndpoint);
  await assert.rejects(
    () => provider.complete({ messages: [{ role: 'user', content: 'hello' }] }),
    (error: Error) => !error.message.includes('secret-value') && /HTTP 400: Key \[redacted\] is not valid/.test(error.message),
  );
});

test('HTTP provider error explanations never echo custom header credentials', async () => {
  const configured = { ...profile('openai-chat'), headers: { 'x-gateway-key': { value: 'Bearer header-credential-value' } } };
  const provider = new HttpLlmProvider(configured, async () => Response.json(
    { error: { message: 'Upstream rejected header-credential-value for route.' } },
    { status: 403 },
  ), allowEndpoint);
  await assert.rejects(
    () => provider.complete({ messages: [{ role: 'user', content: 'hello' }] }),
    (error: Error) => !error.message.includes('header-credential-value') && /\[redacted\]/.test(error.message),
  );
});

test('HTTP providers disable redirects so credentials cannot cross origins', async () => {
  let init: RequestInit | undefined;
  const provider = new HttpLlmProvider(profile('openai-chat'), async (_input, requestInit) => {
    init = requestInit;
    return Response.json({ choices: [{ message: { content: 'done' } }] });
  }, allowEndpoint);
  await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(init?.redirect, 'error');
});

test('endpoint policy blocks private resolved addresses unless explicitly allowed', async () => {
  const lookup = async () => [{ address: '10.20.30.40', family: 4 }] as const;
  await assert.rejects(() => assertSafeLlmEndpoint('https://gateway.example.test/v1', false, lookup), /private network/i);
  await assert.doesNotReject(() => assertSafeLlmEndpoint('https://gateway.example.test/v1', true, lookup));
});

test('HTTP providers surface the provider explanation and report truncation', async () => {
  const rejecting = new HttpLlmProvider(profile('anthropic-messages'), async () => Response.json(
    { error: { message: 'Authentication Error, No api key passed in.', type: 'auth_error' } },
    { status: 401 },
  ), allowEndpoint);
  await assert.rejects(() => rejecting.complete({ messages: [{ role: 'user', content: 'hello' }] }), (error: unknown) =>
    error instanceof LlmProviderError && /rejected authentication: Authentication Error, No api key passed in\./.test(error.message));
  const truncating = new HttpLlmProvider(profile('anthropic-messages'), async () => Response.json(
    { content: [{ type: 'text', text: '{"ops":[' }], stop_reason: 'max_tokens' },
  ), allowEndpoint);
  assert.equal((await truncating.complete({ messages: [{ role: 'user', content: 'hello' }] })).truncated, true);
});

test('HTTP requests stop on caller cancellation without reporting a timeout', async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const provider = new HttpLlmProvider(profile('openai-chat'), async (_input, init) => new Promise((_resolve, reject) => {
    started();
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
  }), allowEndpoint);
  const pending = provider.complete({ messages: [], signal: controller.signal });
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
  await ready;
  controller.abort();
  await rejected;
});

test('HTTP cancellation before sending does not submit a request', async () => {
  let sent = false;
  const provider = new HttpLlmProvider(profile('openai-chat'), async () => {
    sent = true;
    return Response.json({ choices: [{ message: { content: 'done' } }] });
  }, allowEndpoint);
  await assert.rejects(() => provider.complete({ messages: [], signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(sent, false);
});
