import { describe, expect, it } from 'vitest';
import { createProposal, cloneProposal, nextProposalRevision } from './defaults';
import { assertProposalAnalysisProvenance, buildProposalDocumentPublic, buildProposalPublic, proposalExportAssets, validateProposal } from './exportPublic';
import { commercialFingerprint } from './commercialDocument';
import type { ProposalData } from './types';

function receipt(): NonNullable<ProposalData['analysisProvenance']> {
  const sourceSnapshotKey = `sha256:${'a'.repeat(64)}` as const, quote = 'PRIVATE-LEDGER-QUOTE';
  return { version: 1, origin: 'model-selected-quotes', sourceSnapshotKey,
    parts: [{ batchId: 'batch-1', model: 'PRIVATE-LEDGER-MODEL', raw: JSON.stringify({ sourceSnapshotKey, batchId: 'batch-1', units: [{ unitId: 'private-unit', disposition: 'commercial', roles: ['scope'], quote }] }) }],
    selections: [{ unitId: 'private-unit', sourceId: 'private-source', fragmentId: 'private-unit', locator: 'PRIVATE-LEDGER-LOCATOR', quote, roles: ['scope'] }],
    counts: { units: 1, commercial: 1, context: 0, unclear: 0, batches: 1 }, projectedItemId: 'private-result' };
}
function data(): ProposalData {
  const proposal = createProposal(new Date(2035, 0, 1)); proposal.title = 'Учебный проект'; proposal.issuer.name = 'Исполнитель'; proposal.recipient.name = 'Заказчик';
  proposal.lines[0].title = 'Услуги'; proposal.lines[0].unitPrice = '100'; proposal.analysisProvenance = receipt(); return proposal;
}
describe('additive private analysis provenance storage/export boundary', () => {
  it('keeps legacy records without a ledger compatible and never equates a structural receipt with readiness', () => {
    const proposal = data(); delete proposal.analysisProvenance;
    expect(() => assertProposalAnalysisProvenance(proposal)).not.toThrow(); expect(buildProposalPublic(proposal)).not.toHaveProperty('analysisProvenance');
    proposal.analysisProvenance = receipt(); expect(validateProposal(proposal).some(issue => issue.field === 'analysisProvenance')).toBe(false);
    expect(proposal.status).toBe('draft'); expect(proposal.sourceFinancials?.decision).toBeUndefined();
  });
  it.each([null, false, {}, { version: 999 }])('rejects present malformed private payload %j without deleting or changing it', async invalid => {
    const proposal = data(); Object.assign(proposal, { analysisProvenance: invalid }); const before = structuredClone(proposal);
    expect(() => assertProposalAnalysisProvenance(proposal)).toThrow(/Журнал/);
    expect(validateProposal(proposal)).toContainEqual(expect.objectContaining({ field: 'analysisProvenance', severity: 'error' }));
    expect(() => buildProposalPublic(proposal)).toThrow(/Журнал/); await expect(buildProposalDocumentPublic(proposal)).rejects.toThrow(/Журнал/); expect(proposal).toEqual(before);
  });
  it('excludes all private ledger raw/model/source metadata from old public DTO and export assets', () => {
    const proposal = data(), before = structuredClone(proposal), output = buildProposalPublic(proposal);
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE-LEDGER|private-unit|private-source|private-result|analysisProvenance|model-selected-quotes|sourceSnapshotKey/);
    expect(proposalExportAssets(proposal)).toEqual([]); expect(proposal).toEqual(before);
  });
  it('keeps the structured public DTO private even when the model receipt differs from editable public content', async () => {
    const proposal = data(), publicText = 'Публичный состав работ.';
    proposal.commercialDocument = { version: 1, revision: 1, body: { version: 1, sections: [{ id: 'scope', kind: 'scope', title: 'Состав услуг', blocks: [{ id: 'scope-body', kind: 'paragraph', style: 'body', content: [{ kind: 'text', text: publicText }] }] }] },
      privateAppendix: { version: 1, documentId: 'document', sourceSnapshotKey: proposal.analysisProvenance!.sourceSnapshotKey, extraction: { complete: true, requiresOcr: false, visualAssessment: 'unassessed' }, containers: [{ id: 'container', sourceId: 'source', kind: 'contract', heading: 'Договор' }], clauses: [{ id: 'clause', containerId: 'container', sourceId: 'source', sourceName: 'Источник', locator: 'Абзац', quote: publicText, quoteHash: await commercialFingerprint(publicText), roles: ['scope'], classification: 'commercial' }], references: [], coverage: [{ sourceClauseId: 'clause', kind: 'literal', targetBlockIds: ['scope-body'] }] }, questions: [], decisions: [] };
    const before = structuredClone(proposal), output = await buildProposalDocumentPublic(proposal);
    expect(output.schemaVersion).toBe(2); expect(JSON.stringify(output)).toContain(publicText);
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE-LEDGER|private-unit|private-source|private-result|analysisProvenance|model-selected-quotes|sourceSnapshotKey/); expect(proposal).toEqual(before);
    Object.assign(proposal, { analysisProvenance: { ...proposal.analysisProvenance, approved: true } });
    await expect(buildProposalDocumentPublic(proposal)).rejects.toThrow(/Журнал/);
  });
  it('retains historical provenance through JSON persistence, copies and revisions without granting current model or price approval', () => {
    const proposal = data(), restored = JSON.parse(JSON.stringify(proposal)) as ProposalData, copied = cloneProposal(restored), revision = nextProposalRevision(restored);
    expect(() => assertProposalAnalysisProvenance(restored)).not.toThrow(); expect(copied.analysisProvenance).toEqual(proposal.analysisProvenance); expect(revision.analysisProvenance).toEqual(proposal.analysisProvenance);
    copied.introduction = 'Ручная последующая правка'; expect(proposal.analysisProvenance!.parts[0].raw).toBe(copied.analysisProvenance!.parts[0].raw);
    expect(copied.status).toBe('draft'); expect(revision.status).toBe('draft'); expect(copied.sourceFinancials?.decision).toBeUndefined();
  });
  it('rejects over-budget or extra private keys instead of trimming a historical record', () => {
    const proposal = data(), extra = { ...receipt(), endpoint: 'https://not-stored.invalid', apiKey: 'not-stored' };
    Object.assign(proposal, { analysisProvenance: extra }); expect(() => assertProposalAnalysisProvenance(proposal)).toThrow(/Журнал/); expect(proposal.analysisProvenance).toEqual(extra);
    proposal.analysisProvenance = receipt(); proposal.analysisProvenance.parts[0].raw = 'x'.repeat(2 * 1024 * 1024 + 1);
    expect(() => assertProposalAnalysisProvenance(proposal)).toThrow(/Журнал/); expect(proposal.analysisProvenance.parts[0].raw).toHaveLength(2 * 1024 * 1024 + 1);
  });
});
