import { describe, expect, it } from 'vitest';
import { createProposal, createProposalLine } from './defaults';
import { buildProposalDocumentPublic, buildProposalPublic } from './exportPublic';
import { commercialFingerprint, commercialQuestionSourceFingerprint } from './commercialDocument';
import { assertPublicDocumentBudget, type ProposalPublicDocumentV2 } from './commercialPublic';
import type { ProposalData } from './types';

async function fixture(): Promise<ProposalData> {
  const data = createProposal(new Date(2035, 0, 1)), quote = 'Проверка по предоставленным материалам.';
  data.title = 'Проверка системы'; data.issuer.name = 'Исполнитель'; data.recipient.name = 'Заказчик';
  data.lines = [{ ...createProposalLine(), title: 'Проверка', unitPrice: '100' }];
  data.introduction = 'PRIVATE-INACTIVE-INTRO'; data.deliveryTerms = 'PRIVATE-INACTIVE-DELIVERY'; data.paymentTerms = 'PRIVATE-INACTIVE-PAYMENT'; data.conclusion = 'PRIVATE-INACTIVE-CONCLUSION'; data.internalNote = 'PRIVATE-INTERNAL-NOTE';
  data.sourceQuestions = [{ id: 'old-question', message: 'PRIVATE-LEGACY-QUESTION', evidence: [] }];
  data.commercialDocument = {
    version: 1, revision: 1, body: { version: 1, sections: [{ id: 'private-scope-section', kind: 'scope', title: 'Состав работ', blocks: [{ id: 'private-scope-block', kind: 'paragraph', style: 'body', content: [{ kind: 'text', text: quote }] }] }] },
    privateAppendix: { version: 1, sourceSnapshotKey: await commercialFingerprint('PRIVATE-source-snapshot'), documentId: 'PRIVATE-document', extraction: { complete: true, requiresOcr: false, visualAssessment: 'unassessed' }, containers: [{ id: 'private-container', sourceId: 'private-source', kind: 'contract', heading: 'PRIVATE-contract' }], clauses: [{ id: 'private-clause', containerId: 'private-container', sourceId: 'private-source', sourceName: 'PRIVATE-source-name', locator: 'PRIVATE-locator', quote, quoteHash: await commercialFingerprint(quote), roles: ['scope'], classification: 'commercial' }], references: [], coverage: [{ sourceClauseId: 'private-clause', kind: 'literal', targetBlockIds: ['private-scope-block'] }] },
    questions: [], decisions: [],
  };
  return data;
}
const v2 = (value: Awaited<ReturnType<typeof buildProposalDocumentPublic>>) => { expect(value.schemaVersion).toBe(2); return value as ProposalPublicDocumentV2; };

describe('structured public document dispatch', () => {
  it('keeps the V1 route intact and prevents a V2 working body from silently becoming old flat terms', async () => {
    const data = await fixture(); expect(() => buildProposalPublic(data)).toThrow(/структурированном документе/);
    delete data.commercialDocument;
    expect(await buildProposalDocumentPublic(data)).toEqual(buildProposalPublic(data));
  });
  it('exports an explicitly marked review draft with current text, public ordinals and honest visual warning', async () => {
    const data = await fixture(), before = structuredClone(data), output = v2(await buildProposalDocumentPublic(data));
    expect(output.commercial.mode).toBe('review-draft'); expect(output.commercial.sections[0]).toMatchObject({ anchor: 's1', title: 'Состав работ', blocks: [{ anchor: 's1b1' }] });
    expect(output.commercial.sections[output.commercial.sections.length - 1]?.title).toBe('Вопросы для проверки');
    expect(output.commercial.unresolved.some((entry) => /Визуальная полнота/.test(entry.message))).toBe(true);
    expect(output).not.toHaveProperty('terms'); expect(JSON.stringify(output)).not.toMatch(/PRIVATE-|private-|quoteHash|sourceSnapshotKey|sourceQuestions|sourceCoverageBefore|decisions/);
    expect(data).toEqual(before);
  });
  it('does not call a saved or text-complete proposal final while review remains unresolved', async () => {
    const data = await fixture(); data.status = 'ready';
    await expect(buildProposalDocumentPublic(data, { mode: 'final' })).rejects.toThrow(/Визуальная полнота/);
    const complete = structuredClone(data); complete.commercialDocument!.privateAppendix.extraction.visualAssessment = 'reviewed-by-user';
    expect(v2(await buildProposalDocumentPublic(complete, { mode: 'final' })).commercial).toMatchObject({ mode: 'final', unresolved: [] });
  });
  it('places unresolved concrete questions beside their own section, not by repeated title or source ID', async () => {
    const data = await fixture(), doc = data.commercialDocument!;
    doc.body.sections.push({ id: 'payment-section', kind: 'payment', title: 'Состав работ', blocks: [{ id: 'payment-block', kind: 'paragraph', style: 'body', content: [{ kind: 'text', text: 'Аванс перечисляется в течение 5 дней.' }] }] });
    const identity = { kind: 'advance-days' as const, sourceClauseIds: ['private-clause'], sourceReferenceIds: [] };
    doc.questions.push({ ...identity, id: 'days-question', sectionId: 'payment-section', targetBlockIds: ['payment-block'], message: 'Уточните вид дней для аванса.', material: true, dependencyFingerprint: await commercialQuestionSourceFingerprint(doc.privateAppendix, identity) });
    const output = v2(await buildProposalDocumentPublic(data));
    expect(output.commercial.unresolved).toContainEqual({ section: 's2', message: 'Вопрос 1. Уточните, календарные или рабочие дни применяются к сроку аванса. Пункт 2.1.' });
    expect(output.commercial.sections.map((section) => section.title).filter((title) => title === 'Состав работ')).toHaveLength(2);
  });
  it('does not export corrupted private provenance even as a review draft', async () => {
    const data = await fixture(); data.commercialDocument!.privateAppendix.clauses[0].quote += ' Изменённый источник';
    await expect(buildProposalDocumentPublic(data)).rejects.toThrow();
  });
  it.each([null, false, {}, { version: 999 }])('does not substitute V1 flat fields for a present invalid document %j', async (invalid) => {
    const data = await fixture(); Object.assign(data, { commercialDocument: invalid });
    await expect(buildProposalDocumentPublic(data)).rejects.toThrow(); expect(() => buildProposalPublic(data)).toThrow();
  });
  it('takes one immutable snapshot before asynchronous readiness checks', async () => {
    const data = await fixture(), pending = buildProposalDocumentPublic(data), block = data.commercialDocument!.body.sections[0].blocks[0];
    if (block.kind === 'paragraph') block.content = [{ kind: 'text', text: 'Поздняя правка' }];
    data.recipient.name = 'Другой заказчик'; const output = v2(await pending);
    expect(JSON.stringify(output)).not.toContain('Поздняя правка'); expect(output.recipient.name).toBe('Заказчик');
  });
  it('never copies private dependency IDs or diagnostic prose into review files', async () => {
    const data = await fixture(), doc = data.commercialDocument!;
    for (const kind of ['stage-plan', 'stage-parallelism'] as const) {
      const identity = { kind, sourceClauseIds: ['private-clause'], sourceReferenceIds: [] };
      doc.questions.push({ ...identity, id: `PRIVATE-${kind}-ID`, sectionId: 'private-scope-section', targetBlockIds: ['private-scope-block'], message: 'PRIVATE-QUESTION-MESSAGE', material: true, dependencyFingerprint: await commercialQuestionSourceFingerprint(doc.privateAppendix, identity) });
    }
    const output = v2(await buildProposalDocumentPublic(data));
    expect(output.commercial.unresolved.length).toBeGreaterThan(0);
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE-|private-|question-stage|sha256:|sourceSnapshotKey/);
    expect(output.commercial.unresolved.some((entry) => /параллельность/.test(entry.message))).toBe(true);
  });
  it('keeps optional unanswered questions private in final output rather than producing an invalid final DTO', async () => {
    const data = await fixture(), doc = data.commercialDocument!;
    doc.privateAppendix.extraction.visualAssessment = 'reviewed-by-user';
    const identity = { kind: 'advance-days' as const, sourceClauseIds: ['private-clause'], sourceReferenceIds: [] };
    doc.questions.push({ ...identity, id: 'optional-days', sectionId: 'private-scope-section', targetBlockIds: ['private-scope-block'], message: 'Необязательное уточнение', material: false, dependencyFingerprint: await commercialQuestionSourceFingerprint(doc.privateAppendix, identity) });
    const output = v2(await buildProposalDocumentPublic(data, { mode: 'final' })); expect(output.commercial.unresolved).toEqual([]);
    expect(data.commercialDocument!.questions).toHaveLength(1);
  });
  it('enforces the whole DTO limit including valid metadata, not only its body', async () => {
    const data = await fixture(), doc = data.commercialDocument!;
    for (let index = 0; index < 350; index++) doc.body.sections[0].blocks.push({ id: `b-${index}`, kind: 'paragraph', style: 'body', content: [{ kind: 'text', text: 'a'.repeat(20000) }] });
    data.attachments = Array.from({ length: 80 }, (_, index) => ({ fileName: 'b'.repeat(20000), relativePath: `attachments/${index}`, sizeBytes: 1, sha256: 'a'.repeat(64), mimeType: 'application/pdf' }));
    await expect(buildProposalDocumentPublic(data)).rejects.toThrow(/8 МБ/);
  });
});

describe('public wire byte budget', () => {
  it('counts UTF-8 and escaped JSON strings including metadata', () => {
    const body = { text: 'я'.repeat(4_180_000) };
    expect(() => assertPublicDocumentBudget(body)).not.toThrow();
    expect(() => assertPublicDocumentBudget({ ...body, footer: '\\'.repeat(20000) })).toThrow(/8 МБ/);
  });
  it('rejects cycles or excessive nesting without expanding them', () => {
    const cycle: unknown[] = []; cycle.push(cycle); expect(() => assertPublicDocumentBudget(cycle)).toThrow(/Циклическая/);
    let nested: unknown = 'x'; for (let index = 0; index < 40; index++) nested = [nested];
    expect(() => assertPublicDocumentBudget(nested)).toThrow(/глубокая/);
  });
});
