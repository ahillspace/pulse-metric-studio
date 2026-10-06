import { closeDb, config, getDb } from '@pulse-metric-studio/core';
import { emptyPulseDocument } from '@pulse-metric-studio/shared';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PulseRepository } from './repository.js';

test('offline workspaces survive credentials removal and reject a stale writer', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-workspace-'));
  config.dataDir = directory;
  config.dbPath = path.join(directory, 'db.sqlite');
  try {
    const repo = new PulseRepository();
    const draft = repo.createDraft({
      context: {
        connectionId: 'missing-profile',
        serverUrl: 'https://example.test',
        siteId: 'site',
        datasourceLuid: 'ds',
      },
      datasourceName: 'Sales',
    });
    const document = { ...emptyPulseDocument(), digestAudience: 'Executives' };
    assert.equal(
      repo.saveDraft(draft.id, { expectedRevision: 1, document }).revision,
      2,
    );
    assert.throws(
      () =>
        repo.saveDraft(draft.id, {
          expectedRevision: 1,
          document: emptyPulseDocument(),
        }),
      /changed/,
    );
    assert.equal(repo.getDraft(draft.id).document.digestAudience, 'Executives');
    closeDb();
    assert.equal(new PulseRepository().getDraft(draft.id).revision, 2);
    assert.deepEqual(
      getDb()
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'pulse_%' AND name <> 'pulse_drafts' ORDER BY name",
        )
        .all()
        .map((r: any) => r.name),
      ['pulse_publish_items', 'pulse_publish_runs', 'pulse_workspaces'],
    );
  } finally {
    closeDb();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
