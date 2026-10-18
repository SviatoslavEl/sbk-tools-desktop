import { describe, expect, it } from "vitest";
import { createProposal } from "./defaults";
import { applyTermDecision, currentQuestionState, projectReadiness, validateTermAnswer, type CommercialDecisionContext } from "./commercialDecisions";
import { commercialFingerprint, commercialQuestionSourceFingerprint, validateCommercialDocument, type CommercialBlock, type CommercialClauseCoverage, type CommercialSection, type CommercialTermAnswer, type CommercialTermQuestionKind, type ProposalCommercialDocumentV1 } from "./commercialDocument";
import { prepareCommercialDocument } from "./commercialPreparation";
import { taskSourceSnapshotKey } from "../intelligence/taskSourceIdentity";

const para = (id: string, text: string): CommercialBlock => ({ id, kind: "paragraph", style: "body", content: [{ kind: "text", text }] });
const text = (block: CommercialBlock): string => block.kind === "paragraph" ? block.content.map((part) => part.kind === "text" ? part.text : `[${part.targetId}]`).join("") : block.kind === "table" ? block.rows.map((row) => row.map((cell) => cell.map((part) => part.kind === "text" ? part.text : `[${part.targetId}]`).join("")).join("\t")).join("\n") : block.items.map((item) => item.map((part) => part.kind === "text" ? part.text : `[${part.targetId}]`).join("")).join("\n");
const own = (doc: ProposalCommercialDocumentV1, id: string) => doc.body.sections.flatMap((section) => section.blocks).find((block) => block.id === id)!;
const baseAnswer: CommercialTermAnswer = { kind: "advance-base", base: "net", vatTreatment: "additional" };
const dayAnswer: CommercialTermAnswer = { kind: "advance-days", dayKind: "calendar" };
const stage = (id: string, index: number) => ({ id, title: `Этап ${index}`, scope: index === 2 ? "Пентест согласованного контура" : `Исследование блока ${index}`, result: `Отчёт блока ${index}`, duration: { count: String(index === 1 ? 25 : index === 4 ? 5 : 15), dayKind: "business" as const } });
const planAnswer = (count = 4): Extract<CommercialTermAnswer, { kind: "stage-plan" }> => ({ kind: "stage-plan", stages: Array.from({ length: count }, (_value, index) => stage(`stage-${index + 1}`, index + 1)), maximum: { count: "40", dayKind: "business" } });
const parallelAnswer = (count = 4): Extract<CommercialTermAnswer, { kind: "stage-parallelism" }> => ({ kind: "stage-parallelism", relations: Array.from({ length: count - 1 }, (_value, index) => ({ kind: "after", stageId: `stage-${index + 2}`, afterStageId: `stage-${index + 1}` })) });
const protocolAnswer: Extract<CommercialTermAnswer, { kind: "boundary-protocol" }> = { kind: "boundary-protocol", milestones: [{ title: "Протокол границ и разрешения", condition: "Границы согласованы, письменное разрешение получено", beforeStageIds: ["stage-2"], afterStageIds: ["stage-1"] }] };
function context(price = "100000"): CommercialDecisionContext {
  const proposal = createProposal(); proposal.lines[0].unitPrice = price; proposal.lines[0].priceBasis = "net"; proposal.lines[0].tax = { kind: "vat", rate: 20 };
  return { pricing: { lines: proposal.lines, currency: "RUB" } };
}
async function fixture(): Promise<ProposalCommercialDocumentV1> {
  const advance = "3.2. Аванс 30 процентов от суммы пункта 3.1 Договора, кроме того НДС, в течение 5 дней после подписания Договора.", split = advance.indexOf("в течение");
  const summary = "4.1. Услуги оказываются в пять последовательных этапов.", parallel = "Этапы 1 и 2 могут выполняться параллельно по согласованию сторон.", start = "Границы проверки фиксируются в Протоколе на этапе старта работ.", end = "Перечень материалов фиксируется в Протоколе границ проверки по итогам Этапа 1.", max = "Общий максимальный срок — 40 рабочих дней после полного аванса или всех материалов, что наступит позднее. Ожидание материалов не входит в этот срок.";
  const stages = planAnswer().stages, rows = stages.map((entry) => [entry.title, entry.scope, `${entry.duration.count} рабочих дней`, entry.result]);
  const sections: CommercialSection[] = [
    { id: "payment", kind: "payment", title: "Оплата", blocks: [para("advance-amount", advance.slice(0, split)), para("advance-deadline", advance.slice(split))] },
    { id: "schedule", kind: "schedule", title: "План", blocks: [para("plan-summary", summary), { id: "plan-table", kind: "table", columns: ["Этап", "Описание", "Срок", "Результат"], rows: rows.map((row) => row.map((cell) => [{ kind: "text", text: cell }])) }, para("parallel", parallel), para("protocol-start", start), para("protocol-end", end), para("maximum", max)] },
    { id: "definitions", kind: "definitions", title: "Определения", blocks: [para("definition", "Нужно определить исходный документ.")] },
  ];
  const records = [
    { id: "advance", quote: advance, roles: ["payment" as const] }, { id: "stage-declaration", quote: summary, roles: ["schedule" as const] },
    { id: "table-header", quote: "Этап\tОписание\tСрок\tРезультат", roles: ["schedule" as const] },
    ...rows.map((row, index) => ({ id: `source-stage-${index + 1}`, quote: row.join("\t"), roles: ["schedule" as const] })),
    { id: "source-parallel", quote: parallel, roles: ["schedule" as const] }, { id: "source-start", quote: start, roles: ["customer-inputs" as const] }, { id: "source-end", quote: end, roles: ["customer-inputs" as const] }, { id: "source-max", quote: max, roles: ["schedule" as const] },
  ];
  const coverage: CommercialClauseCoverage[] = [
    { sourceClauseId: "advance", kind: "split", parts: [{ targetBlockId: "advance-amount", purpose: "advance-base", spans: [{ startUtf16: 0, endUtf16: split }] }, { targetBlockId: "advance-deadline", purpose: "advance-days", spans: [{ startUtf16: split, endUtf16: advance.length }] }] },
    { sourceClauseId: "stage-declaration", kind: "literal", targetBlockIds: ["plan-summary"] }, { sourceClauseId: "table-header", kind: "literal", targetBlockIds: ["plan-table"] },
    ...rows.map((_row, index): CommercialClauseCoverage => ({ sourceClauseId: `source-stage-${index + 1}`, kind: "literal", targetBlockIds: ["plan-table"] })),
    ...[["source-parallel", "parallel"], ["source-start", "protocol-start"], ["source-end", "protocol-end"], ["source-max", "maximum"]].map(([sourceClauseId, target]): CommercialClauseCoverage => ({ sourceClauseId, kind: "literal", targetBlockIds: [target] })),
  ];
  const doc: ProposalCommercialDocumentV1 = { version: 1, revision: 1, body: { version: 1, sections }, privateAppendix: { version: 1, documentId: "contract", sourceSnapshotKey: await commercialFingerprint("source-snapshot"), extraction: { complete: true, requiresOcr: false, visualAssessment: "unassessed" }, containers: [{ id: "container", sourceId: "source", kind: "contract", heading: "Договор" }], clauses: await Promise.all(records.map(async (record) => ({ ...record, containerId: "container", sourceId: "source", sourceName: "Учебный договор", fragmentId: record.id, locator: record.id, quoteHash: await commercialFingerprint(record.quote), classification: "commercial" as const }))), references: [], coverage }, questions: [], decisions: [] };
  const at = advance.lastIndexOf("Договора"); doc.privateAppendix.references = [{ id: "ref-contract", sourceClauseId: "advance", span: { startUtf16: at, endUtf16: at + "Договора".length }, printed: "Договора", kind: "event", scopeHint: "contract", candidateClauseIds: [] }];
  const questions: Array<{ kind: CommercialTermQuestionKind; targets: string[]; clauses: string[]; refs?: string[] }> = [
    { kind: "advance-base", targets: ["advance-amount"], clauses: ["advance"] }, { kind: "advance-days", targets: ["advance-deadline"], clauses: ["advance"] },
    { kind: "stage-plan", targets: ["plan-summary", "plan-table"], clauses: ["stage-declaration", ...rows.map((_row, index) => `source-stage-${index + 1}`)] },
    { kind: "stage-parallelism", targets: ["parallel"], clauses: ["source-parallel"] }, { kind: "boundary-protocol", targets: ["protocol-start", "protocol-end"], clauses: ["source-start", "source-end"] },
    { kind: "source-reference", targets: ["definition"], clauses: ["advance"], refs: ["ref-contract"] },
  ];
  for (const entry of questions) {
    const pick = { kind: entry.kind, sourceClauseIds: entry.clauses, sourceReferenceIds: entry.refs || [] };
    doc.questions.push({ ...pick, id: entry.kind, sectionId: entry.kind === "source-reference" ? "definitions" : entry.kind.startsWith("advance") ? "payment" : "schedule", targetBlockIds: entry.targets, message: `Требует решения ${entry.kind}`, material: true, dependencyFingerprint: await commercialQuestionSourceFingerprint(doc.privateAppendix, pick) });
  }
  expect(validateCommercialDocument(doc)).toEqual([]); return doc;
}
let sequence = 0;
async function apply(doc: ProposalCommercialDocumentV1, answer: CommercialTermAnswer, price = context()) {
  const validation = await validateTermAnswer(doc, answer.kind, answer, price);
  return applyTermDecision(doc, { questionId: answer.kind, answer, expectedRevision: doc.revision, expectedDependencyFingerprint: validation.dependencyFingerprint, decisionId: `decision-${++sequence}`, appliedAt: "2030-01-01T10:00:00.000Z" }, price);
}

describe("commercial typed answers and explicit append-only Apply", () => {
  it("has no auto answers and preserves source-only questions until explicit Apply", async () => {
    const doc = await fixture(), before = structuredClone(doc), projected = await projectReadiness(doc, context());
    expect(projected.canSaveDraft).toBe(true); expect(projected.canFinalize).toBe(false); expect(projected.activeDecisionIds).toEqual([]);
    expect((await currentQuestionState(doc, "advance-base", context())).status).toBe("unresolved");
    expect((await validateTermAnswer(doc, "advance-base", baseAnswer, context())).valid).toBe(true); expect(doc).toEqual(before); expect(doc.decisions).toEqual([]);
  });
  it("calculates the advance in integer minor units without applying the source price or duplicating VAT", async () => {
    const doc = await fixture(), before = structuredClone(doc), applied = await apply(doc, baseAnswer), result = applied.document;
    expect(text(own(result, "advance-amount"))).toContain("30 000,00 ₽"); expect(text(own(result, "advance-amount"))).toContain("6 000,00 ₽"); expect(text(own(result, "advance-amount"))).toContain("36 000,00 ₽");
    expect(text(own(result, "advance-deadline"))).toBe(text(own(doc, "advance-deadline")));
    expect(result.revision).toBe(2); expect(result.decisions).toHaveLength(1); expect(result.decisions[0].origin).toBe("user");
    expect(result.privateAppendix.clauses).toEqual(doc.privateAppendix.clauses); expect(doc).toEqual(before);
    expect(Object.isFrozen(result.privateAppendix.clauses)).toBe(true); expect(Object.isFrozen(result.decisions[0].answer)).toBe(true);
    expect((await currentQuestionState(result, "advance-base", context())).activeDecision?.id).toBe(applied.decision.id);
    expect(result.privateAppendix.coverage[0]).toMatchObject({ kind: "split", parts: [{ supersededByDecisionId: applied.decision.id }, {}] });
  });
  it.each([["gross", "included", "36 000,00 ₽"], ["net", "included", "30 000,00 ₽"], ["gross", "additional", "43 200,00 ₽"]] as const)("makes the selected %s/%s rule explicit rather than choosing it", async (base, vatTreatment, amount) => {
    const result = await apply(await fixture(), { kind: "advance-base", base, vatTreatment });
    expect(text(own(result.document, "advance-amount"))).toContain(amount);
    if (base === "gross" && vatTreatment === "additional") expect(result.issues.some((part) => part.code === "commercial-gross-additional-vat")).toBe(true);
  });
  it("keeps calendar/business selection separate from the amount decision", async () => {
    const first = await apply(await fixture(), baseAnswer), next = await apply(first.document, dayAnswer);
    expect(text(own(next.document, "advance-deadline"))).toContain("5 календарных дней после подписания Договора");
    expect((await currentQuestionState(next.document, "advance-base", context())).activeDecision?.id).toBe(first.decision.id);
    expect((await currentQuestionState(next.document, "advance-days", context())).activeDecision?.id).toBe(next.decision.id);
    const changed = await apply(next.document, { kind: "advance-days", dayKind: "business" });
    expect(changed.decision.supersedesDecisionId).toBe(next.decision.id); expect(changed.document.decisions.slice(0, 2)).toEqual(next.document.decisions);
    expect(text(own(changed.document, "advance-deadline"))).toContain("5 рабочих дней");
  });
  it("blocks unknown residual amount clauses instead of erasing setoff or other conditions", async () => {
    const doc = await fixture(), source = doc.privateAppendix.clauses[0], marker = "с зачётом ранее перечисленных сумм, ";
    const oldSplit = source.quote.indexOf("в течение"); source.quote = source.quote.slice(0, oldSplit) + marker + source.quote.slice(oldSplit); source.quoteHash = await commercialFingerprint(source.quote);
    const referenceAt = source.quote.lastIndexOf("Договора"); doc.privateAppendix.references[0].span = { startUtf16: referenceAt, endUtf16: referenceAt + "Договора".length };
    const split = oldSplit + marker.length;
    doc.privateAppendix.coverage[0] = { sourceClauseId: source.id, kind: "split", parts: [
      { targetBlockId: "advance-amount", purpose: "advance-base", spans: [{ startUtf16: 0, endUtf16: split }] },
      { targetBlockId: "advance-deadline", purpose: "advance-days", spans: [{ startUtf16: split, endUtf16: source.quote.length }] },
    ] };
    (own(doc, "advance-amount") as Extract<CommercialBlock, { kind: "paragraph" }>).content = [{ kind: "text", text: source.quote.slice(0, split) }];
    for (const question of doc.questions.filter((entry) => entry.sourceClauseIds.includes(source.id))) question.dependencyFingerprint = await commercialQuestionSourceFingerprint(doc.privateAppendix, question);
    const before = structuredClone(doc), validation = await validateTermAnswer(doc, "advance-base", baseAnswer, context());
    expect(validation.valid).toBe(false); expect(validation.issues.some((part) => part.code === "commercial-advance-closed-form")).toBe(true);
    await expect(apply(doc, baseAnswer)).rejects.toMatchObject({ code: "commercial-answer-invalid" }); expect(doc).toEqual(before); expect(text(own(doc, "advance-amount"))).toContain(marker);
  });
  it("supports only a whole explicit base grammar, including a consistent spelled percentage and tax name", async () => {
    const doc = await fixture(), source = doc.privateAppendix.clauses[0], quote = "Заказчик оплачивает Исполнителю аванс в размере 25 (Двадцати пяти) процентов от суммы, указанной в п. 3.1 Договора, кроме того налог на добавленную стоимость по установленной законодательством Российской Федерации ставке,в течение 5 дней после подписания Договора.";
    source.quote = quote; source.quoteHash = await commercialFingerprint(quote); const split = quote.indexOf("в течение");
    doc.privateAppendix.coverage[0] = { sourceClauseId: source.id, kind: "split", parts: [{ targetBlockId: "advance-amount", purpose: "advance-base", spans: [{ startUtf16: 0, endUtf16: split }] }, { targetBlockId: "advance-deadline", purpose: "advance-days", spans: [{ startUtf16: split, endUtf16: quote.length }] }] };
    const at = quote.lastIndexOf("Договора"); doc.privateAppendix.references[0].span = { startUtf16: at, endUtf16: at + "Договора".length };
    for (const question of doc.questions.filter((entry) => entry.sourceClauseIds.includes(source.id))) question.dependencyFingerprint = await commercialQuestionSourceFingerprint(doc.privateAppendix, question);
    expect((await validateTermAnswer(doc, "advance-base", baseAnswer, context())).valid).toBe(true);
    const contradictory = structuredClone(doc); contradictory.privateAppendix.clauses[0].quote = quote.replace("Двадцати пяти", "Тридцати"); contradictory.privateAppendix.clauses[0].quoteHash = await commercialFingerprint(contradictory.privateAppendix.clauses[0].quote);
    expect((await validateTermAnswer(contradictory, "advance-base", baseAnswer, context())).valid).toBe(false);
  });
  it("never treats no VAT as a zero-rate VAT or a VAT-included price", async () => {
    const none = context(); none.pricing!.lines[0].tax = { kind: "none" };
    const result = await apply(await fixture(), { kind: "advance-base", base: "gross", vatTreatment: "included" }, none), output = text(own(result.document, "advance-amount"));
    expect(output).toContain("НДС не применяется"); expect(output).not.toContain("цены предложения с НДС"); expect(output).not.toContain("включён НДС");
    expect(result.issues.some((part) => part.code === "commercial-advance-no-vat-context")).toBe(true);
    const zero = context(); zero.pricing!.lines[0].tax = { kind: "vat", rate: 0 };
    const vatZero = await apply(await fixture(), { kind: "advance-base", base: "gross", vatTreatment: "included" }, zero);
    expect(text(own(vatZero.document, "advance-amount"))).toContain("включён НДС: 0,00 ₽"); expect(vatZero.issues.some((part) => part.code === "commercial-advance-no-vat-context")).toBe(false);
  });
  it("rejects stale revision, price dependency and replayed decision IDs without mutating anything", async () => {
    const doc = await fixture(), validation = await validateTermAnswer(doc, "advance-base", baseAnswer, context()), before = structuredClone(doc);
    const command = { questionId: "advance-base", answer: baseAnswer, expectedRevision: 1, expectedDependencyFingerprint: validation.dependencyFingerprint, decisionId: "fixed-id", appliedAt: "2030-01-01T10:00:00.000Z" };
    await expect(applyTermDecision(doc, { ...command, expectedRevision: 0 }, context())).rejects.toMatchObject({ code: "commercial-stale-revision" });
    await expect(applyTermDecision(doc, command, context("200000"))).rejects.toMatchObject({ code: "commercial-stale-dependency" });
    const applied = await applyTermDecision(doc, command, context());
    await expect(applyTermDecision(applied.document, { ...command, expectedRevision: applied.document.revision }, context())).rejects.toMatchObject({ code: "commercial-decision-replay" });
    expect(doc).toEqual(before);
  });
  it.each([{}, { kind: "advance-base", base: "net", vatTreatment: "additional", acknowledge: true }, { kind: "advance-days", dayKind: "unknown" }, { kind: "stage-plan", stages: [stage("new", 5)], maximum: { count: "40", dayKind: "business" }, approved: true }, { kind: "source-reference", referenceIds: ["ref-contract"], resolution: { kind: "governing-document", definitionTitle: "Договор", definitionText: "Да" } }])("rejects malformed or blanket answer %j", async (answer) => {
    const doc = await fixture(), value = answer as CommercialTermAnswer, id = objectKind(answer) || "advance-base";
    expect((await validateTermAnswer(doc, id, value, context())).valid).toBe(false);
  });
});
function objectKind(value: unknown): string | undefined { return value && typeof value === "object" && "kind" in value ? String(value.kind) : undefined; }

describe("complete stage plans, concrete relations and permission milestones", () => {
  it("requires full content for an explicit fifth stage, never invents it or sums durations into a new maximum", async () => {
    const doc = await fixture(), incomplete = planAnswer(5); incomplete.stages[4].result = "";
    expect((await validateTermAnswer(doc, "stage-plan", incomplete, context())).valid).toBe(false);
    expect((await validateTermAnswer(doc, "stage-plan", { ...planAnswer(), maximum: { count: "30", dayKind: "business" } }, context())).issues.some((part) => part.code === "commercial-stage-maximum")).toBe(true);
    const result = await apply(doc, planAnswer(5)); expect(result.document.decisions[0].answer).toEqual(planAnswer(5));
    expect((own(result.document, "plan-table") as Extract<CommercialBlock, { kind: "table" }>).rows).toHaveLength(5);
    expect(text(own(result.document, "plan-summary"))).toContain("40 рабочих дней"); expect(text(own(result.document, "plan-summary"))).not.toContain("60 рабочих дней");
    expect(text(own(result.document, "maximum"))).toBe(text(own(doc, "maximum")));
    expect(text(own(result.document, "maximum"))).toContain("что наступит позднее"); expect(text(own(result.document, "maximum"))).toContain("Ожидание материалов не входит");
  });
  it("preserves a stage's explicit completion trigger or blocks a replacement that cannot represent it", async () => {
    const doc = await fixture(), source = doc.privateAppendix.clauses.find((clause) => clause.id === "source-stage-4")!, trigger = "5 рабочих дней с момента завершения Этапов 1–3";
    source.quote = source.quote.replace("5 рабочих дней", trigger); source.quoteHash = await commercialFingerprint(source.quote);
    const table = own(doc, "plan-table") as Extract<CommercialBlock, { kind: "table" }>;
    table.rows[3][2] = [{ kind: "text", text: trigger }];
    const question = doc.questions.find((entry) => entry.kind === "stage-plan")!; question.dependencyFingerprint = await commercialQuestionSourceFingerprint(doc.privateAppendix, question);
    expect((await validateTermAnswer(doc, "stage-plan", planAnswer(), context())).issues.some((part) => part.code === "commercial-stage-trigger-unrepresentable")).toBe(true);
    const answer = planAnswer(); answer.stages.forEach((entry, index) => { entry.id = `source-stage-${index + 1}`; });
    const result = await apply(doc, answer); expect(text(own(result.document, "plan-table"))).toContain(trigger);
    const changed = structuredClone(answer); changed.stages[3].duration.count = "6";
    expect((await validateTermAnswer(doc, "stage-plan", changed, context())).valid).toBe(false);
    expect((await currentQuestionState(result.document, "stage-plan", context())).status).toBe("resolved");
  });
  it("never reintroduces the parallel clause already split out of a stage duration cell", async () => {
    const doc = await fixture(), source = doc.privateAppendix.clauses.find((clause) => clause.id === "source-stage-2")!, rule = "Работы ведутся параллельно с этапом 1";
    source.quote = source.quote.replace("15 рабочих дней", `15 рабочих дней\n${rule}`); source.quoteHash = await commercialFingerprint(source.quote);
    const start = source.quote.indexOf(`\n${rule}`), end = start + rule.length + 1;
    doc.body.sections[1].blocks.push(para("stage-two-parallel", `Этап 2\n${rule}`));
    doc.privateAppendix.coverage = doc.privateAppendix.coverage.map((entry) => entry.sourceClauseId === source.id ? { sourceClauseId: source.id, kind: "split", parts: [
      { targetBlockId: "plan-table", purpose: "stage-plan", spans: [{ startUtf16: 0, endUtf16: start }, { startUtf16: end, endUtf16: source.quote.length }] },
      { targetBlockId: "stage-two-parallel", purpose: "stage-parallelism", spans: [{ startUtf16: start, endUtf16: end }], contextSpans: [{ startUtf16: 0, endUtf16: "Этап 2".length }] },
    ] } : entry);
    const parallel = doc.questions.find((entry) => entry.kind === "stage-parallelism")!; parallel.targetBlockIds.push("stage-two-parallel"); parallel.sourceClauseIds.push(source.id);
    for (const question of doc.questions.filter((entry) => ["stage-plan", "stage-parallelism"].includes(entry.kind))) question.dependencyFingerprint = await commercialQuestionSourceFingerprint(doc.privateAppendix, question);
    const answer = planAnswer(); answer.stages[1].id = source.id;
    const applied = await apply(doc, answer); expect(text(own(applied.document, "plan-table"))).not.toContain(rule);
    expect(text(own(applied.document, "stage-two-parallel"))).toContain(rule);
  });
  it("rejects overlap violating a source completion trigger and privately flags a chain longer than the maximum", async () => {
    const doc = await fixture(), source = doc.privateAppendix.clauses.find((clause) => clause.id === "source-stage-4")!;
    source.quote = source.quote.replace("5 рабочих дней", "5 рабочих дней с момента завершения Этапов 1–3"); source.quoteHash = await commercialFingerprint(source.quote);
    const question = doc.questions.find((entry) => entry.kind === "stage-plan")!; question.dependencyFingerprint = await commercialQuestionSourceFingerprint(doc.privateAppendix, question);
    const answer = planAnswer(); answer.stages.forEach((entry, index) => { entry.id = `source-stage-${index + 1}`; });
    const planned = (await apply(doc, answer)).document, overlap: CommercialTermAnswer = { kind: "stage-parallelism", relations: [{ kind: "may-overlap", stageIds: answer.stages.map((entry) => entry.id), conditions: "при наличии всех материалов" }] };
    expect((await validateTermAnswer(planned, "stage-parallelism", overlap, context())).valid).toBe(false);
    const sequential: CommercialTermAnswer = { kind: "stage-parallelism", relations: answer.stages.slice(1).map((entry, index) => ({ kind: "after", stageId: entry.id, afterStageId: answer.stages[index].id })) };
    const validation = await validateTermAnswer(planned, "stage-parallelism", sequential, context());
    expect(validation.issues.some((part) => part.code === "commercial-stage-maximum-consistency" && part.severity === "review")).toBe(true);
    expect(text(own(planned, "maximum"))).toContain("40 рабочих дней"); expect(text(own(planned, "maximum"))).not.toContain("60 рабочих дней");
    const impossible = planAnswer(); impossible.stages[0].duration.count = "41";
    expect((await validateTermAnswer(await fixture(), "stage-plan", impossible, context())).valid).toBe(false);
  });
  it("includes preserved source completion edges when checking protocol milestone cycles", async () => {
    const doc = await fixture(), source = doc.privateAppendix.clauses.find((clause) => clause.id === "source-stage-4")!;
    const trigger = "5 рабочих дней с момента завершения Этапов 1–3";
    source.quote = source.quote.replace("5 рабочих дней", trigger); source.quoteHash = await commercialFingerprint(source.quote);
    const question = doc.questions.find((entry) => entry.kind === "stage-plan")!; question.dependencyFingerprint = await commercialQuestionSourceFingerprint(doc.privateAppendix, question);
    const answer = planAnswer(); answer.stages.forEach((entry, index) => { entry.id = `source-stage-${index + 1}`; });
    const planned = (await apply(doc, answer)).document;
    const relations: CommercialTermAnswer = { kind: "stage-parallelism", relations: answer.stages.slice(1).map((entry) => ({ kind: "after", stageId: entry.id, afterStageId: answer.stages[0].id })) };
    const linked = (await apply(planned, relations)).document;
    expect(text(own(linked, "plan-table"))).toContain(trigger);
    const cyclic: CommercialTermAnswer = { kind: "boundary-protocol", milestones: [{ ...protocolAnswer.milestones[0], beforeStageIds: [answer.stages[1].id], afterStageIds: [answer.stages[3].id] }] };
    const before = structuredClone(linked), validation = await validateTermAnswer(linked, "boundary-protocol", cyclic, context());
    expect(validation.valid).toBe(false); expect(validation.issues.some((part) => part.code === "commercial-protocol-cycle")).toBe(true);
    await expect(apply(linked, cyclic)).rejects.toMatchObject({ code: "commercial-answer-invalid" }); expect(linked).toEqual(before);
  });
  it("requires a resolved plan before relations and rejects dangling IDs, cycles and contradictory overlap", async () => {
    const doc = await fixture(); expect((await validateTermAnswer(doc, "stage-parallelism", parallelAnswer(), context())).valid).toBe(false);
    const planned = (await apply(doc, planAnswer())).document;
    const bad = [
      { kind: "stage-parallelism", relations: [{ kind: "after", stageId: "unknown", afterStageId: "stage-1" }] },
      { kind: "stage-parallelism", relations: [{ kind: "after", stageId: "stage-2", afterStageId: "stage-1" }, { kind: "after", stageId: "stage-1", afterStageId: "stage-2" }] },
      { kind: "stage-parallelism", relations: [...parallelAnswer().relations, { kind: "may-overlap", stageIds: ["stage-1", "stage-2"], conditions: "при наличии материалов" }] },
      { kind: "stage-parallelism", relations: [{ kind: "after", stageId: "stage-2", afterStageId: "stage-1" }] },
    ] as CommercialTermAnswer[];
    for (const answer of bad) expect((await validateTermAnswer(planned, "stage-parallelism", answer, context())).valid).toBe(false);
    const result = await apply(planned, parallelAnswer()); expect((await currentQuestionState(result.document, "stage-parallelism", context())).status).toBe("resolved");
  });
  it("does not permit testing before agreed boundaries/permission or cyclic milestones", async () => {
    const planned = (await apply(await fixture(), planAnswer())).document, linked = (await apply(planned, parallelAnswer())).document;
    const unsafe: CommercialTermAnswer = { kind: "boundary-protocol", milestones: [{ title: "Протокол границ", condition: protocolAnswer.milestones[0].condition, beforeStageIds: ["stage-3"], afterStageIds: ["stage-2"] }] };
    expect((await validateTermAnswer(linked, "boundary-protocol", unsafe, context())).issues.some((part) => part.code === "commercial-protocol-before-testing")).toBe(true);
    const cyclic: CommercialTermAnswer = { kind: "boundary-protocol", milestones: [{ ...protocolAnswer.milestones[0], beforeStageIds: ["stage-2"], afterStageIds: ["stage-3"] }] };
    expect((await validateTermAnswer(linked, "boundary-protocol", cyclic, context())).valid).toBe(false);
    const applied = await apply(linked, protocolAnswer);
    expect(text(own(applied.document, "protocol-end"))).toContain("Перечень материалов фиксируется");
    expect(text(own(applied.document, "protocol-start"))).toContain("Тестирование допускается только после согласования границ и получения разрешения");
    expect((await currentQuestionState(applied.document, "boundary-protocol", context())).status).toBe("resolved");
  });
  it("does not mistake negated agreement or permission for a safe protocol milestone", async () => {
    const planned = (await apply(await fixture(), planAnswer())).document, linked = (await apply(planned, parallelAnswer())).document;
    for (const condition of ["Границы не согласованы, письменное разрешение не получено", "Границы согласованы, но разрешение отсутствует", "Нет согласования границ и нет разрешения", "Границы согласованы, в разрешении отказано"]) {
      const answer: CommercialTermAnswer = { kind: "boundary-protocol", milestones: [{ ...protocolAnswer.milestones[0], condition }] };
      expect((await validateTermAnswer(linked, "boundary-protocol", answer, context())).valid).toBe(false);
    }
  });
  it.each([
    "Границы согласованы",
    "Границы не были согласованы, письменное разрешение не было получено.",
    "Границы будут согласованы, письменное разрешение будет получено.",
    "Границы могут быть согласованы, письменное разрешение может быть получено.",
    "Если границы согласованы, письменное разрешение получено.",
    "«Границы согласованы, письменное разрешение получено» — пример, а не выполненное условие.",
    "Границы согласованы, письменное разрешение получено, но согласование отозвано.",
  ])("keeps unsupported or non-positive protocol wording as an unresolved draft: %s", async (condition) => {
    const planned = (await apply(await fixture(), planAnswer())).document, linked = (await apply(planned, parallelAnswer())).document, before = structuredClone(linked);
    const answer: CommercialTermAnswer = { kind: "boundary-protocol", milestones: [{ ...protocolAnswer.milestones[0], condition }] };
    const validation = await validateTermAnswer(linked, "boundary-protocol", answer, context());
    expect(validation.valid).toBe(false); expect(validation.previewBlocks).toEqual([]);
    expect(validation.issues.some((part) => part.code === "commercial-protocol-condition-unrepresentable")).toBe(true);
    await expect(apply(linked, answer)).rejects.toMatchObject({ code: "commercial-answer-invalid" }); expect(linked).toEqual(before);
    expect((await projectReadiness(linked, context())).canSaveDraft).toBe(true);
  });
  it("requires each permission-bearing milestone to use the supported complete positive form", async () => {
    const planned = (await apply(await fixture(), planAnswer())).document, linked = (await apply(planned, parallelAnswer())).document;
    const mixed: CommercialTermAnswer = { kind: "boundary-protocol", milestones: [...protocolAnswer.milestones, { title: "Сомнение в разрешении", condition: "Разрешение пока не было получено", beforeStageIds: [], afterStageIds: ["stage-2"] }] };
    expect((await validateTermAnswer(linked, "boundary-protocol", mixed, context())).valid).toBe(false);
    for (const condition of ["Границы согласованы, письменное разрешение получено", "Периметр проверки утверждён; разрешение на проведение тестирования выдано.", "Письменное разрешение подписано и границы тестирования утверждены."]) {
      const answer: CommercialTermAnswer = { kind: "boundary-protocol", milestones: [{ ...protocolAnswer.milestones[0], condition }] };
      expect((await validateTermAnswer(linked, "boundary-protocol", answer, context())).valid).toBe(true);
    }
  });
  it("invalidates dependent answers after a new stage plan, but preserves independent advance/day decisions", async () => {
    let doc = (await apply(await fixture(), baseAnswer)).document; doc = (await apply(doc, dayAnswer)).document;
    doc = (await apply(doc, planAnswer())).document; doc = (await apply(doc, parallelAnswer())).document; doc = (await apply(doc, protocolAnswer)).document;
    const before = await projectReadiness(doc, context()), updated = await apply(doc, planAnswer(5)), projected = await projectReadiness(updated.document, context());
    expect(updated.invalidatedDecisionIds.length).toBe(3); expect(projected.questions.find((state) => state.question.kind === "advance-base")?.status).toBe("resolved");
    expect(projected.questions.find((state) => state.question.kind === "advance-days")?.status).toBe("resolved");
    expect(projected.questions.find((state) => state.question.kind === "stage-parallelism")?.activeDecision).toBeUndefined();
    expect(projected.questions.find((state) => state.question.kind === "boundary-protocol")?.activeDecision).toBeUndefined();
    expect(updated.document.decisions.slice(0, doc.decisions.length)).toEqual(doc.decisions); expect(before.activeDecisionIds).toHaveLength(5);
    const fixed = await apply(updated.document, parallelAnswer(5)); expect((await currentQuestionState(fixed.document, "stage-parallelism", context())).status).toBe("resolved");
  });
});

describe("decision dependencies, reference ownership and honest final readiness", () => {
  it("binds only financial context for advance, not descriptions/contact fields or JSON key order", async () => {
    const price = context(), applied = await apply(await fixture(), baseAnswer, price), doc = applied.document;
    const descriptions = structuredClone(price); descriptions.pricing!.lines[0].description = "Новая подпись описания"; descriptions.pricing!.lines[0].title = "Новое название";
    expect((await currentQuestionState(doc, "advance-base", descriptions)).activeDecision?.id).toBe(applied.decision.id);
    expect((await currentQuestionState(doc, "advance-base", context("200000"))).activeDecision).toBeUndefined();
    const reordered = JSON.parse(JSON.stringify(doc, (_key, value) => value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value));
    expect((await currentQuestionState(reordered, "advance-base", descriptions)).status).toBe("resolved");
  });
  it("does not trust a bare after fingerprint or a matching old source hash after body/source edits", async () => {
    const applied = await apply(await fixture(), baseAnswer), changed = structuredClone(applied.document);
    (own(changed, "advance-amount") as Extract<CommercialBlock, { kind: "paragraph" }>).content = [{ kind: "text", text: "Аванс 1 рубль, условия изменены" }];
    changed.decisions[0].afterFingerprint = await commercialFingerprint({ version: 1, blocks: [own(changed, "advance-amount")] });
    expect((await currentQuestionState(changed, "advance-base", context())).activeDecision).toBeUndefined();
    const source = structuredClone(applied.document); source.privateAppendix.clauses[0].quote += " Другое условие.";
    expect((await projectReadiness(source, context())).canFinalize).toBe(false); expect((await currentQuestionState(source, "advance-base", context())).activeDecision).toBeUndefined();
    const missing = structuredClone(applied.document); missing.body.sections[0].blocks.shift(); expect((await projectReadiness(missing, context())).canSaveDraft).toBe(false);
  });
  it("resolves governing-document definitions without rewriting upstream clauses or blessing previews", async () => {
    let doc = (await apply(await fixture(), baseAnswer)).document; doc = (await apply(doc, dayAnswer)).document;
    const answer: CommercialTermAnswer = { kind: "source-reference", referenceIds: ["ref-contract"], resolution: { kind: "governing-document", definitionTitle: "Исходный договор", definitionText: "Под исходным договором стороны понимают договор оказания учебных услуг № QA-1 от 1 января 2030 года." } };
    const before = structuredClone(doc), validation = await validateTermAnswer(doc, "source-reference", answer, context()); expect(validation.valid).toBe(true); expect(doc).toEqual(before);
    const result = await apply(doc, answer); expect(text(own(result.document, "definition"))).toContain("№ QA-1"); expect(own(result.document, "advance-amount")).toEqual(own(doc, "advance-amount"));
    expect((await currentQuestionState(result.document, "source-reference", context())).status).toBe("resolved");
    expect((await currentQuestionState(result.document, "source-reference", context("200000"))).activeDecision).toBeUndefined();
  });
  it("binds chosen body targets and rejects missing/self/foreign reference selections and overlapping replacement", async () => {
    let doc = (await apply(await fixture(), baseAnswer)).document; doc = (await apply(doc, dayAnswer)).document;
    const answer: CommercialTermAnswer = { kind: "source-reference", referenceIds: ["ref-contract"], resolution: { kind: "body-target", targetIds: ["maximum"] } };
    const result = await apply(doc, answer); expect((await currentQuestionState(result.document, "source-reference", context())).status).toBe("resolved");
    const edited = structuredClone(result.document); (own(edited, "maximum") as Extract<CommercialBlock, { kind: "paragraph" }>).content.push({ kind: "text", text: "Изменение срока." });
    expect((await currentQuestionState(edited, "source-reference", context())).activeDecision).toBeUndefined();
    const bad: CommercialTermAnswer[] = [
      { ...answer, referenceIds: ["foreign"] }, { ...answer, resolution: { kind: "body-target", targetIds: ["missing"] } }, { ...answer, resolution: { kind: "body-target", targetIds: ["definition"] } },
      { ...answer, resolution: { kind: "replace-clauses", replacements: [{ blockId: "advance-amount", publicText: "Меняем чужую сумму" }] } },
    ];
    for (const value of bad) expect((await validateTermAnswer(doc, "source-reference", value, context())).valid).toBe(false);
    const overlap = structuredClone(doc); overlap.questions[5].targetBlockIds = ["advance-amount"];
    expect((await validateTermAnswer(overlap, "source-reference", answer, context())).issues.some((part) => part.code === "commercial-decision-target-overlap")).toBe(true);
    expect((await validateTermAnswer(overlap, "advance-base", baseAnswer, context())).valid).toBe(true);
  });
  it("keeps clean initial split/layout receipts through supersedes and rejects forged or missing mappings", async () => {
    const first = await apply(await fixture(), baseAnswer), second = await apply(first.document, dayAnswer);
    const receipt = second.decision.sourceCoverageBefore![0];
    expect(receipt.kind).toBe("split"); if (receipt.kind === "split") expect(receipt.parts.every((part) => !part.supersededByDecisionId)).toBe(true);
    const plan = await apply(second.document, planAnswer());
    expect(plan.decision.sourceClauseIds).toContain("table-header"); expect(plan.decision.sourceCoverageBefore?.some((entry) => entry.sourceClauseId === "table-header")).toBe(true);
    const missing = structuredClone(first.document); delete missing.decisions[0].sourceCoverageBefore;
    // Split spans still exist in the live source record; lack of a metadata
    // receipt cannot reauthorize a matching after fingerprint by itself.
    expect((await currentQuestionState(missing, "advance-base", context())).activeDecision).toBeUndefined();
    const forged = structuredClone(plan.document); forged.decisions[2].sourceCoverageBefore![0] = { sourceClauseId: "stage-declaration", kind: "literal", targetBlockIds: ["maximum"] };
    expect((await currentQuestionState(forged, "stage-plan", context())).activeDecision).toBeUndefined();
  });
  it("blocks reference dependency cycles and duplicate or reordered decision lineage", async () => {
    let doc = (await apply(await fixture(), baseAnswer)).document; doc = (await apply(doc, dayAnswer)).document;
    doc = structuredClone(doc);
    const question = doc.questions.find((entry) => entry.kind === "source-reference")!;
    doc.body.sections[2].blocks.push(para("definition-two", "Второе определение"));
    doc.questions.push({ ...question, id: "reference-two", targetBlockIds: ["definition-two"] });
    const fake = { version: 1 as const, origin: "user" as const, appliedAt: "2030-01-01T10:00:00.000Z", sourceSnapshotKey: doc.privateAppendix.sourceSnapshotKey, dependencyFingerprint: await commercialFingerprint("pending"), sourceClauseIds: [...question.sourceClauseIds], beforeFingerprint: await commercialFingerprint("before"), afterFingerprint: await commercialFingerprint("after") };
    doc.decisions.push({ ...fake, id: "ref-one", questionId: "source-reference", changedBlockIds: ["definition"], answer: { kind: "source-reference", referenceIds: ["ref-contract"], resolution: { kind: "body-target", targetIds: ["definition-two"] } } }, { ...fake, id: "ref-two", questionId: "reference-two", changedBlockIds: ["definition-two"], answer: { kind: "source-reference", referenceIds: ["ref-contract"], resolution: { kind: "body-target", targetIds: ["definition"] } } });
    const projected = await projectReadiness(doc, context()); expect(projected.canFinalize).toBe(false); expect(projected.issues.some((part) => part.code === "commercial-dependency-cycle")).toBe(true);
    const duplicated = (await apply(await fixture(), baseAnswer)).document, altered = structuredClone(duplicated); altered.decisions.push(structuredClone(altered.decisions[0]));
    expect((await projectReadiness(altered, context())).canSaveDraft).toBe(false);
  });
  it("keeps draft saves possible but blocks unknown visual completeness, external fields and unresolved material", async () => {
    const doc = await fixture(), result = await projectReadiness(doc, context());
    expect(result.canSaveDraft).toBe(true); expect(result.canFinalize).toBe(false); expect(result.issues.some((part) => part.code === "commercial-visual-unresolved")).toBe(true);
    const unknown = structuredClone(doc); unknown.privateAppendix.coverage[1] = { sourceClauseId: "stage-declaration", kind: "unmapped", reason: "Не рассмотрено" };
    expect((await projectReadiness(unknown, context())).issues.some((part) => part.code === "commercial-unmapped-material")).toBe(true);
    unknown.privateAppendix.coverage[1] = { sourceClauseId: "stage-declaration", kind: "external-field", field: "pricing" };
    expect((await projectReadiness(unknown, context())).issues.some((part) => part.code === "commercial-external-field-unverified")).toBe(true);
  });
  it("does not punish verified structural headings, while a source-valid empty body can never be final", async () => {
    const lines = ["Договор", "1. Предмет договора", "1.1. Исполнитель оказывает комплекс услуг по исследованию системы.", "2. Состав оказываемых услуг", "2.1. Анализ документации."];
    const sources = [{ id: "source", name: "Учебный источник", text: lines.join("\n"), fragments: lines.map((text, index) => ({ id: `p-${index}`, locator: String(index), text })), coverage: { complete: true, requiresOcr: false } }];
    const prepared = (await prepareCommercialDocument({ sources, sourceSnapshotKey: await taskSourceSnapshotKey(sources) })).document!;
    const reviewed = structuredClone(prepared); reviewed.privateAppendix.extraction.visualAssessment = "reviewed-by-user";
    expect((await projectReadiness(reviewed)).issues.filter((part) => part.code === "commercial-private-material-review")).toEqual([]);
    const empty = structuredClone(reviewed); empty.body.sections = []; empty.privateAppendix.clauses = []; empty.privateAppendix.coverage = []; empty.privateAppendix.references = [];
    expect((await projectReadiness(empty)).canFinalize).toBe(false);
  });
  it("never declares substantive numbered scope prose a harmless structural heading", async () => {
    const lines = ["Договор", "1. Предмет договора", "1.1. Исполнитель оказывает комплекс услуг по анализу системы.", "2. Состав оказываемых услуг включает аудит документации и интервью."];
    const sources = [{ id: "source", name: "Учебный источник", text: lines.join("\n"), fragments: lines.map((text, index) => ({ id: `p-${index}`, locator: String(index), text })), coverage: { complete: true, requiresOcr: false } }];
    const prepared = (await prepareCommercialDocument({ sources, sourceSnapshotKey: await taskSourceSnapshotKey(sources) })).document!, reviewed = structuredClone(prepared);
    reviewed.privateAppendix.extraction.visualAssessment = "reviewed-by-user";
    const substantive = reviewed.privateAppendix.clauses.find((clause) => clause.quote === lines[3])!, originalCoverage = reviewed.privateAppendix.coverage.find((entry) => entry.sourceClauseId === substantive.id)!;
    expect(substantive.classification).not.toBe("structural"); expect(JSON.stringify(reviewed.body)).toContain("включает аудит документации и интервью");
    // Replay the former wrong classification/omitted body, not a changed
    // source: a bare structural label must never bless a lost obligation.
    substantive.classification = "structural";
    const remove = originalCoverage.kind === "literal" || originalCoverage.kind === "projected" || originalCoverage.kind === "deduplicated" ? originalCoverage.targetBlockIds : [];
    reviewed.body.sections.forEach((section) => { section.blocks = section.blocks.filter((block) => !remove.includes(block.id)); });
    reviewed.privateAppendix.coverage = reviewed.privateAppendix.coverage.map((entry) => entry.sourceClauseId === substantive.id ? { sourceClauseId: entry.sourceClauseId, kind: "private-context", reason: "Ошибочно помечено как заголовок" } : entry);
    const projected = await projectReadiness(reviewed);
    expect(projected.canFinalize).toBe(false); expect(projected.issues.length).toBeGreaterThan(0);
  });
});
