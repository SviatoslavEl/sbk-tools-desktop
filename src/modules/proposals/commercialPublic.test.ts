import { describe, expect, it } from "vitest";
import type { CommercialBody, CommercialIssue, CommercialPrivateAppendix, CommercialSourceClause, CommercialTermQuestion, CommercialTermQuestionKind } from "./commercialDocument";
import type { CommercialReadiness } from "./commercialDecisions";
import { projectCommercialBodyPublic, projectCommercialReviewPublic, publicCommercialIssueMessage } from "./commercialPublic";
import { collectCommercialReferences, prepareCommercialDocument } from "./commercialPreparation";
import { taskSourceSnapshotKey } from "../intelligence/taskSourceIdentity";
import { createProposal, createProposalLine } from "./defaults";
import { buildProposalDocumentPublic } from "./exportPublic";

function fixture(): CommercialBody {
  return { version: 1, sections: [
    { id: "private-scope-uuid", kind: "scope", title: "Состав работ", blocks: [
      { id: "private-scope-block", kind: "paragraph", style: "body", content: [{ kind: "text", text: "Состав работ полностью сохраняется. См. " }, { kind: "local-ref", targetId: "private-delivery-block" }] },
      { id: "private-list", kind: "list", style: "bullet", items: [[{ kind: "text", text: "При наличии доступа; без разрушительного тестирования." }], [{ kind: "local-ref", targetId: "private-delivery-uuid" }]] },
    ] },
    { id: "private-delivery-uuid", kind: "deliverables", title: "Результаты", blocks: [
      { id: "private-delivery-block", kind: "table", columns: ["Результат", "Формат"], rows: [[[ { kind: "text", text: "Отчёт" } ], [ { kind: "text", text: "DOCX и PDF" } ]]] },
    ] },
  ] };
}

describe("commercial public body projection", () => {
  it("renumbers section/block references without copying private identifiers", () => {
    const output = projectCommercialBodyPublic(fixture());
    expect(output.sections.map((section) => section.anchor)).toEqual(["s1", "s2"]);
    expect(output.sections.flatMap((section) => section.blocks.map((block) => block.anchor))).toEqual(["s1b1", "s1b2", "s2b1"]);
    expect(output.sections[0].blocks[0]).toMatchObject({ content: [{ kind: "text" }, { kind: "local-ref", target: "s2b1" }] });
    expect(output.sections[0].blocks[1]).toMatchObject({ items: [[{ kind: "text" }], [{ kind: "local-ref", target: "s2" }]] });
    expect(JSON.stringify(output.sections)).not.toMatch(/private-|targetId|sourceId|fragmentId|quoteHash|decision/);
    expect(output.anchors.get("private-delivery-block")).toBe("s2b1");
  });

  it("does not make title text an identity and allows identical headings", () => {
    const body = fixture(); body.sections[1].title = body.sections[0].title;
    const output = projectCommercialBodyPublic(body);
    expect(output.sections.map((section) => section.title)).toEqual(["Состав работ", "Состав работ"]);
    expect(output.sections[1].anchor).toBe("s2");
  });

  it("makes independent nested arrays, preserving literal Unicode and source data", () => {
    const body = fixture(), before = structuredClone(body), output = projectCommercialBodyPublic(body);
    const table = output.sections[1].blocks[0];
    if (table.kind !== "table" || table.rows[0][0][0].kind !== "text") throw new Error("fixture");
    table.rows[0][0][0].text = "Изменение результата"; table.columns[0] = "Другой заголовок";
    expect(body).toEqual(before);
  });

  it.each(["missing", "private-delivery-uuid-deleted"])("rejects a dangling private target %s", (targetId) => {
    const body = fixture(), block = body.sections[0].blocks[0];
    if (block.kind !== "paragraph") throw new Error("fixture");
    block.content.push({ kind: "local-ref", targetId });
    expect(() => projectCommercialBodyPublic(body)).toThrow(/ссылк/);
  });

  it("never exports an empty body or silently substitutes a generated paragraph", () => {
    expect(() => projectCommercialBodyPublic({ version: 1, sections: [] })).toThrow(/Пустой/);
    expect(() => projectCommercialBodyPublic({ version: 1, sections: [{ id: "empty", kind: "scope", title: "Состав", blocks: [] }] })).toThrow(/Пустой/);
  });

  it("does not accept unknown rich-text/code fields", () => {
    const body = fixture(); Object.assign(body.sections[0].blocks[0], { html: "<script>private()</script>" });
    expect(() => projectCommercialBodyPublic(body)).toThrow(/Разрешены только/);
  });
});

const fingerprint = `sha256:${"a".repeat(64)}` as const;
function question(id: string, target = 'private-scope-block', kind: CommercialTermQuestionKind = 'source-reference'): CommercialTermQuestion {
  return { id, kind, sectionId: target === 'private-delivery-block' ? 'private-delivery-uuid' : 'private-scope-uuid', targetBlockIds: [target],
    sourceClauseIds: ['PRIVATE-clause'], sourceReferenceIds: [`PRIVATE-reference-${id}`], message: 'PRIVATE-question-message /Users/private/sha256:secret', material: true, dependencyFingerprint: fingerprint };
}
function readiness(questions: CommercialTermQuestion[], issues: CommercialIssue[] = []): CommercialReadiness {
  return { canSaveDraft: true, canFinalize: false, questions: questions.map(question => ({ question, sourceCurrent: true, dependencyFingerprint: fingerprint, status: 'unresolved', issues: [] })),
    issues, activeDecisionIds: [], staleDecisionIds: [] };
}
function issue(code: string, path: string, sectionId?: string): CommercialIssue {
  return { code, path, message: 'PRIVATE-diagnostic /tmp/internal-source question-stage sha256:secret', severity: 'review', ...(sectionId ? { sectionId } : {}) };
}

function contextClause(id: string, quote: string, containerId = 'PRIVATE-contract'): CommercialSourceClause {
  const printedLabel = /^\s*(\d+(?:\.\d+)*)(?:[.)]|\s)/u.exec(quote)?.[1];
  return { id, containerId, sourceId: 'PRIVATE-source', sourceName: '/Users/PRIVATE/source.docx', locator: 'PRIVATE-locator', quote, quoteHash: fingerprint,
    roles: [], classification: 'commercial', ...(printedLabel ? { printedLabel } : {}) };
}
function contextAppendix(clauses: CommercialSourceClause[]): CommercialPrivateAppendix {
  const appendix: CommercialPrivateAppendix = { version: 1, sourceSnapshotKey: fingerprint, documentId: 'PRIVATE-document', extraction: { complete: true, requiresOcr: false, visualAssessment: 'unassessed' },
    containers: [{ id: 'PRIVATE-contract', sourceId: 'PRIVATE-source', kind: 'contract', heading: 'PRIVATE-heading /tmp/source' }, { id: 'PRIVATE-task', sourceId: 'PRIVATE-source', parentId: 'PRIVATE-contract', kind: 'technical-task', heading: 'PRIVATE-heading sha256:secret' }],
    clauses: [contextClause('clause-PRIVATE-contract-heading', 'Договор'), contextClause('clause-PRIVATE-subject-heading', '1. Предмет договора'), contextClause('clause-PRIVATE-subject', '1.1. Исполнитель оказывает комплекс услуг по проверке учебной системы.'),
      ...clauses.filter(clause => clause.containerId === 'PRIVATE-contract'), contextClause('clause-PRIVATE-appendix', 'Приложение № 1'), contextClause('clause-PRIVATE-parent', 'к Договору'), contextClause('clause-PRIVATE-task-heading', 'Техническое задание № 1', 'PRIVATE-task'), ...clauses.filter(clause => clause.containerId === 'PRIVATE-task')], references: [], coverage: [] };
  appendix.references = collectCommercialReferences(appendix.clauses, appendix.containers);
  return appendix;
}
function priceContext() {
  const price = contextClause('clause-PRIVATE-price', '3.1. Стоимость услуг 1000,00 рублей без НДС. PRIVATE-price-quote.'), owner = contextClause('clause-PRIVATE-payment', '3.2. Аванс от суммы, указанной в п. 3.1 Договора. PRIVATE-owner-quote.');
  price.classification = 'financial'; const appendix = contextAppendix([contextClause('clause-PRIVATE-price-heading', '3. Стоимость услуг и порядок расчётов'), price, owner]);
  appendix.coverage = [{ sourceClauseId: price.id, kind: 'external-field', field: 'pricing' }];
  const q = question('PRIVATE-price-question'); q.sourceClauseIds = [owner.id]; q.sourceReferenceIds = appendix.references.filter(reference => reference.sourceClauseId === owner.id && reference.kind === 'clause').map(reference => reference.id);
  return { appendix, q, price, owner };
}

describe('actionable public review cautions without private question diagnostics', () => {
  it('distinguishes four same-caption governing-document groups only by safe kinds, reference counts and public targets', () => {
    const groups = [
      { container: 'PRIVATE-contract', word: 'ТЗ', count: 5, origin: 'исходный договор', target: 'исходного ТЗ' },
      { container: 'PRIVATE-contract', word: 'Договора', count: 30, origin: 'исходный договор', target: 'исходного договора' },
      { container: 'PRIVATE-task', word: 'Договора', count: 10, origin: 'исходное ТЗ', target: 'исходного договора' },
      { container: 'PRIVATE-task', word: 'ТЗ', count: 7, origin: 'исходное ТЗ', target: 'исходного ТЗ' },
    ];
    const clauses = groups.map((group, index) => contextClause(`clause-PRIVATE-group-${index}`, `PRIVATE-quote /tmp/private ${`после подписания ${group.word}; `.repeat(group.count)}`, group.container)), appendix = contextAppendix(clauses);
    const questions = groups.map((_group, index) => { const q = question(`PRIVATE-group-question-${index}`, index === 3 ? 'private-delivery-block' : 'private-scope-block'); q.message = 'PRIVATE-identical-caption'; q.sourceClauseIds = [clauses[index].id]; q.sourceReferenceIds = appendix.references.filter(reference => reference.sourceClauseId === clauses[index].id).map(reference => reference.id); return q; });
    for (let index = 4; index < 12; index++) questions.push(question(`PRIVATE-other-question-${index}`, 'private-list', 'stage-plan'));
    const input = readiness(questions), before = structuredClone({ input, appendix }), projection = projectCommercialBodyPublic(fixture());
    const without = projectCommercialReviewPublic(input, projection, 'review-draft'), output = projectCommercialReviewPublic(input, projection, 'review-draft', appendix);
    expect(output.unresolved).toHaveLength(12); expect(output.sections).toEqual(without.sections);
    for (const [index, group] of groups.entries()) {
      expect(output.unresolved[index].message).toContain(`Ссылок в вопросе: ${group.count}.`);
      expect(output.unresolved[index].message).toContain(`Источник: ${group.origin}; ссылка на документ или связанное событие ${group.target}.`);
      expect(output.unresolved[index].message).toContain('ещё нужно согласовать');
      expect(output.unresolved[index].message).toContain(index === 3 ? 'Пункт 2.1.' : 'Пункт 1.1.');
    }
    expect(new Set(output.unresolved.slice(0, 4).map(entry => entry.message)).size).toBe(4);
    expect(output.unresolved.slice(4)).toEqual(without.unresolved.slice(4));
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE|private-|sha256:|\/Users\/|\/tmp\/|quoteHash|sourceClauseIds|sourceReferenceIds/);
    expect({ input, appendix }).toEqual(before); expect(input.canFinalize).toBe(false); expect(input.activeDecisionIds).toEqual([]);
  });

  it('names original financial point 3.1 without resolving it or anchoring the current proposal price', () => {
    const { appendix, q } = priceContext(), input = readiness([q]), before = structuredClone({ appendix, input });
    const output = projectCommercialReviewPublic(input, projectCommercialBodyPublic(fixture()), 'review-draft', appendix);
    expect(output.unresolved).toHaveLength(1);
    expect(output.unresolved[0].message).toContain('Пункт 3.1 исходного договора, не пункт этого КП; связан с исходной ценой, применимость нужно согласовать.');
    expect(output.unresolved[0].message).toContain('Пункт 1.1.'); expect(output.unresolved[0].message).toContain('Ссылок в вопросе: 1.');
    expect(JSON.stringify(output)).not.toMatch(/1000|PRIVATE|private-|sha256|\/Users|НДС|net|gross/);
    expect({ appendix, input }).toEqual(before); expect(input.questions[0].status).toBe('unresolved'); expect(input.activeDecisionIds).toEqual([]); expect(input.canFinalize).toBe(false);
  });

  it.each(['printed', 'span', 'scope', 'candidate-label', 'ownership', 'duplicate-id'] as const)('falls back to one generic caution for %s source context instead of copying private metadata', (variant) => {
    const { appendix, q, price } = priceContext(), reference = appendix.references.find(reference => reference.id === q.sourceReferenceIds[0])!;
    if (variant === 'printed') reference.printed = '3.1 PRIVATE /tmp/secret';
    else if (variant === 'span') reference.span.startUtf16++;
    else if (variant === 'scope') reference.scopeHint = 'technical-task';
    else if (variant === 'candidate-label') price.printedLabel = 'PRIVATE-price-label';
    else if (variant === 'ownership') q.sourceClauseIds = [price.id];
    else appendix.references.push(structuredClone(reference));
    const output = projectCommercialReviewPublic(readiness([q]), projectCommercialBodyPublic(fixture()), 'review-draft', appendix);
    expect(output.unresolved).toHaveLength(1); expect(output.unresolved[0].message).toContain('Контекст исходного документа не уточнён.');
    expect(output.unresolved[0].message).not.toContain('3.1'); expect(JSON.stringify(output)).not.toMatch(/PRIVATE|sha256|\/tmp|\/Users/);
  });

  it.each(['non-pricing', 'forged-financial-tag', 'ambiguous', 'technical-task', 'unknown'] as const)('never labels %s source context as an accepted original-contract price', (variant) => {
    const { appendix, q, price, owner } = priceContext();
    if (variant === 'non-pricing') appendix.coverage = [{ sourceClauseId: price.id, kind: 'external-field', field: 'parties' }];
    else if (variant === 'forged-financial-tag') price.quote = '3.1. Состав услуг включает анализ документации.';
    else if (variant === 'ambiguous') appendix.clauses.splice(appendix.clauses.indexOf(price) + 1, 0, { ...price, id: 'clause-PRIVATE-duplicate-price' });
    else { price.containerId = owner.containerId = variant === 'technical-task' ? 'PRIVATE-task' : 'PRIVATE-contract'; if (variant === 'unknown') appendix.containers[0].kind = 'unknown'; owner.quote = owner.quote.replace('Договора', variant === 'technical-task' ? 'ТЗ' : ''); }
    appendix.references = collectCommercialReferences(appendix.clauses, appendix.containers); q.sourceReferenceIds = appendix.references.filter(reference => reference.sourceClauseId === owner.id && reference.kind === 'clause').map(reference => reference.id);
    const output = projectCommercialReviewPublic(readiness([q]), projectCommercialBodyPublic(fixture()), 'review-draft', appendix);
    expect(output.unresolved).toHaveLength(1); expect(output.unresolved[0].message).toContain(variant === 'technical-task' || variant === 'unknown' ? 'Контекст исходного документа не уточнён.' : 'Исходная ссылка на пункт 3.1');
    expect(output.unresolved[0].message).not.toContain('связан с исходной ценой');
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE|sha256|1000/);
  });

  it('allows only strict verified numeric labels/ranges and keeps mixed source contexts separate', () => {
    const clauses = [contextClause('clause-PRIVATE-range', 'См. пп. 3.1 — 3.3 Договора. PRIVATE-quote.'), contextClause('clause-PRIVATE-task-range', 'См. п. 4.2 ТЗ.', 'PRIVATE-task')], appendix = contextAppendix(clauses), q = question('PRIVATE-range-question');
    q.sourceClauseIds = clauses.map(clause => clause.id); q.sourceReferenceIds = appendix.references.filter(reference => reference.kind === 'clause').map(reference => reference.id);
    const output = projectCommercialReviewPublic(readiness([q]), projectCommercialBodyPublic(fixture()), 'review-draft', appendix);
    expect(output.unresolved).toHaveLength(1); expect(output.unresolved[0].message).toContain('пункт 3.1–3.3 исходного договора'); expect(output.unresolved[0].message).toContain('пункт 4.2 исходного ТЗ');
    expect(output.unresolved[0].message).toContain('Источник: исходное ТЗ'); expect(output.unresolved[0].message).toContain('Ссылок в вопросе: 2.'); expect(output.unresolved[0].message).not.toContain('связан с исходной ценой');
    clauses[0].quote = 'См. п. 123456789 Договора. PRIVATE-quote.'; appendix.references = collectCommercialReferences(clauses, appendix.containers); q.sourceReferenceIds = appendix.references.filter(reference => reference.kind === 'clause').map(reference => reference.id);
    const rejected = projectCommercialReviewPublic(readiness([q]), projectCommercialBodyPublic(fixture()), 'review-draft', appendix);
    expect(rejected.unresolved).toHaveLength(1); expect(rejected.unresolved[0].message).toContain('Контекст исходного документа не уточнён.'); expect(JSON.stringify(rejected)).not.toMatch(/123456789|PRIVATE/);
  });

  it('passes safe source context through the real public builder without changing source questions, body, prices or final gates', async () => {
    const texts = ['Договор', '1. Предмет договора', '1.1. Исполнитель оказывает комплекс услуг по проверке системы.', '3. Стоимость услуг и порядок расчётов', '3.1. Стоимость услуг 1000,00 рублей без НДС.', '3.2. Заказчик оплачивает аванс 20 процентов от суммы, указанной в п. 3.1 Договора.'];
    const source = { id: 'PRIVATE-source', name: '/Users/PRIVATE/source.docx', text: texts.join('\n'), fragments: texts.map((text, index) => ({ id: `PRIVATE-fragment-${index}`, locator: `PRIVATE-locator-${index}`, text })), coverage: { complete: true, requiresOcr: false } };
    const prepared = await prepareCommercialDocument({ sources: [source], sourceSnapshotKey: await taskSourceSnapshotKey([source]) }), data = createProposal(new Date(2035, 0, 1));
    data.title = 'Проверка системы'; data.issuer.name = 'Исполнитель'; data.recipient.name = 'Заказчик'; data.lines = [{ ...createProposalLine(), title: 'Явно заданная тестовая услуга', unitPrice: '500' }]; data.commercialDocument = prepared.document;
    expect(data.commercialDocument).toBeDefined(); const before = structuredClone(data), output = await buildProposalDocumentPublic(data);
    if (output.schemaVersion !== 2) throw new Error('Expected structured public draft');
    expect(output.commercial.unresolved.some(entry => entry.message.includes('Пункт 3.1 исходного договора, не пункт этого КП; связан с исходной ценой, применимость нужно согласовать.'))).toBe(true);
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE|\/Users\/|sha256:|sourceClauseIds|quoteHash/);
    expect(data).toEqual(before); expect(data.commercialDocument!.decisions).toEqual([]); expect(data.lines[0].unitPrice).toBe('500');
    await expect(buildProposalDocumentPublic(data, { mode: 'final' })).rejects.toThrow();
  });

  it('merges repeated diagnostics into one caution per concrete question, retaining distinct targets and constraints', () => {
    const first = question('PRIVATE-first'), second = question('PRIVATE-second', 'private-delivery-block');
    const input = readiness([first, second], [
      issue('commercial-material-question', `questions.${first.id}`), issue('commercial-decision-target-overlap', `questions.${first.id}`),
      issue('commercial-upstream-unresolved', `questions.${first.id}`), issue('commercial-material-question', `questions.${second.id}`),
      issue('commercial-unresolved-reference', `privateAppendix.references.${first.sourceReferenceIds[0]}`),
    ]), projection = projectCommercialBodyPublic(fixture()), before = structuredClone(input), bodyBefore = structuredClone(projection.sections);
    const output = projectCommercialReviewPublic(input, projection, 'review-draft');
    expect(output.unresolved).toHaveLength(2);
    expect(output.unresolved[0]).toMatchObject({ section: 's1' }); expect(output.unresolved[0].message).toContain('Вопрос 1.');
    expect(output.unresolved[0].message).toContain('Пункт 1.1.'); expect(output.unresolved[1]).toMatchObject({ section: 's2' });
    expect(output.unresolved[1].message).toContain('Вопрос 2.'); expect(output.unresolved[1].message).toContain('Пункт 2.1.');
    expect(output.unresolved[0].message).toContain('Связанные вопросы затрагивают один пункт');
    expect(output.unresolved[0].message).toContain('Сначала согласуйте связанные условия');
    expect(output.unresolved[0].message).toContain('В исходных ссылках остались');
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE-|private-|sha256:|question-stage|\/Users\/|\/tmp\/|Несколько решений/);
    expect(input).toEqual(before); expect(projection.sections).toEqual(bodyBefore);
  });

  it('does not collapse different question identities even if kind, section and targets coincide', () => {
    const questions = [question('PRIVATE-A'), question('PRIVATE-B')], input = readiness(questions);
    const output = projectCommercialReviewPublic(input, projectCommercialBodyPublic(fixture()), 'review-draft');
    expect(output.unresolved).toHaveLength(2);
    expect(output.unresolved[0].message).toContain('Вопрос 1.'); expect(output.unresolved[1].message).toContain('Вопрос 2.');
    expect(questions.map(question => question.id)).toEqual(['PRIVATE-A', 'PRIVATE-B']); expect(input.activeDecisionIds).toEqual([]);
  });

  it('keeps four same-kind source-reference tasks distinct by current public target context', () => {
    const body = fixture(); body.sections[0].blocks.push({ id: 'PRIVATE-third-block', kind: 'paragraph', style: 'caveat', content: [{ kind: 'text', text: 'Другое условие.' }] });
    const targets = ['private-scope-block', 'private-list', 'PRIVATE-third-block', 'private-delivery-block'];
    const questions = targets.map((target, index) => question(`PRIVATE-reference-question-${index}`, target));
    const output = projectCommercialReviewPublic(readiness(questions), projectCommercialBodyPublic(body), 'review-draft');
    expect(output.unresolved).toHaveLength(4);
    for (const [index, target] of ['1.1', '1.2', '1.3', '2.1'].entries()) expect(output.unresolved[index].message).toContain(`Пункт ${target}.`);
    expect(new Set(output.unresolved.map(entry => entry.message)).size).toBe(4);
  });

  it('keeps unknown constraints visibly unresolved without copying private diagnostic prose', () => {
    const q = question('PRIVATE-unknown', 'private-scope-block', 'advance-days');
    const output = projectCommercialReviewPublic(readiness([q], [issue('unrecognized-PRIVATE-code', `questions.${q.id}`)]), projectCommercialBodyPublic(fixture()), 'review-draft');
    expect(output.unresolved).toHaveLength(1); expect(output.unresolved[0].message).toContain('календарные или рабочие дни');
    expect(output.unresolved[0].message).toContain('дополнительные неуточнённые ограничения');
    expect(JSON.stringify(output)).not.toMatch(/PRIVATE|sha256|\/tmp\//);
  });

  it('deduplicates genuinely generic cautions by public section/context but never by repeated section title', () => {
    const body = fixture(); body.sections[1].title = body.sections[0].title;
    const output = projectCommercialReviewPublic(readiness([], [
      issue('commercial-incomplete-material', 'privateAppendix.extraction'), issue('commercial-incomplete-material', 'privateAppendix.extraction'),
      issue('commercial-visual-unresolved', 'privateAppendix.extraction'),
      issue('commercial-source-projection', 'body', 'private-scope-uuid'), issue('commercial-source-projection', 'body', 'private-delivery-uuid'),
    ]), projectCommercialBodyPublic(body), 'review-draft');
    expect(output.sections).toHaveLength(3); expect(output.sections[2]).toMatchObject({ anchor: 's3', title: 'Вопросы для проверки' });
    expect(output.unresolved).toHaveLength(4);
    expect(output.unresolved.filter(entry => /Полнота исходного текста/.test(entry.message))).toHaveLength(1);
    expect(output.unresolved.filter(entry => /Редакция условий/.test(entry.message)).map(entry => entry.section)).toEqual(['s1', 's2']);
  });

  it('never calls overlapping questions applied decisions or weakens final readiness', () => {
    expect(publicCommercialIssueMessage({ code: 'commercial-decision-target-overlap' })).toContain('вопросы');
    expect(publicCommercialIssueMessage({ code: 'commercial-decision-target-overlap' })).not.toContain('решени');
    const input = readiness([question('PRIVATE-optional')]), projection = projectCommercialBodyPublic(fixture());
    expect(() => projectCommercialReviewPublic(input, projection, 'final')).toThrow(/нерешённые/);
    input.questions[0].question.material = false; input.canFinalize = true;
    expect(projectCommercialReviewPublic(input, projection, 'final').unresolved).toEqual([]); expect(input.questions).toHaveLength(1);
    input.issues.push(issue('commercial-visual-unresolved', 'privateAppendix.extraction'));
    expect(() => projectCommercialReviewPublic(input, projection, 'final')).toThrow(/нерешённые/);
  });

  it('rejects missing current targets and section/question budget overflow rather than dropping cautions', () => {
    const projection = projectCommercialBodyPublic(fixture()), q = question('PRIVATE-Q'); q.targetBlockIds = ['PRIVATE-missing'];
    expect(() => projectCommercialReviewPublic(readiness([q]), projection, 'review-draft')).toThrow(/пункт/);
    q.sectionId = 'PRIVATE-missing'; expect(() => projectCommercialReviewPublic(readiness([q]), projection, 'review-draft')).toThrow(/раздел/);
    const full = projectCommercialBodyPublic({ version: 1, sections: Array.from({ length: 64 }, (_, index) => ({ id: `private-section-${index}`, kind: 'other', title: 'Раздел', blocks: [{ id: `private-block-${index}`, kind: 'paragraph', style: 'body', content: [{ kind: 'text', text: 'Условие.' }] }] })) });
    expect(() => projectCommercialReviewPublic(readiness([], [issue('commercial-visual-unresolved', 'privateAppendix.extraction')]), full, 'review-draft')).toThrow(/64/);
    const many = readiness(Array.from({ length: 2001 }, (_, index) => question(`PRIVATE-${index}`)));
    expect(() => projectCommercialReviewPublic(many, projection, 'review-draft')).toThrow(/2000/);
  });
});
