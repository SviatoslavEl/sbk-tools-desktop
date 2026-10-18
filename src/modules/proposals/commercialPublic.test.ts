import { describe, expect, it } from "vitest";
import type { CommercialBody, CommercialIssue, CommercialTermQuestion, CommercialTermQuestionKind } from "./commercialDocument";
import type { CommercialReadiness } from "./commercialDecisions";
import { projectCommercialBodyPublic, projectCommercialReviewPublic, publicCommercialIssueMessage } from "./commercialPublic";

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

describe('actionable public review cautions without private question diagnostics', () => {
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
