import { describe, expect, it } from "vitest";
import type { IntelligenceSource } from "../intelligence/workbenchTypes";
import { taskSourceSnapshotKey } from "../intelligence/taskSourceIdentity";
import { commercialFingerprint, validateCommercialDocument, validateCommercialQuoteHashes, type CommercialBlock, type ProposalCommercialDocumentV1 } from "./commercialDocument";
import { collectCommercialReferences, collectCommercialStageCatalog, isCommercialStructuralHeading, prepareCommercialDocument, validateCommercialSourceProjection } from "./commercialPreparation";
import { projectReadiness } from "./commercialDecisions";

function source(): IntelligenceSource {
  const texts = [
    "ДОГОВОР", "1. Предмет договора", "1.1. Исполнитель оказывает комплекс услуг по проверке программной системы.",
    "3. Стоимость услуг и порядок расчётов", "3.1. Стоимость услуг 1000,00 рублей, кроме того НДС 20% 200,00 рублей. Итого 1200,00 рублей.",
    "3.2. Заказчик оплачивает аванс 30 процентов от суммы, указанной в п. 3.1 Договора, кроме того НДС, не позднее 5 дней с момента подписания настоящего Договора.",
    "3.3. Окончательный расчёт в течение 5 рабочих дней после акта или истечения срока отказа по п.п. 4.2.2 и 4.2.5 Договора.",
    "4. Сроки оказания услуг", "4.1. Начало в течение 5 календарных дней после полного аванса или всех документов, в зависимости от того, что наступит позднее.",
    "4.2.2. Заказчик направляет акт либо мотивированный отказ в течение 5 рабочих дней.",
    "4.2.5. После устранения замечаний акт либо мотивированный отказ направляется в течение 5 рабочих дней.",
    "ТЕХНИЧЕСКОЕ ЗАДАНИЕ", "1. Предмет услуг", "1.1. В рамках Договора оказывается комплекс услуг по проверке программной системы.",
    "2. Состав услуг", "Блок\tСостав действий", "Технический анализ\tИзучение документации; репозиторий при наличии доступа.", "Правовой анализ\tЦепочка прав; лицензии; рекомендации без выполнения исправлений.",
    "3. Итоговые материалы", "3.1. Итоговый отчёт в PDF и DOCX; встреча по результатам.",
    "4. Этапы оказания услуг", "4.1. Услуги оказываются в три последовательных этапа; Этапы 1 и 2 могут выполняться параллельно по согласованию сторон.",
    "Этап\tОписание\tСрок\tРезультат", "Этап 1. Анализ\tПроверка документации\t10 рабочих дней\tОтчёт", "Этап 2. Проверка\tПроверка прав\t5 рабочих дней, Работы ведутся параллельно с этапом 1\tЗаключение",
    "5. Входные данные", "5.1. Заказчик предоставляет SBOM при наличии и разрешение на тестирование в согласованных границах.",
    "5.2. Протокол границ проверки фиксируется по итогам Этапа 1.",
    "6. Условия проведения работ", "6.1. Протокол границ проверки согласовывается до начала тестирования.", "6.2. Восстановление архитектуры не входит в объём работ.",
    "7. Сроки оказания услуг", "7.1. Максимальный срок — 20 рабочих дней с момента, определённого пунктом 4.1 Договора. Ожидание материалов не включается.",
    "8. Дополнительные сведения", "Неизвестное специальное условие сохраняется для отдельного рассмотрения.",
  ];
  return { id: "source", name: "Входной документ.docx", text: texts.join("\n"), fragments: texts.map((text, index) => ({ id: index >= 15 && index <= 17 ? `table-1-row-${index - 14}` : index >= 22 && index <= 24 ? `table-2-row-${index - 21}` : `p-${index}`, locator: `Фрагмент ${index + 1}`, text })), coverage: { complete: true, requiresOcr: false }, warnings: [] };
}
const blocks = (document: ProposalCommercialDocumentV1) => document.body.sections.flatMap((section) => section.blocks);
function text(block: CommercialBlock): string {
  const inline = (parts: Array<{ kind: string; text?: string; targetId?: string }>) => parts.map((part) => part.kind === "text" ? part.text : `[${part.targetId}]`).join("");
  return block.kind === "paragraph" ? inline(block.content) : block.kind === "list" ? block.items.map(inline).join("\n") : [block.columns.join("\t"), ...block.rows.map((row) => row.map(inline).join("\t"))].join("\n");
}
async function prepare(sources = [source()]) { return prepareCommercialDocument({ sources, sourceSnapshotKey: await taskSourceSnapshotKey(sources) }); }
const alternativeLead = "Если задержка предоставления материалов превысит 12 рабочих дней, Исполнитель вправе принять одно из следующих решений:";
const alternativeFirst = "- по согласованию сторон выдать результат по предоставленным материалам; услуги подлежат оплате в полном размере согласно п. 4.1.";
const alternativeSecond = "- приостановить оказание услуг, уведомив заказчика за 4 рабочих дня. Срок возобновления согласуется отдельно. При отсутствии соглашения оплачиваются фактически выполненные работы.";
function alternativeSource(): IntelligenceSource {
  const texts = ["Договор", "1. Предмет договора", "1.1. Исполнитель оказывает комплекс услуг по анализу системы.", "4. Сроки оказания услуг", "4.1. Срок подготовки отчёта — 8 рабочих дней.", alternativeLead, alternativeFirst, alternativeSecond];
  return { id: "conditional-source", name: "Исходные условия.docx", text: texts.join("\n"), fragments: texts.map((text, index) => ({ id: `conditional-${index}`, locator: `Абзац ${index + 1}`, text })), coverage: { complete: true, requiresOcr: false } };
}
function placement(document: ProposalCommercialDocumentV1, quote: string) {
  const clause = document.privateAppendix.clauses.find((entry) => entry.quote === quote)!;
  const receipt = document.privateAppendix.coverage.find((entry) => entry.sourceClauseId === clause.id)!;
  const ids = receipt.kind === "literal" || receipt.kind === "projected" || receipt.kind === "deduplicated" ? receipt.targetBlockIds : receipt.kind === "split" ? receipt.parts.map((part) => part.targetBlockId) : [];
  return { clause, receipt, ids, section: document.body.sections.find((section) => section.blocks.some((block) => ids.includes(block.id))) };
}
function inlineScopeSource(lastClause: string): IntelligenceSource {
  const texts = ["Договор", "1. Предмет договора", "1.1. Исполнитель оказывает комплекс услуг по анализу системы.", lastClause];
  return { id: "inline-scope", name: "Исходные условия.docx", text: texts.join("\n"), fragments: texts.map((text, index) => ({ id: `inline-${index}`, locator: `Абзац ${index + 1}`, text })), coverage: { complete: true, requiresOcr: false } };
}

describe("source-derived commercial review draft", () => {
  it("keeps an explicit conditional lead and both whole alternatives adjacent in one section", async () => {
    const input = alternativeSource(), before = JSON.stringify(input), document = (await prepare([input])).document!;
    const group = [alternativeLead, alternativeFirst, alternativeSecond].map((quote) => placement(document, quote));
    expect(group.every((entry) => entry.section?.id === group[0].section?.id)).toBe(true);
    const order = group[0].section!.blocks.map((block) => block.id), start = order.indexOf(group[0].ids[0]);
    expect(order.slice(start, start + 3)).toEqual(group.flatMap((entry) => entry.ids));
    expect(group.map((entry) => entry.clause.fragmentId)).toEqual(["conditional-5", "conditional-6", "conditional-7"]);
    expect(group.every((entry) => entry.ids.length === 1 && entry.ids[0] === `block-${entry.clause.id.slice(7)}`)).toBe(true);
    expect(text(group[0].section!.blocks[start])).toBe(alternativeLead);
    expect(text(group[0].section!.blocks[start + 2])).toBe(alternativeSecond);
    const reference = document.privateAppendix.references.find((entry) => entry.sourceClauseId === group[1].clause.id && entry.kind === "clause")!;
    expect(reference.localTargetIds).toEqual(placement(document, input.fragments![4].text).ids);
    expect(text(group[0].section!.blocks[start + 1])).toBe(alternativeFirst.replace("4.1", `[${reference.localTargetIds![0]}]`));
    expect(validateCommercialSourceProjection(document)).toEqual([]); expect(validateCommercialDocument(document)).toEqual([]);
    expect(await validateCommercialQuoteHashes(document)).toEqual([]); expect(document.decisions).toEqual([]); expect(JSON.stringify(input)).toBe(before);
    const changed = structuredClone(document), branch = blocks(changed).find((block) => block.id === group[2].ids[0])!;
    if (branch.kind !== "paragraph") throw new Error("expected a complete branch paragraph");
    branch.content = [{ kind: "text", text: "Оплачиваются все услуги без условий." }];
    expect(validateCommercialSourceProjection(changed).some((issue) => issue.code === "commercial-source-projection")).toBe(true);
  });
  it.each(["heading", "marked-heading", "unrelated", "blank", "numbered-clause", "table", "table-marker", "sheet", "container"] as const)("does not attach a marked alternative through a %s boundary", async (boundary) => {
    const input = alternativeSource(), tail = input.fragments![7];
    if (boundary === "sheet") tail.sheetId = "second-sheet";
    else if (boundary === "table-marker") tail.id = "table-3-row-1";
    else {
      const text = boundary === "heading" ? "5. Итоговые материалы" : boundary === "marked-heading" ? "- Условия оплаты" : boundary === "container" ? "ТЕХНИЧЕСКОЕ ЗАДАНИЕ" : boundary === "blank" ? "" : boundary === "table" ? "Параметр\tЗначение" : boundary === "numbered-clause" ? "4.8. Срок отдельной проверки составляет 2 рабочих дня." : "Организационные сведения предоставляются отдельно.";
      input.fragments!.splice(7, 0, { id: "boundary", locator: "Граница", text });
    }
    input.text = input.fragments!.map((fragment) => fragment.text).join("\n");
    const document = (await prepare([input])).document!;
    const lead = placement(document, alternativeLead), first = placement(document, alternativeFirst), second = placement(document, alternativeSecond);
    expect(first.section?.id).toBe(lead.section?.id);
    expect(second.section?.id).not.toBe(lead.section?.id);
    expect(second.ids).toHaveLength(1); expect(text(second.section!.blocks.find((block) => block.id === second.ids[0])!)).toBe(alternativeSecond);
    expect(validateCommercialSourceProjection(document)).toEqual([]);
  });
  it("does not borrow an identical earlier outcome for a later conditional group", async () => {
    const input = alternativeSource();
    input.fragments!.splice(5, 0, { id: "earlier-outcome", locator: "Ранее", text: alternativeSecond }); input.text = input.fragments!.map((fragment) => fragment.text).join("\n");
    const document = (await prepare([input])).document!, copies = document.privateAppendix.clauses.filter((clause) => clause.quote === alternativeSecond);
    expect(copies).toHaveLength(2);
    const receipts = copies.map((clause) => document.privateAppendix.coverage.find((entry) => entry.sourceClauseId === clause.id)!);
    expect(receipts.every((entry) => entry.kind !== "deduplicated")).toBe(true);
    expect(blocks(document).filter((block) => text(block) === alternativeSecond)).toHaveLength(2);
    expect(validateCommercialSourceProjection(document)).toEqual([]);
  });
  it.each(["Договор", "1. Предмет договора", "2. Состав оказываемых услуг", "ТЕХНИЧЕСКОЕ ЗАДАНИЕ", "Приложение № 1", "Стоимость услуг и порядок расчётов:", "Итоговые материалы и результат оказания услуг", "Входные данные и условия проведения работ", "Стороны"])("recognizes only a closed structural label: %s", (heading) => {
    expect(isCommercialStructuralHeading(heading)).toBe(true);
  });
  it.each([
    "2. Состав оказываемых услуг включает аудит документации и интервью.",
    "2. Состав услуг определяется отдельным решением руководителя.",
    "3. Условия оплаты включают зачёт ранее перечисленных сумм.",
    "Ответственность сторон ограничена суммой договора.",
    "Приложение № 1 содержит исключения из объёма услуг.",
    "Входные данные и условия проведения работ согласуются после аванса.",
    "Итоговые материалы и результат оказания услуг включают отчёт.",
    "Стороны согласовали перенос срока.",
    "Состав услуг\tСодержание",
  ])("does not turn substantive text into a heading: %s", (clause) => {
    expect(isCommercialStructuralHeading(clause)).toBe(false);
  });
  it("retains substantive inline scope in the working body instead of falsely finalizing only the subject", async () => {
    const quote = "2. Состав оказываемых услуг включает аудит документации и интервью.", input = inlineScopeSource(quote), before = JSON.stringify(input);
    const document = structuredClone((await prepare([input])).document!);
    const clause = document.privateAppendix.clauses.find((part) => part.quote === quote)!;
    expect(clause.classification).toBe("commercial"); expect(clause.roles).toEqual(["scope"]);
    const coverage = document.privateAppendix.coverage.find((entry) => entry.sourceClauseId === clause.id)!;
    expect(coverage.kind).toBe("projected");
    if (coverage.kind !== "projected") throw new Error("expected a traced leading-label presentation");
    expect(coverage.presentation).toEqual([{ kind: "leading-label", span: { startUtf16: 0, endUtf16: 3 } }]);
    expect(document.body.sections.find((section) => section.kind === "scope")?.blocks.map(text)).toContain("Состав оказываемых услуг включает аудит документации и интервью.");
    expect(validateCommercialSourceProjection(document)).toEqual([]);
    document.privateAppendix.extraction.visualAssessment = "reviewed-by-user";
    const readiness = await projectReadiness(document);
    expect(readiness.canFinalize, JSON.stringify(readiness.issues)).toBe(true);
    expect(clause.quote).toBe(quote); expect(JSON.stringify(input)).toBe(before);
  });
  it("cannot classify substantive inline scope away after source projection", async () => {
    const quote = "2. Состав оказываемых услуг включает аудит документации и интервью.", document = structuredClone((await prepare([inlineScopeSource(quote)])).document!);
    const clause = document.privateAppendix.clauses.find((part) => part.quote === quote)!;
    clause.classification = "structural"; clause.roles = [];
    document.privateAppendix.coverage[document.privateAppendix.coverage.findIndex((entry) => entry.sourceClauseId === clause.id)] = { sourceClauseId: clause.id, kind: "private-context", reason: "Исходный заголовок" };
    document.privateAppendix.extraction.visualAssessment = "reviewed-by-user";
    expect(validateCommercialSourceProjection(document).some((issue) => /нельзя исключить/.test(issue.message))).toBe(true);
    expect((await projectReadiness(document)).canFinalize).toBe(false);
  });
  it("leaves unprovable inline clauses review-only rather than treating them as short headings", async () => {
    const quote = "2. Состав услуг определяется отдельным решением руководителя.", document = structuredClone((await prepare([inlineScopeSource(quote)])).document!);
    const clause = document.privateAppendix.clauses.find((part) => part.quote === quote)!;
    expect(clause.classification).toBe("unclassified");
    expect(document.privateAppendix.coverage.find((entry) => entry.sourceClauseId === clause.id)?.kind).toBe("unmapped");
    document.privateAppendix.extraction.visualAssessment = "reviewed-by-user";
    expect((await projectReadiness(document)).canFinalize).toBe(false);
  });
  it("preserves all source fragments and builds structured sections independently of any model", async () => {
    const original = source(), before = JSON.stringify(original), result = await prepare([original]);
    expect(result.origin).toBe("source-derived"); expect(result.document).toBeDefined();
    const document = result.document!;
    expect(document.privateAppendix.clauses.map((clause) => clause.quote)).toEqual(original.fragments!.map((fragment) => fragment.text));
    expect(document.privateAppendix.coverage).toHaveLength(original.fragments!.length);
    expect(validateCommercialDocument(document)).toEqual([]); expect(await validateCommercialQuoteHashes(document)).toEqual([]);
    expect(validateCommercialSourceProjection(document)).toEqual([]);
    expect(document.body.sections.map((section) => section.kind)).toEqual(expect.arrayContaining(["subject", "scope", "deliverables", "schedule", "payment"]));
    expect(blocks(document).some((block) => block.kind === "table")).toBe(true);
    expect(JSON.stringify(original)).toBe(before); expect(Object.isFrozen(document.privateAppendix.clauses)).toBe(true);
    expect(result.issues.some((issue) => issue.code === "commercial-visual-unassessed")).toBe(true);
  });
  it("never auto-answers advance, calendar, parallelism or protocol questions", async () => {
    const result = await prepare(), document = result.document!;
    expect(document.questions.map((question) => question.kind)).toEqual(expect.arrayContaining(["advance-base", "advance-days", "stage-plan", "stage-parallelism", "boundary-protocol", "source-reference"]));
    expect(document.decisions).toEqual([]);
    expect(blocks(document).map(text).join("\n")).not.toContain("360,00");
    expect(document.privateAppendix.extraction.visualAssessment).toBe("unassessed");
  });
  it("separates advance base and deadline so one decision need not invalidate the other", async () => {
    const document = (await prepare()).document!, base = document.questions.find((question) => question.kind === "advance-base")!, days = document.questions.find((question) => question.kind === "advance-days")!;
    expect(base.sourceClauseIds.some((id) => days.sourceClauseIds.includes(id))).toBe(true);
    expect(base.targetBlockIds.some((id) => days.targetBlockIds.includes(id))).toBe(false);
    const coverage = document.privateAppendix.coverage.find((entry) => entry.sourceClauseId === days.sourceClauseIds[0]);
    expect(coverage?.kind).toBe("split");
    if (coverage?.kind === "split") expect(coverage.parts.map((part) => part.purpose)).toEqual(["advance-base", "advance-days"]);
  });
  it("separates table plan from parallelism and retains conditional maximum/start", async () => {
    const document = (await prepare()).document!, plan = document.questions.find((question) => question.kind === "stage-plan")!, parallel = document.questions.find((question) => question.kind === "stage-parallelism")!;
    expect(plan.targetBlockIds.some((id) => parallel.targetBlockIds.includes(id))).toBe(false);
    const planText = blocks(document).filter((block) => plan.targetBlockIds.includes(block.id)).map(text).join("\n");
    expect(planText).toContain("10 рабочих дней"); expect(planText).not.toContain("Работы ведутся параллельно");
    const rest = blocks(document).filter((block) => !plan.targetBlockIds.includes(block.id) && !parallel.targetBlockIds.includes(block.id)).map(text).join("\n");
    expect(rest).toContain("20 рабочих дней"); expect(rest).toContain("что наступит позднее"); expect(rest).toContain("Ожидание материалов не включается");
  });
  it("resolves contract 4.1 in its namespace, not the technical-task 4.1", async () => {
    const document = (await prepare()).document!, maximum = document.privateAppendix.clauses.find((clause) => clause.quote.startsWith("7.1."))!;
    const ref = document.privateAppendix.references.find((entry) => entry.sourceClauseId === maximum.id && entry.kind === "clause")!;
    expect(ref.scopeHint).toBe("contract"); expect(ref.candidateClauseIds).toHaveLength(1);
    const target = document.privateAppendix.clauses.find((clause) => clause.id === ref.candidateClauseIds[0])!;
    expect(target.quote).toContain("что наступит позднее"); expect(ref.localTargetIds).toHaveLength(1);
    expect(blocks(document).some((block) => block.kind === "paragraph" && block.content.some((part) => part.kind === "local-ref" && part.targetId === ref.localTargetIds![0]))).toBe(true);
  });
  it("retains OR and separate primary/repeat acceptance targets", async () => {
    const document = (await prepare()).document!, final = document.privateAppendix.clauses.find((clause) => clause.quote.startsWith("3.3."))!;
    const refs = document.privateAppendix.references.filter((ref) => ref.sourceClauseId === final.id && ref.kind === "clause");
    expect(refs.map((ref) => ref.labels)).toEqual([["4.2.2"], ["4.2.5"]]); expect(refs.every((ref) => ref.localTargetIds?.length === 1)).toBe(true);
    expect(blocks(document).map(text).join("\n")).toContain("после акта или истечения срока отказа");
    expect(document.questions.some((question) => question.kind === "source-reference")).toBe(true);
  });
  it("retains unclassified material instead of approving its exclusion", async () => {
    const document = (await prepare()).document!, clause = document.privateAppendix.clauses.find((entry) => entry.quote.startsWith("Неизвестное"))!;
    expect(clause.classification).toBe("unclassified"); expect(document.privateAppendix.coverage.find((entry) => entry.sourceClauseId === clause.id)?.kind).toBe("unmapped");
  });
  it("deduplicates only identical clauses in the same owner namespace", async () => {
    const input = source(), duplicate = input.fragments![16]; input.fragments!.splice(17, 0, { ...duplicate, id: "repeat", locator: "Повтор" }); input.text = input.fragments!.map((fragment) => fragment.text).join("\n");
    const document = (await prepare([input])).document!, duplicates = document.privateAppendix.clauses.filter((clause) => clause.quote === duplicate.text);
    expect(duplicates).toHaveLength(2); expect(document.privateAppendix.coverage.filter((entry) => duplicates.some((clause) => clause.id === entry.sourceClauseId) && entry.kind === "deduplicated")).toHaveLength(1);
  });
  it("does not infer content from filenames", async () => {
    const first = source(), second = source(); second.name = "Никаких услуг и цен здесь не обещано.txt";
    const meaning = (document: ProposalCommercialDocumentV1) => JSON.parse(JSON.stringify(document.body, (key, value: unknown) => key === "id" ? undefined : value));
    // A renamed input has a new identity/fingerprint, but identical content.
    expect(meaning((await prepare([first])).document!)).toEqual(meaning((await prepare([second])).document!));
  });
  it.each(["incomplete", "ocr", "multiple", "no-heading"] as const)("returns review-only for %s input without manufacturing ownership", async (kind) => {
    const input = source(); let inputs = [input];
    if (kind === "incomplete") input.coverage!.complete = false;
    if (kind === "ocr") input.coverage!.requiresOcr = true;
    if (kind === "multiple") inputs = [input, { ...source(), id: "other" }];
    if (kind === "no-heading") { input.fragments![0].text = "Набор заметок"; input.fragments![11].text = "Продолжение"; input.text = input.fragments!.map((fragment) => fragment.text).join("\n"); }
    const result = await prepare(inputs); expect(result.document, JSON.stringify(result.issues)).toBeDefined(); expect(result.issues.some((issue) => issue.code === "commercial-unsupported-envelope")).toBe(true);
    expect(result.document!.body.sections.flatMap((section) => section.blocks)).toEqual([]);
    expect(result.document!.privateAppendix.clauses).toHaveLength(inputs.reduce((sum, item) => sum + item.fragments!.length, 0));
  });
  it("rejects an old snapshot instead of binding current values to it", async () => {
    const result = await prepareCommercialDocument({ sources: [source()], sourceSnapshotKey: await commercialFingerprint("not the actual selected snapshot") });
    expect(result.document).toBeUndefined(); expect(result.issues[0].code).toBe("commercial-stale-source");
  });
  it("does not truncate an oversized source quote", async () => {
    const input = source(); input.fragments![2].text = "x".repeat(20001); input.text = input.fragments!.map((fragment) => fragment.text).join("\n");
    const before = input.fragments![2].text, result = await prepare([input]);
    expect(result.document).toBeUndefined(); expect(result.issues.some((issue) => issue.severity === "error")).toBe(true); expect(input.fragments![2].text).toBe(before);
  });
  it("does not uniquely bind duplicate labels in a namespace", async () => {
    const document = (await prepare()).document!, original = document.privateAppendix.clauses.find((clause) => clause.printedLabel === "4.1" && document.privateAppendix.containers.find((container) => container.id === clause.containerId)?.kind === "contract")!;
    const copied = { ...original, id: "duplicate-label" }, refs = collectCommercialReferences([...document.privateAppendix.clauses, copied], document.privateAppendix.containers);
    expect(refs.some((ref) => ref.labels?.includes("4.1") && ref.candidateClauseIds.length === 2)).toBe(true);
  });
  it("governing-document answers own separate definition blocks", async () => {
    const document = (await prepare()).document!, ordinary = document.questions.filter((question) => question.kind !== "source-reference").flatMap((question) => question.targetBlockIds);
    const definitions = document.questions.filter((question) => question.kind === "source-reference" && question.sourceReferenceIds.every((id) => document.privateAppendix.references.some((ref) => ref.id === id && ["document", "event"].includes(ref.kind))));
    expect(definitions.length).toBeGreaterThan(0);
    for (const question of definitions) { expect(question.targetBlockIds).toHaveLength(1); expect(question.targetBlockIds[0]).toMatch(/^definition-/); expect(ordinary).not.toContain(question.targetBlockIds[0]); }
  });
  it("exposes only explicit source stages, not an inferred missing stage", async () => {
    const document = (await prepare()).document!, catalog = collectCommercialStageCatalog(document);
    expect(catalog.issues).toEqual([]); expect(catalog.stages.map((stage) => stage.printedNumber)).toEqual(["1", "2"]);
    expect(catalog.stages[0].duration).toEqual({ count: "10", dayKind: "business" });
    expect(catalog.stages[1].durationText).toContain("параллельно"); expect(catalog.stages.every((stage) => stage.id === stage.sourceClauseId)).toBe(true);
  });
  it("removes only the leading source label and records the presentation transform", async () => {
    const document = (await prepare()).document!, clause = document.privateAppendix.clauses.find((entry) => entry.quote.startsWith("7.1."))!;
    const coverage = document.privateAppendix.coverage.find((entry) => entry.sourceClauseId === clause.id)!;
    expect(coverage.kind).toBe("projected");
    if (coverage.kind === "projected") { expect(coverage.presentation).toEqual([{ kind: "leading-label", span: { startUtf16: 0, endUtf16: 5 } }]); const block = blocks(document).find((entry) => entry.id === coverage.targetBlockIds[0])!; expect(text(block)).toMatch(/^Максимальный/); }
    expect(clause.quote).toMatch(/^7\.1\./); expect(validateCommercialSourceProjection(document)).toEqual([]);
  });
  it("does not accept the receipt label as proof after arbitrary body edits", async () => {
    const document = structuredClone((await prepare()).document!), clause = document.privateAppendix.clauses.find((entry) => entry.quote.includes("Цепочка прав"))!;
    const coverage = document.privateAppendix.coverage.find((entry) => entry.sourceClauseId === clause.id)!;
    if (coverage.kind !== "literal") throw new Error("fixture expected a literal table row");
    const block = blocks(document).find((entry) => entry.id === coverage.targetBlockIds[0])!;
    if (block.kind !== "table") throw new Error("fixture expected table");
    block.rows[1][1] = [{ kind: "text", text: "Выполним все исправления без ограничений." }];
    expect(validateCommercialSourceProjection(document).some((issue) => issue.code === "commercial-source-projection")).toBe(true);
  });
  it("does not bless a local reference redirected to an unrelated body block", async () => {
    const document = structuredClone((await prepare()).document!), ref = document.privateAppendix.references.find((entry) => entry.localTargetIds?.length)!;
    ref.localTargetIds = ["section-scope"];
    expect(validateCommercialSourceProjection(document).some((issue) => /не ведёт/.test(issue.message))).toBe(true);
  });
  it("does not lose an ambiguity by deleting its private reference entry", async () => {
    const document = structuredClone((await prepare()).document!);
    const unused = document.privateAppendix.references.findIndex((ref) => !document.questions.some((question) => question.sourceReferenceIds.includes(ref.id)) && !document.privateAppendix.coverage.some((entry) => entry.kind === "projected" && entry.referenceIds?.includes(ref.id)));
    expect(unused).toBeGreaterThanOrEqual(0); document.privateAppendix.references.splice(unused, 1);
    expect(validateCommercialSourceProjection(document).some((issue) => issue.code === "commercial-source-reference-inventory")).toBe(true);
  });
  it("cannot classify away a material source fact with a private-context reason", async () => {
    const document = structuredClone((await prepare()).document!), clause = document.privateAppendix.clauses.find((entry) => entry.quote.includes("Цепочка прав"))!;
    clause.roles = []; clause.classification = "legal-context";
    const index = document.privateAppendix.coverage.findIndex((entry) => entry.sourceClauseId === clause.id);
    document.privateAppendix.coverage[index] = { sourceClauseId: clause.id, kind: "private-context", reason: "Просто внутреннее" };
    expect(validateCommercialSourceProjection(document).some((issue) => /нельзя исключить/.test(issue.message))).toBe(true);
  });
});
