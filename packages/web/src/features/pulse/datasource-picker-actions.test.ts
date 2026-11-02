import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDatasourceListKey } from './datasource-picker-actions.js';

test('arrow keys move the active option and clamp at the ends', () => {
  assert.deepEqual(resolveDatasourceListKey('ArrowDown', 0, 3), { type: 'move', index: 1 });
  assert.deepEqual(resolveDatasourceListKey('ArrowUp', 1, 3), { type: 'move', index: 0 });
  // Clamp: cannot move above the first or below the last option.
  assert.deepEqual(resolveDatasourceListKey('ArrowUp', 0, 3), { type: 'move', index: 0 });
  assert.deepEqual(resolveDatasourceListKey('ArrowDown', 2, 3), { type: 'move', index: 2 });
});

test('Home and End jump to the first and last option', () => {
  assert.deepEqual(resolveDatasourceListKey('Home', 2, 3), { type: 'move', index: 0 });
  assert.deepEqual(resolveDatasourceListKey('End', 0, 3), { type: 'move', index: 2 });
});

test('Enter selects the active option only when in range', () => {
  assert.deepEqual(resolveDatasourceListKey('Enter', 1, 3), { type: 'select', index: 1 });
  assert.deepEqual(resolveDatasourceListKey('Enter', -1, 3), { type: 'none' });
  assert.deepEqual(resolveDatasourceListKey('Enter', 3, 3), { type: 'none' });
});

test('an empty option list ignores every key', () => {
  assert.deepEqual(resolveDatasourceListKey('ArrowDown', 0, 0), { type: 'none' });
  assert.deepEqual(resolveDatasourceListKey('Enter', 0, 0), { type: 'none' });
});

test('unhandled keys are a no-op so typing in the search box still works', () => {
  assert.deepEqual(resolveDatasourceListKey('a', 0, 3), { type: 'none' });
  assert.deepEqual(resolveDatasourceListKey(' ', 0, 3), { type: 'none' });
});
