import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfileEditor } from './LlmSettings';

test('saved CLI configuration distinguishes unchecked installation from explicit setup results', () => {
  const props: Parameters<typeof ProfileEditor>[0] = {
    form: {
      id: 'fixture', label: 'Fixture', protocol: 'codex-cli', baseUrl: '', model: 'fixture-model', authMode: 'local-account',
      secret: '', hasSecret: false, clearSecret: false, headersText: '{}', headersDirty: false, clearHeaders: false,
      region: '', awsProfile: '', command: 'codex', credentialCommand: '', hasCredentialCommand: false,
      credentialCommandHint: null, clearCredentialCommand: false, allowPrivateNetwork: false, source: 'saved',
    },
    setForm: () => {}, dirty: false, existing: true, busy: false,
    onCheck: async () => {}, onSave: async () => {}, onTest: async () => {}, onSelect: () => {}, onDelete: () => {},
  };
  const status = {
    ...props.form, source: 'saved' as const, headers: {}, installed: null, configured: true, available: true, healthy: null,
    reasonCode: 'not_tested' as const, reason: 'Configured; access has not been checked.', resolvedModel: 'fixture-model',
  };
  const passive = renderToStaticMarkup(<ProfileEditor {...props} status={status} />);
  assert.match(passive, /CLI: Not checked/);
  assert.match(passive, /Configuration: Configured, not checked/);
  assert.doesNotMatch(passive, /CLI: Installed|CLI: Not found/);
  const checked = renderToStaticMarkup(<ProfileEditor {...props} status={status} setupStatus={{ ...status, installed: true }} />);
  assert.match(checked, /CLI: Installed/);
  assert.match(checked, /Configuration: Ready for test/);
});
