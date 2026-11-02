import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectPulseBoundary } from './check-pulse-architecture.mjs';

test('boundary checks reject privileged frontend imports and provider serialization', () => {
  const failures = inspectPulseBoundary('packages/web/src/features/pulse/editor.ts', "import { getDb } from '@pulse-metric-studio/core';\nconst payloads = buildCreatePayloads(input);");
  assert.equal(failures.length, 2);
  assert.deepEqual(failures.map((failure) => failure.line), [1, 2]);
});
test('boundary checks reject IO in pure rules and SQL inside application workflows', () => {
  assert.equal(inspectPulseBoundary('packages/shared/src/pulse-domain.ts', "import fs from 'node:fs';\nfetch('/work');").length, 2);
  assert.equal(inspectPulseBoundary('packages/pulse/src/application/publish.ts', "import { getDb } from '@pulse-metric-studio/core';\ndb.prepare('SELECT * FROM runs');").length, 2);
});
test('domain contracts and explicit repository dependencies are allowed', () => {
  assert.deepEqual(inspectPulseBoundary('packages/pulse/src/application/publish.ts', "import type { PulseDraftRecord } from '@pulse-metric-studio/shared';\nimport { DraftRepository } from '../persistence/drafts.js';"), []);
  assert.deepEqual(inspectPulseBoundary('packages/web/src/features/pulse/api/client.ts', "import { PulseDraftRecordSchema } from '@pulse-metric-studio/shared';"), []);
});
test('retired Pulse endpoints cannot remain in production routes or clients', () => {
  assert.equal(inspectPulseBoundary('packages/web/src/api/client.ts', "request('/api/pulse/metrics/create'); request(`/api/drafts/${id}`);").length, 2);
  assert.equal(inspectPulseBoundary('packages/pulse/src/http/routes.ts', "app.post('/api/pulse/metrics/fork-dimensional', handler);").length, 1);
  assert.deepEqual(inspectPulseBoundary('packages/web/src/api/client.ts', "request(`/api/pulse/drafts/${id}/publish`);"), []);
});
