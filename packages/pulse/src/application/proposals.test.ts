import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, closeDb, setSession, clearSession, type LlmProvider } from '@pulse-metric-studio/core';
import { PulseAuthorProposalSchema, applyPulseProposal, type DatasourceCatalog } from '@pulse-metric-studio/shared';
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

test('field IDs with outer whitespace survive draft save and reopen', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-field-id-'));
  config.dataDir = temporary;
  config.dbPath = path.join(temporary, 'fixture.db');
  try {
    const repository = new PulseRepository();
    const draft = repository.createDraft({ context: { connectionId: 'fixture', serverUrl: 'https://fixture.example', siteId: 'site', datasourceLuid: 'source' }, datasourceName: 'Fixture' });
    const id = ' Revenue | Net ';
    const date = ' Order Date ';
    const measure = { id, name: id, label: 'Revenue', caption: 'Revenue', role: 'MEASURE' as const, dataType: 'REAL', table: null, formula: null, defaultAggregation: null, requiresUserAgg: false };
    const dimension = { ...measure, id: ' Region | East ', name: ' Region | East ', role: 'DIMENSION' as const, dataType: 'STRING' };
    const time = { ...dimension, id: date, name: date, dataType: 'DATE', timeType: 'DATE' as const };
    const fields = { datasourceLuid: 'source', datasourceName: 'Fixture', measures: [measure], dimensions: [dimension], timeDimensions: [time], parameters: [], excluded: [], source: 'vds' as const, warnings: [] };
    const document = applyPulseProposal(draft.document, [{ op: 'ADD_METRIC', fieldId: id, timeDimensionFieldId: date }, { op: 'ADD_SLICER', fieldId: dimension.id }], fields);
    repository.saveDraft(draft.id, { expectedRevision: draft.revision, document });
    const reopened = repository.getDraft(draft.id).document;
    assert.equal(reopened.metrics[id].fieldId, id);
    assert.equal(reopened.metrics[id].timeDimensionFieldId, date);
    assert.equal(reopened.slicers[dimension.id].fieldId, dimension.id);
  } finally { closeDb(); fs.rmSync(temporary, { recursive: true, force: true }); }
});
