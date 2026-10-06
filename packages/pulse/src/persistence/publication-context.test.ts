import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, config, getDb } from '@pulse-metric-studio/core';
import { PulseRepository } from './repository.js';
import { emptyFollowReceipt } from './migrations.js';

const context = { connectionId: 'connection', serverUrl: 'https://example.test', siteId: 'site-id', datasourceLuid: 'source' };
function temporaryDb() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-context-'));
  config.dataDir = directory;
  config.dbPath = path.join(directory, 'test.db');
  return () => { closeDb(); fs.rmSync(directory, { recursive: true, force: true }); };
}

test('publication display provenance survives reopening independently of the draft and session', () => {
  const cleanup = temporaryDb();
  try {
    new PulseRepository().admit({
      id: 'publication', requestHash: 'request', context, datasourceName: 'Source', userId: 'user',
      digestAudience: 'delete me', siteContentUrl: 'pace-dev', items: [], follow: emptyFollowReceipt(),
    });
    closeDb();
    const repository = new PulseRepository();
    const receipt = repository.getReceipt('publication');
    assert.equal(receipt.digestAudience, 'delete me');
    assert.equal(receipt.siteContentUrl, 'pace-dev');
    const summary = repository.listReceipts().receipts[0]!;
    assert.equal(summary.digestAudience, 'delete me');
    assert.equal(summary.siteContentUrl, 'pace-dev');
  } finally { cleanup(); }
});

test('publication provenance migration preserves old receipts and does not invent missing values', () => {
  const cleanup = temporaryDb();
  try {
    const db = getDb();
    db.exec(`ALTER TABLE pulse_publish_runs DROP COLUMN digest_audience;
      ALTER TABLE pulse_publish_runs DROP COLUMN site_content_url;
      DELETE FROM _migrations WHERE key='pulse:003';`);
    db.prepare('INSERT INTO pulse_publish_runs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      'old-publication', null, 'connection', 'https://example.test', 'site-id', 'user',
      'source', 'Unchanged source', 1, 2, JSON.stringify(emptyFollowReceipt()),
    );
    closeDb();
    const repository = new PulseRepository();
    const receipt = repository.getReceipt('old-publication');
    assert.equal(receipt.datasourceName, 'Unchanged source');
    assert.equal(receipt.createdAt, 1);
    assert.equal(receipt.finishedAt, 2);
    assert.equal(receipt.digestAudience, undefined);
    assert.equal(receipt.siteContentUrl, undefined);
    assert.equal(getDb().prepare("SELECT COUNT(*) FROM _migrations WHERE key='pulse:003'").pluck().get(), 1);
  } finally { cleanup(); }
});
