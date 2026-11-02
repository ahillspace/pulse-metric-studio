import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmModelOption } from '@pulse-metric-studio/shared';
import { buildModelOptions, isCurrentModel } from './llm-model-options.js';

const catalog: LlmModelOption[] = [
  { id: 'opencode/big-pickle', label: 'Big Pickle' },
  { id: 'opencode/nemotron-free', label: 'Nemotron Free' },
];

test('OpenCode options preserve catalog entries without adding an unavailable current model', () => {
  assert.deepEqual(buildModelOptions(catalog, 'opencode/big-pickle'), [
    { id: 'opencode/big-pickle', label: 'Big Pickle', unavailable: false },
    { id: 'opencode/nemotron-free', label: 'Nemotron Free', unavailable: false },
  ]);
});

test('OpenCode options preserve a configured model missing from the current catalog as unavailable', () => {
  assert.deepEqual(buildModelOptions(catalog, 'opencode/legacy-model'), [
    { id: 'opencode/legacy-model', label: 'opencode/legacy-model (currently configured, unavailable)', unavailable: true },
    { id: 'opencode/big-pickle', label: 'Big Pickle', unavailable: false },
    { id: 'opencode/nemotron-free', label: 'Nemotron Free', unavailable: false },
  ]);
});

test('OpenCode options do not invent a configured model when the current value is blank', () => {
  assert.deepEqual(buildModelOptions([], ''), []);
});

test('only an explicit current catalog model is selectable as usable', () => {
  assert.equal(isCurrentModel(catalog, ''), false);
  assert.equal(isCurrentModel(catalog, 'opencode/legacy-model'), false);
  assert.equal(isCurrentModel(catalog, 'opencode/big-pickle'), true);
});

test('catalog options support provider model IDs without OpenCode-specific assumptions', () => {
  assert.deepEqual(buildModelOptions([{ id: 'model-alias', label: 'Account model' }], 'model-alias'), [
    { id: 'model-alias', label: 'Account model', unavailable: false },
  ]);
});
