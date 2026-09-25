import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequestSequencer } from './dimensional-fork-requests.js';

test('only the latest issued token is current', () => {
  const seq = createRequestSequencer();
  const first = seq.next();
  const second = seq.next();
  assert.notEqual(first, second);
  assert.equal(seq.isLatest(first), false);
  assert.equal(seq.isLatest(second), true);
});

test('a fresh sequencer treats an unissued token as stale', () => {
  const seq = createRequestSequencer();
  assert.equal(seq.isLatest(1), false);
  const issued = seq.next();
  assert.equal(issued, 1);
  assert.equal(seq.isLatest(1), true);
});

test('a superseded (stale) response must not overwrite the latest result', () => {
  // Models the fields loader: two loads race, the second one wins.
  const seq = createRequestSequencer();
  let rendered: string[] | null = null;
  let renderedError: string | null = null;

  const staleToken = seq.next();
  const latestToken = seq.next();

  // Latest request resolves first with the correct fields.
  const applyLatest = ['region', 'segment'];
  if (seq.isLatest(latestToken)) rendered = applyLatest;

  // The superseded request resolves afterwards with an older result.
  const applyStale = ['old-field'];
  if (seq.isLatest(staleToken)) rendered = applyStale;

  // And a stale request that failed on WebKit's corrupted keep-alive must be ignored.
  const staleError = 'Load failed';
  if (seq.isLatest(staleToken)) renderedError = staleError;

  assert.deepEqual(rendered, applyLatest, 'latest response wins, stale response ignored');
  assert.equal(renderedError, null, 'a stale request error is never surfaced');
});

test('rapid source switching yields the LATEST response fields', () => {
  const seq = createRequestSequencer();
  const switches = ['a', 'b', 'c'];
  const tokens = switches.map(() => seq.next());
  let fields: string | null = null;

  // Responses arrive out of order; only the last switch (c) may apply.
  for (const index of [1, 0, 2]) {
    if (seq.isLatest(tokens[index])) fields = switches[index];
  }

  assert.equal(fields, 'c');
});
