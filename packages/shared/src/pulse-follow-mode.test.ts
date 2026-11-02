import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyPulseDocument, PulseFollowReceiptSchema, PulseWorkspaceDocumentV1Schema } from './pulse-contracts.js';
import { mergePulseProposal } from './pulse-domain.js';

test('new documents follow the publishing account while legacy flags preserve saved intent', () => {
  assert.equal(emptyPulseDocument().followMode, 'self');
  for (const [groupFollow, mode] of [[true, 'group'], [false, 'none']] as const) {
    const input = { ...emptyPulseDocument(), digestAudience: 'Audience', digestAudienceLocked: true, groupFollow };
    delete (input as Record<string, unknown>).followMode;
    const parsed = PulseWorkspaceDocumentV1Schema.parse(input);
    assert.equal(parsed.followMode, mode);
    assert.equal(parsed.digestAudience, 'Audience');
    assert.equal(parsed.digestAudienceLocked, true);
    assert.equal(Object.hasOwn(parsed, 'groupFollow'), false);
  }
});

test('legacy follow receipts keep group meaning and no-follow receipts stay off', () => {
  for (const requested of [true, false]) {
    const receipt = PulseFollowReceiptSchema.parse({ version: 1, requested, group: { status: 'not_attempted' }, membership: { status: 'not_attempted' }, subscriptions: [] });
    assert.equal(receipt.mode, requested ? 'group' : 'none');
  }
});

test('manual follow choice survives assistant proposal acceptance', () => {
  const base = emptyPulseDocument();
  const current = { ...base, followMode: 'none' as const };
  const candidate = { ...base, followMode: 'group' as const, digestAudience: 'Suggested audience' };
  const result = mergePulseProposal(base, candidate, current);
  assert.equal(result.document.followMode, 'none');
});
