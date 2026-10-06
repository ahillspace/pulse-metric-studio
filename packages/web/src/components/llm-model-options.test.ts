import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LlmModelOption } from '@pulse-metric-studio/shared';
import { buildOpenCodeModelOptions, isCurrentOpenCodeModel, openCodeCatalogProfileId } from './llm-model-options.js';

const catalog: LlmModelOption[] = [
  { id: 'opencode/big-pickle', label: 'Big Pickle' },
  { id: 'opencode/nemotron-free', label: 'Nemotron Free' },
];

test('OpenCode options preserve catalog entries without adding an unavailable current model', () => {
  assert.deepEqual(buildOpenCodeModelOptions(catalog, 'opencode/big-pickle'), [
    { id: 'opencode/big-pickle', label: 'Big Pickle', unavailable: false },
    { id: 'opencode/nemotron-free', label: 'Nemotron Free', unavailable: false },
  ]);
});

test('OpenCode options preserve a configured model missing from the current catalog as unavailable', () => {
  assert.deepEqual(buildOpenCodeModelOptions(catalog, 'opencode/legacy-model'), [
    { id: 'opencode/legacy-model', label: 'opencode/legacy-model (currently configured, unavailable)', unavailable: true },
    { id: 'opencode/big-pickle', label: 'Big Pickle', unavailable: false },
    { id: 'opencode/nemotron-free', label: 'Nemotron Free', unavailable: false },
  ]);
});

test('OpenCode options do not invent a configured model when the current value is blank', () => {
  assert.deepEqual(buildOpenCodeModelOptions([], ''), []);
});

test('only an explicit current catalog model is selectable as usable', () => {
  assert.equal(isCurrentOpenCodeModel(catalog, ''), false);
  assert.equal(isCurrentOpenCodeModel(catalog, 'opencode/legacy-model'), false);
  assert.equal(isCurrentOpenCodeModel(catalog, 'opencode/big-pickle'), true);
});

test('new setup and protocol conversion discover models without a synthetic profile', () => {
  assert.equal(openCodeCatalogProfileId(true, 'openai-chat', 'saved-http'), null);
  assert.equal(openCodeCatalogProfileId(true, 'opencode', 'saved-opencode'), 'saved-opencode');
  assert.equal(openCodeCatalogProfileId(false, undefined, 'new-profile'), null);
});
