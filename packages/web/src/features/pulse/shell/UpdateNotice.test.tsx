import assert from 'node:assert/strict';
import React from 'react';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { UpdateEvents } from '../../../desktop-updates';
import { UpdateButton, UpdateDialog, UpdateNotice } from './UpdateNotice';

const status = { currentVersion: '0.1.2', availableVersion: '0.1.3', lastError: null };

test('there is no update button until an update is found', () => {
  const events: UpdateEvents = { native: () => true, listen: async () => () => {}, status: async () => status, apply: async () => {} };
  assert.equal(renderToStaticMarkup(<UpdateNotice events={events} />), '');
});

test('the rail button names the version it installs', () => {
  const html = renderToStaticMarkup(<UpdateButton version="0.1.3" onClick={() => {}} />);
  assert.match(html, /<span>Update to 0\.1\.3<\/span>/);
  assert.match(html, /aria-label="Update Pulse Metric Studio to version 0.1.3"/);
});

test('the prompt explains the update and reports why the last one did not finish', () => {
  const props = { status, applying: false, error: null, onLater: () => {}, onUpdate: () => {} };
  const html = renderToStaticMarkup(<UpdateDialog {...props} />);
  assert.match(html, /Pulse Metric Studio 0\.1\.3 is available\. You have 0\.1\.2\./);
  assert.match(html, />Update now</);
  assert.doesNotMatch(html, /did not finish/);

  const failed = renderToStaticMarkup(<UpdateDialog {...props} status={{ ...status, lastError: 'Could not download checksums.txt.' }} />);
  assert.match(failed, /The last update did not finish: Could not download checksums\.txt\./);

  const applying = renderToStaticMarkup(<UpdateDialog {...props} applying />);
  assert.match(applying, /Closing\.\.\./);
  assert.equal((applying.match(/disabled=""/g) ?? []).length, 2);
});
