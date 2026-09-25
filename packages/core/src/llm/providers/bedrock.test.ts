import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoredLlmProfile } from '../profiles.js';
import { BedrockProvider, classifyBedrockError } from './bedrock.js';
import { clearCredentialCache } from './credential.js';

const allowEndpoint = async () => undefined;

test('Bedrock bearer profiles use the verified Converse HTTP contract', async () => {
  const profile: StoredLlmProfile = {
    id: 'bedrock-key', label: 'Bedrock API key', protocol: 'bedrock-converse', baseUrl: '',
    model: 'us.anthropic.claude-model', authMode: 'bearer', secret: 'bedrock-secret', headers: {},
    region: 'us-west-2', awsProfile: '', command: '', source: 'saved',
  };
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const provider = new BedrockProvider(profile, async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return Response.json({ output: { message: { content: [{ text: 'done' }] } } });
  }, allowEndpoint);
  const result = await provider.complete({ system: 'system', messages: [{ role: 'user', content: 'hello' }] });
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.url, 'https://bedrock-runtime.us-west-2.amazonaws.com/model/us.anthropic.claude-model/converse');
  assert.equal((request.init.headers as Record<string, string>).Authorization, 'Bearer bedrock-secret');
  assert.equal(request.init.redirect, 'error');
  assert.equal(JSON.parse(String(request.init.body)).messages[0].content[0].text, 'hello');
  assert.equal(result.text, 'done');
});

test('Bedrock bearer profiles mint the token from a credential command', async () => {
  clearCredentialCache();
  const profile: StoredLlmProfile = {
    id: 'bedrock-key', label: 'Bedrock API key', protocol: 'bedrock-converse', baseUrl: '',
    model: 'us.anthropic.claude-model', authMode: 'bearer', secret: '', headers: {},
    region: 'us-west-2', awsProfile: '', command: '', credentialCommand: `node -e "process.stdout.write('MINTED-TOKEN')"`, source: 'saved',
  };
  const requests: Array<{ init: RequestInit }> = [];
  const provider = new BedrockProvider(profile, async (_input, init) => {
    requests.push({ init: init ?? {} });
    return Response.json({ output: { message: { content: [{ text: 'done' }] } } });
  }, allowEndpoint);
  assert.equal((await provider.getHealth()).configured, true);
  const result = await provider.complete({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(result.text, 'done');
  assert.equal((requests[0]?.init.headers as Record<string, string>).Authorization, 'Bearer MINTED-TOKEN');
});

test('Bedrock bearer timeout failures are classified as provider timeouts', async () => {
  const profile: StoredLlmProfile = {
    id: 'bedrock-key', label: 'Bedrock API key', protocol: 'bedrock-converse', baseUrl: '',
    model: 'us.anthropic.claude-model', authMode: 'bearer', secret: 'bedrock-secret', headers: {},
    region: 'us-west-2', awsProfile: '', command: '', source: 'saved',
  };
  const provider = new BedrockProvider(profile, async () => {
    throw new DOMException('Timed out', 'TimeoutError');
  }, allowEndpoint);
  await assert.rejects(
    () => provider.complete({ messages: [{ role: 'user', content: 'hello' }] }),
    (error: any) => error?.code === 'provider_timeout' && error?.retryable === true,
  );
});

test('Bedrock SDK errors use AWS names and status metadata for classification', () => {
  assert.equal(classifyBedrockError({ name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }).code, 'provider_authentication');
  assert.equal(classifyBedrockError({ name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } }).code, 'provider_quota');
  assert.equal(classifyBedrockError({ name: 'ServiceUnavailableException', $metadata: { httpStatusCode: 503 } }).code, 'provider_unavailable');
});
