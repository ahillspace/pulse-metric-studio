import assert from 'node:assert/strict';
import React from 'react';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { LLM_PROTOCOLS } from '@pulse-metric-studio/shared';
import { ProviderSetupChoices, PROVIDER_CHOICES, newProviderId, providerAccess, providerChoice, providerDescription, straightenQuotes } from './llm-provider-choices';
import { ProfileEditor, changeProfileProtocol } from './LlmSettings';

test('provider mutations freeze every settings control until the saved response arrives', () => {
  const props: Parameters<typeof ProfileEditor>[0] = {
    form: {
      id: 'gateway', label: 'Gateway', protocol: 'openai-chat', baseUrl: 'https://example.com', model: 'model', authMode: 'bearer',
      secret: '', hasSecret: true, clearSecret: false, headersText: '{}', headersDirty: false, clearHeaders: false,
      region: '', awsProfile: '', command: '', credentialCommand: '', hasCredentialCommand: false,
      credentialCommandHint: null, clearCredentialCommand: false, allowPrivateNetwork: false, source: 'saved',
    },
    setForm: () => {}, dirty: false, existing: true, busy: true,
    onCheck: async () => {}, onSave: async () => {}, onTest: async () => {}, onSelect: () => {}, onDelete: () => {},
  };
  const busy = renderToStaticMarkup(<ProfileEditor {...props} />);
  assert.match(busy, /^<fieldset[^>]*aria-label="Provider settings"[^>]*disabled=""/);
  for (const label of ['Display name', 'Endpoint', 'Model', 'Key or token', 'Safe custom headers', 'Protocol'])
    assert.ok(busy.includes(label), label);
  const idle = renderToStaticMarkup(<ProfileEditor {...props} busy={false} />);
  assert.doesNotMatch(idle.match(/^<fieldset[^>]*>/)?.[0] ?? '', /disabled/);
});

test('clean-install setup renders choices without broken or configured profile claims', () => {
  const html = renderToStaticMarkup(<ProviderSetupChoices onChoose={() => undefined} />);
  for (const choice of PROVIDER_CHOICES) assert.ok(html.includes(choice.label));
  assert.match(html, /Choose an assistant provider/);
  assert.match(html, /subscription access supported by OpenCode/);
  assert.match(html, /Local providers inherit your CLI configuration and launch options/);
  assert.doesNotMatch(html, /disabled=""|Codex CLI is unavailable/);
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
  assert.deepEqual(JSON.parse(straightenQuotes('{\u201cx-route\u201d: \u201cclaude\u201d}')), { 'x-route': 'claude' });
  assert.equal(straightenQuotes('\u2018/Applications/devbar.app/Contents/MacOS/devbar\u2019 auth claude'), "'/Applications/devbar.app/Contents/MacOS/devbar' auth claude");
});

test('every supported protocol has an explicit provider description and account source', () => {
  for (const protocol of LLM_PROTOCOLS) {
    const choice = providerChoice(protocol);
    assert.ok(choice, protocol);
    assert.ok(choice.description.length > 20, protocol);
  }
  assert.equal(providerAccess('codex-cli', 'local-account'), 'Current Codex CLI account');
  assert.equal(providerAccess('claude-code', 'local-account'), 'Current Claude Code account');
  assert.match(providerDescription('claude-code', 'local-account'), /usage credits/);
});

test('protocol conversion preserves compatible API drafts and clears incompatible credential claims', () => {
  const api: Parameters<typeof ProfileEditor>[0]['form'] = {
    id: 'gateway', label: 'Gateway', protocol: 'openai-chat', baseUrl: 'https://gateway.example.test/v1',
    model: 'explicit-model', authMode: 'x-api-key', secret: 'new-key', hasSecret: true, clearSecret: false,
    headersText: '{"x-route":"draft"}', headersDirty: true, clearHeaders: false,
    region: '', awsProfile: '', command: '', credentialCommand: 'new-command', hasCredentialCommand: true,
    credentialCommandHint: 'saved-command', clearCredentialCommand: false, allowPrivateNetwork: true, source: 'saved',
  };
  const responses = changeProfileProtocol(api, 'openai-responses', true);
  assert.deepEqual(responses, { ...api, protocol: 'openai-responses' });
  for (const protocol of ['codex-cli', 'claude-code', 'anthropic-messages'] as const) {
    const changed = changeProfileProtocol(api, protocol, true);
    assert.equal(changed.hasSecret, false);
    assert.equal(changed.secret, '');
    assert.equal(changed.hasCredentialCommand, false);
    assert.equal(changed.credentialCommand, '');
    assert.equal(changed.credentialCommandHint, null);
    assert.equal(changed.headersText, '{}');
    assert.equal(changed.headersDirty, false);
    assert.equal(changed.clearSecret, true);
    assert.equal(changed.clearCredentialCommand, true);
    assert.equal(changed.clearHeaders, true);
    const back = changeProfileProtocol(changed, 'openai-chat', true);
    assert.equal(back.clearSecret, true, 'returning to the original protocol does not restore a discarded credential');
    assert.equal(back.hasSecret, false);
  }
});

test('an unchecked OpenCode launch command cannot save an unverified catalog model or claim it is unavailable', () => {
  const props: Parameters<typeof ProfileEditor>[0] = {
    form: {
      id: 'opencode', label: 'OpenCode', protocol: 'opencode', baseUrl: '', model: 'opencode/current-model', authMode: 'none',
      secret: '', hasSecret: false, clearSecret: false, headersText: '{}', headersDirty: false, clearHeaders: false,
      region: '', awsProfile: '', command: 'opencode --pure', credentialCommand: '', hasCredentialCommand: false,
      credentialCommandHint: null, clearCredentialCommand: false, allowPrivateNetwork: false, source: 'saved',
    },
    setForm: () => {}, dirty: true, existing: true, busy: false,
    onCheck: async () => {}, onSave: async () => {}, onTest: async () => {}, onSelect: () => {}, onDelete: () => {},
  };
  const html = renderToStaticMarkup(<ProfileEditor {...props} />);
  assert.match(html, /opencode\/current-model/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Save profile/);
  assert.doesNotMatch(html, /currently configured, unavailable|reported no current models/);
  assert.match(html, /<button[^>]*>Reload models/);
});

for (const protocol of ['codex-cli', 'claude-code'] as const) {
  test(`${protocol} setup exposes its executable, manual model, and passive account check without API credentials`, () => {
    const choice = providerChoice(protocol);
    const props: Parameters<typeof ProfileEditor>[0] = {
      form: {
        id: choice.id, label: choice.label, protocol, baseUrl: '', model: 'selected-model', authMode: 'local-account',
        secret: '', hasSecret: false, clearSecret: false, headersText: '{}', headersDirty: false, clearHeaders: false,
        region: '', awsProfile: '', command: choice.command, credentialCommand: '', hasCredentialCommand: false,
        credentialCommandHint: null, clearCredentialCommand: false, allowPrivateNetwork: false, source: 'new',
      },
      setForm: () => {}, dirty: true, existing: false, busy: false,
      onCheck: async () => {}, onSave: async () => {}, onTest: async () => {}, onSelect: () => {}, onDelete: () => {},
    };
    const html = renderToStaticMarkup(<ProfileEditor {...props} />);
    assert.match(html, /Check setup/);
    assert.match(html, /does not send a model request/);
    assert.match(html, /Test connection sends a model request/);
    assert.match(html, /inherit your CLI credentials, instructions, tools, skills, hooks, and MCP servers/);
    assert.match(html, /unless your launch options change them/);
    assert.match(html, /outside draft review/);
    assert.match(html, /Launch command/);
    assert.match(html, /app adds headless, model, and response-format options/);
    assert.match(html, /Shell expansion is unavailable/);
    assert.match(html, protocol === 'codex-cli' ? /codex --sandbox read-only/ : /claude --safe-mode/);
    assert.match(html, new RegExp(`${choice.command} (?:auth )?login`));
    assert.match(html, /No supported model catalog/);
    assert.doesNotMatch(html, /Key or token|Credential command|Safe custom headers|AWS region|Endpoint<input|Authentication<select/);
    assert.doesNotMatch(html, /Loading models|reported no current models/);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Test connection/);
    assert.match(html, /<button[^>]*>Save profile/);
    const missing = renderToStaticMarkup(<ProfileEditor {...props} setupStatus={{
      installed: false, configured: false, healthy: null, reasonCode: 'not_installed',
      reason: 'Install the CLI, then check setup again.', resolvedModel: null,
    }} />);
    assert.match(missing, /CLI: Not found/);
    assert.match(missing, /Configuration: Not configured/);
    assert.match(missing, /Install the CLI/);
    const configured = renderToStaticMarkup(<ProfileEditor {...props} busy={true} setupStatus={{
      installed: true, configured: true, healthy: null, reasonCode: 'not_tested',
      reason: 'Account detected. No model request was sent.', resolvedModel: null,
    }} />);
    assert.match(configured, /^<fieldset[^>]*disabled=""/);
    assert.match(configured, /CLI: Installed/);
    assert.match(configured, /Configuration: Ready for test/);
    assert.match(configured, /Account detected. No model request was sent/);
    assert.doesNotMatch(configured, />Connected</);
    const edited = renderToStaticMarkup(<ProfileEditor {...props} existing={true} status={{
      ...props.form, source: 'saved', headers: {}, installed: true, configured: true, available: true,
      healthy: true, reasonCode: 'ready', reason: 'Old saved executable was verified.', resolvedModel: 'old-model',
    }} />);
    assert.doesNotMatch(edited, /Old saved executable was verified|Configuration: Ready for test/);
    const saved = renderToStaticMarkup(<ProfileEditor {...props} existing={true} dirty={false} status={{
      ...props.form, source: 'saved', headers: {}, installed: true, configured: true, available: true,
      healthy: true, reasonCode: 'ready', reason: 'Previously verified.', resolvedModel: 'selected-model',
    }} />);
    assert.doesNotMatch(saved, /<button[^>]*disabled=""[^>]*>Test connection/);
    assert.doesNotMatch(saved, /<button[^>]*disabled=""[^>]*>Use provider/);
    assert.match(saved, /<button[^>]*>Save profile/);
  });
}
