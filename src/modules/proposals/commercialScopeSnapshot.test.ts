import { describe, expect, it } from 'vitest';
import { createProposal, createProposalLine } from './defaults';
import type { CommercialBlock, CommercialSectionKind } from './commercialDocument';
import { hasFreshCommercialScopeSnapshot } from './commercialScopeSnapshot';
import type { ProposalData } from './types';

function fixture(): ProposalData {
  const data = createProposal(new Date(2035, 0, 1)), quote = 'Проверить систему и подготовить отчёт.';
  data.title = 'КП по проверке системы';
  data.lines = [{ ...createProposalLine(), title: 'Услуги по проверке системы', description: 'Исходный полный состав. '.repeat(100) }];
  data.commercialDocument = {
    version: 1, revision: 1,
    body: { version: 1, sections: [{ id: 'scope', kind: 'scope', title: 'Состав', blocks: [{ id: 'scope-block', kind: 'paragraph', style: 'body', content: [{ kind: 'text', text: quote }] }] }] },
    privateAppendix: {
      version: 1, sourceSnapshotKey: `sha256:${'a'.repeat(64)}`, documentId: 'source-document', extraction: { complete: true, requiresOcr: false, visualAssessment: 'unassessed' },
      containers: [{ id: 'contract', sourceId: 'source', kind: 'contract', heading: 'Договор оказания услуг' }],
      clauses: [{ id: 'clause', containerId: 'contract', sourceId: 'source', sourceName: 'Договор', locator: 'Раздел 1', quote, quoteHash: `sha256:${'b'.repeat(64)}`, roles: ['scope'], classification: 'commercial' }],
      references: [], coverage: [{ sourceClauseId: 'clause', kind: 'literal', targetBlockIds: ['scope-block'] }],
    }, questions: [], decisions: [],
  };
  data.commercialScopeSnapshot = { version: 1, lineId: data.lines[0].id, title: data.lines[0].title, description: data.lines[0].description, sourceSnapshotKey: data.commercialDocument.privateAppendix.sourceSnapshotKey, documentId: data.commercialDocument.privateAppendix.documentId };
  return data;
}
const sortedRoundTrip = <T,>(value: T): T => JSON.parse(JSON.stringify(value, (_key, part: unknown) => part && typeof part === 'object' && !Array.isArray(part)
  ? Object.fromEntries(Object.entries(part).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : part)) as T;
const putReceipt = (data: ProposalData, value: unknown) => Object.assign(data, { commercialScopeSnapshot: value });

describe('fresh inherited commercial scope snapshot', () => {
  it('accepts only the exact private receipt without mutation or price approval', () => {
    const data = fixture(), before = structuredClone(data);
    expect(hasFreshCommercialScopeSnapshot(data)).toBe(true);
    expect(data.sourceFinancials).toBeUndefined(); expect(data).toEqual(before);
    // The helper does not impose the separate presentation-only 2000 limit.
    data.lines[0].description = 'Краткий исходный состав'; data.commercialScopeSnapshot!.description = data.lines[0].description;
    expect(hasFreshCommercialScopeSnapshot(data)).toBe(true);
  });
  it('keeps ordinary goods, manual and candidate-only descriptions visible without a receipt', () => {
    const data = fixture(); delete data.commercialScopeSnapshot;
    data.lines[0] = { ...data.lines[0], title: 'Сервер', unit: 'шт', quantity: '2', description: 'UNIQUE-SPECIFICATION '.repeat(150) };
    const before = structuredClone(data);
    expect(hasFreshCommercialScopeSnapshot(data)).toBe(false); expect(data).toEqual(before);
    data.sourceFinancials = { version: 1, candidates: [{ id: 'price', sourceId: 'source', sourceName: 'Договор', locator: 'Раздел 3', quote: 'Стоимость услуг 122 рубля.', sourceKind: 'contract', scope: 'aggregate', currency: 'RUB', gross: '122', tax: { kind: 'unknown' }, issues: [] }] };
    for (const decision of [undefined, { kind: 'not-used' as const, fingerprint: 'not-a-scope-receipt' }, { kind: 'applied' as const, candidateId: 'price', fingerprint: 'not-a-scope-receipt' }]) {
      data.sourceFinancials.decision = decision; expect(hasFreshCommercialScopeSnapshot(data)).toBe(false);
    }
    expect(data.lines[0].description).toBe(before.lines[0].description);
  });
  it('does not make genuine body ownership depend on using the source price', () => {
    const data = fixture(); data.lines[0].unitPrice = '500'; data.lines[0].tax = { kind: 'vat', rate: 22 };
    data.sourceFinancials = { version: 1, candidates: [], decision: { kind: 'not-used', fingerprint: 'price-validation-is-independent' } };
    expect(hasFreshCommercialScopeSnapshot(data)).toBe(true);
    delete data.sourceFinancials; expect(hasFreshCommercialScopeSnapshot(data)).toBe(true);
  });
  it('requires byte-exact line identity, title and description and a single current line', () => {
    for (const edit of [(data: ProposalData) => { data.lines[0].id += '-new'; }, (data: ProposalData) => { data.lines[0].title += ' '; }, (data: ProposalData) => { data.lines[0].description += '\n'; }, (data: ProposalData) => { data.lines = []; }, (data: ProposalData) => { data.lines.push(createProposalLine()); }]) {
      const data = fixture(); edit(data); const before = structuredClone(data);
      expect(hasFreshCommercialScopeSnapshot(data)).toBe(false); expect(data).toEqual(before);
    }
  });
  it('rejects stale document/source identity and absent or corrupt working bodies', () => {
    for (const edit of [(data: ProposalData) => { data.commercialDocument!.privateAppendix.documentId = 'another-document'; }, (data: ProposalData) => { data.commercialDocument!.privateAppendix.sourceSnapshotKey = `sha256:${'c'.repeat(64)}`; }, (data: ProposalData) => { delete data.commercialDocument; }, (data: ProposalData) => { data.commercialDocument!.body.sections[0].blocks[0].id = 'broken-coverage'; }]) {
      const data = fixture(); edit(data); expect(hasFreshCommercialScopeSnapshot(data)).toBe(false);
    }
  });
  it('requires a named contract container with its own nonempty source clause', () => {
    for (const edit of [(data: ProposalData) => { data.commercialDocument!.privateAppendix.containers[0].kind = 'appendix'; }, (data: ProposalData) => { data.commercialDocument!.privateAppendix.containers[0].heading = ' \n'; }, (data: ProposalData) => { data.commercialDocument!.privateAppendix.containers[0].sourceId = ''; }, (data: ProposalData) => { data.commercialDocument!.privateAppendix.clauses[0].sourceId = 'other-source'; }, (data: ProposalData) => { data.commercialDocument!.privateAppendix.clauses[0].quote = ' '; }, (data: ProposalData) => { data.commercialDocument!.privateAppendix.clauses = []; data.commercialDocument!.privateAppendix.coverage = []; }]) {
      const data = fixture(); edit(data); expect(hasFreshCommercialScopeSnapshot(data)).toBe(false);
    }
  });
  it('permits current body edits, revision and private review metadata without making the cached description a second owner', () => {
    const data = fixture(); data.commercialDocument!.revision += 1;
    data.commercialDocument!.privateAppendix.extraction.visualAssessment = 'reviewed-by-user';
    const block = data.commercialDocument!.body.sections[0].blocks[0]; if (block.kind !== 'paragraph') throw new Error('fixture');
    block.content = [{ kind: 'text', text: 'Текущая отдельная редакция состава, проверяемая общим gate.' }];
    expect(hasFreshCommercialScopeSnapshot(data)).toBe(true);
  });
  it.each(['scope', 'perimeter', 'deliverables'] as CommercialSectionKind[])('accepts substantive %s content, not an unrelated section', (kind) => {
    const data = fixture(); data.commercialDocument!.body.sections[0].kind = kind;
    expect(hasFreshCommercialScopeSnapshot(data)).toBe(true);
    data.commercialDocument!.body.sections[0].kind = 'other'; expect(hasFreshCommercialScopeSnapshot(data)).toBe(false);
  });
  it.each([
    { id: 'scope-block', kind: 'paragraph', style: 'body', content: [{ kind: 'text', text: ' \n' }] },
    { id: 'scope-block', kind: 'list', style: 'bullet', items: [[]] },
    { id: 'scope-block', kind: 'table', columns: ['Название'], rows: [] },
    { id: 'scope-block', kind: 'table', columns: ['Название'], rows: [[[{ kind: 'text', text: ' ' }]]] },
  ] as CommercialBlock[])('does not treat an empty block as replacement scope $kind', (block) => {
    const data = fixture(); data.commercialDocument!.body.sections[0].blocks = [block]; expect(hasFreshCommercialScopeSnapshot(data)).toBe(false);
  });
  it.each([
    { id: 'scope-block', kind: 'list', style: 'ordered', items: [[{ kind: 'text', text: 'Измеримый результат' }]] },
    { id: 'scope-block', kind: 'table', columns: ['Название'], rows: [[[{ kind: 'text', text: 'Измеримый результат' }]]] },
  ] as CommercialBlock[])('recognizes full-width list/table scope without changing it $kind', (block) => {
    const data = fixture(); data.commercialDocument!.body.sections[0].blocks = [block]; const before = structuredClone(data);
    expect(hasFreshCommercialScopeSnapshot(data)).toBe(true); expect(data).toEqual(before);
  });
  it('validates a closed receipt shape and does not throw or leak on damaged persisted input', () => {
    const base = fixture(), receipt = base.commercialScopeSnapshot!;
    for (const malformed of [null, false, [], {}, { ...receipt, version: 2 }, { ...receipt, unknown: 'PRIVATE' }, { ...receipt, lineId: 'a'.repeat(129) }, { ...receipt, lineId: '../line' }, { ...receipt, documentId: '' }, { ...receipt, sourceSnapshotKey: 'unbound' }, { ...receipt, title: 'a\u0085b' }, { ...receipt, description: '\ud800' }, { ...receipt, description: 'x'.repeat(20_001) }, new Date()]) {
      const data = structuredClone(base); putReceipt(data, malformed); expect(() => hasFreshCommercialScopeSnapshot(data)).not.toThrow(); expect(hasFreshCommercialScopeSnapshot(data)).toBe(false);
    }
    const cyclic = fixture(); Object.assign(cyclic.commercialDocument!, { body: cyclic.commercialDocument }); expect(hasFreshCommercialScopeSnapshot(cyclic)).toBe(false);
  });
  it('counts text codepoints without normalization and survives recursively sorted storage keys', () => {
    const data = fixture(); data.lines[0].description = '😀'.repeat(20_000); data.commercialScopeSnapshot!.description = data.lines[0].description;
    expect(hasFreshCommercialScopeSnapshot(data)).toBe(true);
    const reopened = sortedRoundTrip(data); expect(Object.keys(reopened.commercialScopeSnapshot!)).not.toEqual(Object.keys(data.commercialScopeSnapshot!));
    expect(hasFreshCommercialScopeSnapshot(reopened)).toBe(true);
    reopened.lines[0].description += '😀'; reopened.commercialScopeSnapshot!.description = reopened.lines[0].description;
    expect(hasFreshCommercialScopeSnapshot(reopened)).toBe(false);
  });
});
