import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmProtocol } from '@pulse-metric-studio/shared';
import type { StoredLlmProfile } from '../profiles.js';
import { HttpLlmProvider } from './openai-compat.js';
import { assertSafeLlmEndpoint } from './network-policy.js';
import { clearCredentialCache } from './credential.js';

const allowEndpoint = async () => undefined;

function profile(protocol: LlmProtocol): StoredLlmProfile {
  return {
    id: protocol,
    label: protocol,
    protocol,
    baseUrl: 'https://gateway.example.test/v1',
    model: 'model-1',
    authMode: protocol === 'anthropic-messages' ? 'x-api-key' : 'bearer',
    secret: 'secret-value',
    headers: { 'x-company-route': 'route-a' },
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

test('credential commands mint the x-api-key token per request and satisfy configuration', async () => {
  clearCredentialCache();
  const credentialed: StoredLlmProfile = {
    ...profile('anthropic-messages'),
    secret: '',
    credentialCommand: `node -e "process.stdout.write('MINTED-TOKEN')"`,
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
