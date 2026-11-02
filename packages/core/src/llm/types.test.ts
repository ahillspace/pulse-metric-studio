import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeProviderMessage } from './types.js';

test('provider diagnostics redact quoted credential fields and preserve useful errors', () => {
  for (const key of [
    'token',
    'access_token',
    'refreshToken',
    'personalAccessTokenSecret',
    'patSecret',
    'apiKey',
    'API_KEY',
    'api-key',
    'X-Tableau-Auth',
    'authorization',
    'password',
    'secret',
  ]) {
    const value = 'fixture credential with spaces and "quotes"';
    const result = sanitizeProviderMessage(
      JSON.stringify({ [key]: value, message: 'Permission denied' }),
    );
    assert.equal(result.includes('fixture'), false, key);
    assert.match(result, /Permission denied/);
    assert.match(result, /redacted/);
  }
});

test('provider diagnostics retain header, URL, size, and whitespace protections', () => {
  for (const value of [
    'Authorization: Bearer fixture-value',
    'X-Tableau-Auth: fixture-value',
    'patSecret=fixture-value',
    'api_key=fixture-value',
    'https://fixture-user:fixture-value@example.test',
  ]) {
    assert.equal(
      sanitizeProviderMessage(value).includes('fixture-value'),
      false,
    );
  }
  assert.equal(sanitizeProviderMessage('x'.repeat(700)).length, 500);
  assert.equal(sanitizeProviderMessage('one\ntwo\tthree'), 'one two three');
});


test('provider diagnostics redact complete unquoted Basic and Bearer authorization values', () => {
  const credential = Buffer.from('fixture-user:fixture-password').toString('base64');
  for (const scheme of ['Basic', 'basic', 'BASIC', 'Bearer', 'bEaReR']) {
    for (const header of ['Authorization:', 'authorization=', '"Authorization":', 'Proxy-Authorization:']) {
      const result = sanitizeProviderMessage(`${header} ${scheme} ${credential}; Permission denied`);
      assert.equal(result.includes(credential), false, `${header} ${scheme}`);
      assert.match(result, /Permission denied/);
      assert.match(result, /redacted/);
    }
  }
});
