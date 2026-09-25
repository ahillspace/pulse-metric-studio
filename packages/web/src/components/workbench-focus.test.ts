import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getFocusBoundary, getFocusTrapTarget } from './workbench-focus.js';

test('focus boundaries return the first and last focusable item', () => {
  assert.deepEqual(getFocusBoundary(['close', 'cancel', 'confirm']), {
    first: 'close',
    last: 'confirm',
  });
  assert.equal(getFocusBoundary([]), null);
});

test('Tab from the last item returns focus to the first item', () => {
  const items = ['close', 'cancel', 'confirm'];
  assert.equal(getFocusTrapTarget(items, 'confirm', false), 'close');
  assert.equal(getFocusTrapTarget(items, 'cancel', false), null);
});

test('Shift+Tab from the first item returns focus to the last item', () => {
  const items = ['close', 'cancel', 'confirm'];
  assert.equal(getFocusTrapTarget(items, 'close', true), 'confirm');
  assert.equal(getFocusTrapTarget(items, 'cancel', true), null);
});
