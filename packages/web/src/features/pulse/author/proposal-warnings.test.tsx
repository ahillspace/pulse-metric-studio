import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { catalog, draft } from '../testing/fixtures';
import type { DraftEditor } from './controller';
import { ProposalReview } from './ProposalReview';

test('proposal review displays validation warnings before accepted changes and their apply action', () => {
  const document = draft().document;
  const entry = {
    document, proposalBase: document, catalog: catalog(),
    proposal: { baseRevision: 1, candidateDocument: document, assistantMessage: 'Validated changes.', changes: [], warnings: ['Dropped an invalid operation <fixture>.'] },
  } as unknown as DraftEditor;
  const markup = renderToStaticMarkup(<ProposalReview entry={entry} />);
  assert.match(markup, /aria-label="Assistant validation warnings"/);
  assert.match(markup, /Dropped an invalid operation &lt;fixture&gt;/);
  assert.ok(markup.indexOf('Assistant validation warnings') < markup.indexOf('Measures and filters'));
  assert.ok(markup.indexOf('Dropped an invalid') < markup.indexOf('Apply changes'));
  entry.proposal!.warnings = [];
  assert.doesNotMatch(renderToStaticMarkup(<ProposalReview entry={entry} />), /Assistant validation warnings/);
});
