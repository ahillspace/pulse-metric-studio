import assert from 'node:assert/strict';
import React from 'react';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProviderSetupChoices, PROVIDER_CHOICES, newProviderId, providerAccess, providerChoice, providerDescription, straightenQuotes } from './llm-provider-choices';

test('clean-install setup renders choices without broken or configured profile claims', () => {
  const html = renderToStaticMarkup(<ProviderSetupChoices onChoose={() => undefined} />);
  for (const choice of PROVIDER_CHOICES) assert.ok(html.includes(choice.label));
  assert.match(html, /Choose an assistant provider/);
  assert.match(html, /subscription access supported by OpenCode/);
  assert.doesNotMatch(html, /unhealthy|Not tested|Chat Completions|Converse/);
});

test('new setup never reuses a saved provider ID', () => {
  assert.equal(newProviderId('openai', [{ id: 'openai' }, { id: 'openai-2' }]), 'openai-3');
  assert.equal(newProviderId('opencode', []), 'opencode');
});

test('supported protocol variants retain their provider family', () => {
  assert.equal(providerChoice('openai-responses').id, 'openai');
  assert.equal(providerChoice('bedrock-converse').id, 'bedrock');
  assert.equal(PROVIDER_CHOICES.find(choice => choice.id === 'anthropic')?.authMode, 'x-api-key');
});

test('saved profiles describe the authentication they actually use', () => {
  assert.equal(providerAccess('bedrock-converse', 'aws'), 'AWS credentials');
  assert.equal(providerAccess('bedrock-converse', 'bearer'), 'Bearer token');
  assert.equal(providerAccess('anthropic-messages', 'bearer'), 'Bearer token');
  assert.equal(providerAccess('opencode', 'none'), 'Configured accounts');
  assert.doesNotMatch(providerDescription('bedrock-converse', 'bearer'), /AWS profile/);
  assert.match(providerDescription('bedrock-converse', 'aws'), /AWS profile/);
});

test('curly quotes from macOS text substitution are straightened', () => {
  assert.deepEqual(JSON.parse(straightenQuotes('{“x-route”: “claude”}')), { 'x-route': 'claude' });
  assert.equal(straightenQuotes('‘/Applications/devbar.app/Contents/MacOS/devbar’ auth claude'), "'/Applications/devbar.app/Contents/MacOS/devbar' auth claude");
});
