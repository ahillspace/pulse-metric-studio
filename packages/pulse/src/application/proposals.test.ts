import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, closeDb, setSession, clearSession, type LlmProvider } from '@pulse-metric-studio/core';
import { PulseAuthorProposalSchema, type DatasourceCatalog } from '@pulse-metric-studio/shared';
import { authorOps } from '../llm-authoring.js';
import { PulseRepository } from '../persistence/repository.js';
import { PulseProposalService } from './proposals.js';

test('proposal service preserves parser warnings and only accepted changes through the shared response contract', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-proposal-warnings-'));
  config.dataDir = temporary;
  config.dbPath = path.join(temporary, 'fixture.db');
  const session = { serverUrl: 'https://tableau.example.test', siteContentUrl: 'fixture', siteId: 'fixture', userId: 'fixture-user', token: 'fixture-token', apiVersion: '3.27' };
  setSession(session, { connectionId: 'fixture-connection', patSecret: 'fixture-secret' });
  const catalog: DatasourceCatalog = {
    datasourceLuid: 'fixture-source', datasourceName: 'Fixture', measures: [], timeDimensions: [], parameters: [], excluded: [], source: 'vds', warnings: [],
    dimensions: [{ id: 'Region', name: 'Region', caption: 'Region', label: 'Region', role: 'DIMENSION', dataType: 'STRING', table: null, formula: null, defaultAggregation: null, requiresUserAgg: false }],
  };
  const provider: LlmProvider = {
    id: 'fixture-provider', label: 'Fixture provider', isConfigured: async () => true,
    complete: async () => ({ text: JSON.stringify({ assistantMessage: 'Added both metrics.', ops: [
      { op: 'ADD_SLICER', fieldId: 'Region' }, { op: 'ADD_METRIC', fieldId: 'Invalid', aggregation: 'INVALID' },
    ] }) }),
  };
  try {
    const repository = new PulseRepository();
    const draft = repository.createDraft({ context: { connectionId: 'fixture-connection', serverUrl: session.serverUrl, siteId: session.siteId, datasourceLuid: catalog.datasourceLuid }, datasourceName: 'Fixture' });
    const service = new PulseProposalService(repository, { catalog: async () => catalog, propose: (input) => authorOps(provider, { catalog: input.catalog, chat: input.document.chat, userMessage: input.message }) });
    const response = PulseAuthorProposalSchema.parse(await service.propose(draft.id, draft.revision, 'Build metrics'));
    assert.equal(response.warnings?.length, 1);
    assert.match(response.warnings![0], /Dropped ADD_METRIC/);
    assert.equal(response.candidateDocument.slicers.Region?.active, true);
    assert.equal(response.candidateDocument.metrics.Invalid, undefined);
    assert.match(response.assistantMessage, /invalid suggestions were omitted/i);
    assert.equal(response.candidateDocument.chat.at(-1)?.content, response.assistantMessage);
    assert.deepEqual(repository.getDraft(draft.id).document, draft.document, 'review does not persist unaccepted changes');
  } finally { clearSession(); closeDb(); fs.rmSync(temporary, { recursive: true, force: true }); }
});
