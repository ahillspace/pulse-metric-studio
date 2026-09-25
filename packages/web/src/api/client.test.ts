import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractErrorMessage } from './client.js';

test('uses a string error field verbatim', () => {
  assert.equal(extractErrorMessage({ error: 'Boom' }, 500), 'Boom');
});

test('coerces a structured error object to its message, not "[object Object]"', () => {
  const message = extractErrorMessage({ error: { message: 'Field not found', code: 404904 } }, 404);
  assert.equal(message, 'Field not found');
});

test('serializes a structured error object with no message field', () => {
  const message = extractErrorMessage({ error: { code: 400706, path: 'dimensions' } }, 400);
  assert.notEqual(message, '[object Object]');
  assert.ok(message.includes('400706'));
});

test('falls back to a top-level message field', () => {
  assert.equal(extractErrorMessage({ message: 'Not Found' }, 404), 'Not Found');
});

test('falls back to a generic message with the status when nothing usable is present', () => {
  assert.equal(extractErrorMessage(null, 503), 'Request failed (503)');
  assert.equal(extractErrorMessage({ error: '' }, 502), 'Request failed (502)');
});
