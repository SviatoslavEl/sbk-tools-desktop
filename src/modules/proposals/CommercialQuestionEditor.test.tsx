import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommercialQuestionEditor, type CommercialQuestionEditorProps } from "./CommercialQuestionEditor";
import { commercialFingerprint, commercialQuestionSourceFingerprint, type CommercialTermQuestion, type CommercialTermQuestionKind, type ProposalCommercialDocumentV1 } from "./commercialDocument";
import { applyTermDecision, validateTermAnswer } from "./commercialDecisions";

// Real component callbacks/hooks, not a native DOM/layout claim. The actual
// decision gate is exercised in the payment preview/Apply integration below.
const hooks = vi.hoisted(() => ({ index: 0, changed: false, slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>, effects: [] as Array<() => void> }));
vi.mock("react", async (original) => {
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return { ...await original<typeof import("react")>(),
    useState: (initial: unknown) => { const index = hooks.index++; if (!hooks.slots[index]) hooks.slots[index] = { value: typeof initial === "function" ? initial() : initial }; return [hooks.slots[index].value, (next: unknown) => { const value = typeof next === "function" ? next(hooks.slots[index].value) : next; if (!Object.is(value, hooks.slots[index].value)) { hooks.slots[index].value = value; hooks.changed = true; } }]; },
    useRef: (initial: unknown) => { const index = hooks.index++; if (!hooks.slots[index]) hooks.slots[index] = { value: { current: initial } }; return hooks.slots[index].value; },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = hooks.index++, old = hooks.slots[index]; if (old && same(old.deps, deps)) return; hooks.slots[index] = { ...old, deps }; hooks.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); hooks.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; }); },
  };
});
type Props = { children?: ReactNode; disabled?: boolean; value?: unknown; checked?: boolean; "aria-label"?: string; "data-issue-paths"?: string; role?: string; onClick?: () => unknown; onChange?: (event: { target: { value: string; checked?: boolean } }) => void };
const nodes = (node: ReactNode): Array<{ type: unknown; props: Props }> => Array.isArray(node) ? node.flatMap(nodes) : isValidElement<Props>(node) ? [{ type: node.type, props: node.props }, ...nodes(node.props.children)] : [];
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("") : isValidElement<Props>(node) ? text(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "";
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { hooks.index = 0; hooks.changed = false; hooks.slots = []; hooks.effects = []; });

async function fixture(kind: CommercialTermQuestionKind = "advance-days"): Promise<{ doc: ProposalCommercialDocumentV1; question: CommercialTermQuestion }> {
  const quote = kind === "source-reference" ? "Срок исчисляется с момента подписания Договора." : "Аванс перечисляется не позднее 5 дней с момента подписания документа.";
  const appendix: ProposalCommercialDocumentV1["privateAppendix"] = { version: 1, documentId: "document", sourceSnapshotKey: await commercialFingerprint("source-set"), extraction: { complete: true, requiresOcr: false, visualAssessment: "unassessed" },
    containers: [{ id: "container", sourceId: "source", kind: "contract", heading: "Договор" }],
    clauses: [{ id: "clause", containerId: "container", sourceId: "source", sourceName: "Синтетический источник", locator: "Пункт 3", quote, quoteHash: await commercialFingerprint(quote), roles: ["payment"], classification: "commercial" }],
    references: kind === "source-reference" ? [{ id: "reference", sourceClauseId: "clause", span: { startUtf16: quote.indexOf("Договора"), endUtf16: quote.indexOf("Договора") + "Договора".length }, printed: "Договора", kind: "document", candidateClauseIds: [] }] : [],
    coverage: [{ sourceClauseId: "clause", kind: "literal", targetBlockIds: ["answer-block"] }],
  };
  const question: CommercialTermQuestion = { id: "question", kind, sectionId: "answer-section", targetBlockIds: ["answer-block"], sourceClauseIds: ["clause"], sourceReferenceIds: appendix.references.map((ref) => ref.id), message: "Уточните конкретное условие", material: true, dependencyFingerprint: await commercialQuestionSourceFingerprint(appendix, { kind, sourceClauseIds: ["clause"], sourceReferenceIds: appendix.references.map((ref) => ref.id) }) };
  const doc: ProposalCommercialDocumentV1 = { version: 1, revision: 1, body: { version: 1, sections: [
    { id: "answer-section", kind: kind === "source-reference" ? "definitions" : "payment", title: "Уточняемое условие", blocks: [{ id: "answer-block", kind: "paragraph", style: "body", content: [{ kind: "text", text: quote }] }] },
    { id: "scope", kind: "scope", title: "Состав", blocks: [{ id: "scope-block", kind: "paragraph", style: "body", content: [{ kind: "text", text: "Согласованный состав работ" }] }] },
  ] }, privateAppendix: appendix, questions: [question], decisions: [] };
  return { doc, question };
}
async function stageFixture() {
  const { doc, question } = await fixture("stage-plan");
  const texts = ["Этап\tОписание\tСрок\tРезультат", "Этап 1. Анализ\tПроверка документации\t10 рабочих дней\tОтчёт", "Этап 2. Обсуждение\tВстреча по результатам\tПо согласованию\tПротокол"];
  doc.privateAppendix.clauses = await Promise.all(texts.map(async (quote, index) => ({ id: `stage-clause-${index}`, containerId: "container", sourceId: "source", sourceName: "Исходный план", locator: `Строка ${index + 1}`, quote, quoteHash: await commercialFingerprint(quote), roles: ["schedule" as const], classification: index === 0 ? "structural" as const : "commercial" as const })));
  doc.privateAppendix.references = [];
  doc.privateAppendix.coverage = [{ sourceClauseId: "stage-clause-0", kind: "private-context", reason: "Заголовки таблицы" }, { sourceClauseId: "stage-clause-1", kind: "literal", targetBlockIds: ["stage-table"] }, { sourceClauseId: "stage-clause-2", kind: "literal", targetBlockIds: ["stage-table"] }];
  doc.body.sections = [{ id: "schedule", kind: "schedule", title: "Этапы", blocks: [{ id: "stage-table", kind: "table", columns: ["Этап", "Состав", "Срок", "Результат"], rows: [[[{ kind: "text", text: "Этап 1" }], [{ kind: "text", text: "Документация" }], [{ kind: "text", text: "10 рабочих дней" }], [{ kind: "text", text: "Отчёт" }]]] }] }];
  Object.assign(question, { sectionId: "schedule", targetBlockIds: ["stage-table"], sourceClauseIds: ["stage-clause-1", "stage-clause-2"], sourceReferenceIds: [] });
  question.dependencyFingerprint = await commercialQuestionSourceFingerprint(doc.privateAppendix, question);
  return { doc, question };
}
async function setup(kind: CommercialTermQuestionKind = "advance-days", seed?: Awaited<ReturnType<typeof fixture>>) {
  const initial = seed || await fixture(kind), onApply = vi.fn<CommercialQuestionEditorProps["onApply"]>().mockResolvedValue(true), dirty = vi.fn();
  let props: CommercialQuestionEditorProps = { ...initial, onApply, onDirtyChange: dirty }, tree: ReactNode;
  const render = () => { for (let turn = 0; turn < 20; turn++) { hooks.index = 0; hooks.changed = false; tree = CommercialQuestionEditor(props); for (const effect of hooks.effects.splice(0)) effect(); if (!hooks.changed) return tree; } throw new Error("render did not settle"); };
  const find = (predicate: (node: { type: unknown; props: Props }) => boolean) => { const result = nodes(render()).find(predicate); if (!result) throw new Error("node not found"); return result.props; };
  const field = (label: string) => find((node) => node.props["aria-label"] === label);
  const button = (label: string) => find((node) => node.type === "button" && text(node.props.children) === label);
  const change = (label: string, value: string) => { field(label).onChange!({ target: { value } }); render(); };
  const check = (label: string, checked = true) => { field(label).onChange!({ target: { value: "", checked } }); render(); };
  const click = async (label: string) => { await button(label).onClick!(); render(); };
  render();
  return { get props() { return props; }, set props(value: CommercialQuestionEditorProps) { props = value; }, render, field, button, change, check, click, onApply, dirty, text: () => text(render()), unmount: () => hooks.slots.forEach((slot) => slot.cleanup?.()) };
}

describe("concrete commercial question forms", () => {
  it("names every unresolved dependency by its distinct question, section and target without changing the gate or source question", async () => {
    const seed = await fixture(), plan = { ...seed.question, id: "question-stage-plan-fixture", kind: "stage-plan" as const, sectionId: "scope", targetBlockIds: ["scope-block"] }, parallel = { ...seed.question, id: "question-stage-parallelism-fixture", kind: "stage-parallelism" as const };
    seed.doc.questions.push(plan, parallel);
    const original = structuredClone(seed.doc), ui = await setup("advance-days", seed);
    ui.props = { ...ui.props, currentState: { question: seed.question, sourceCurrent: true, status: "blocked", dependencyFingerprint: seed.question.dependencyFingerprint, issues: [{ code: "commercial-upstream-unresolved", path: "questions.question", message: `Сначала рассмотрите связанные вопросы: ${plan.id}, ${parallel.id}, question-stage-plan-missing.`, severity: "error" }] } };
    const shown = ui.text();
    expect(shown).toContain("Вопрос 2: Согласованный план этапов — раздел 2 «Состав», пункт 2.1");
    expect(shown).toContain("Вопрос 3: Последовательность и параллельность — раздел 1 «Уточняемое условие», пункт 1.1");
    expect(shown).toContain("связанный вопрос, который сейчас не найден"); expect(shown).not.toContain("question-stage-");
    expect(shown).toContain("Сначала устраните связанные ошибки");
    expect(ui.field("Вопрос 1: Срок перечисления аванса — раздел 1 «Уточняемое условие», пункт 1.1")).toBeDefined();
    expect(shown).toContain(seed.question.message); expect(ui.props.doc).toEqual(original); expect(ui.onApply).not.toHaveBeenCalled();
  });
  it("groups only exact issue messages while preserving every original issue path and never calls unanswered questions applied decisions", async () => {
    const ui = await setup(), question = ui.props.question;
    ui.props = { ...ui.props, currentState: { question, sourceCurrent: true, status: "blocked", dependencyFingerprint: question.dependencyFingerprint, issues: [
      { code: "commercial-decision-target-overlap", path: "questions.question", message: "Несколько решений затрагивают одни и те же пункты.", severity: "error" },
      { code: "commercial-decision-target-overlap", path: "questions.other", message: "Несколько решений затрагивают одни и те же пункты.", severity: "error" },
      { code: "commercial-review", path: "questions.question", message: "Нужно проверить отдельное основание.", severity: "review" },
    ] } };
    expect(ui.text().match(/Несколько вопросов/g)).toHaveLength(1); expect(ui.text()).not.toContain("Несколько решений");
    expect(ui.text()).toContain("Нужно проверить отдельное основание.");
    expect(nodes(ui.render()).find((node) => node.props["data-issue-paths"] === "questions.question questions.other")).toBeDefined();
    expect(ui.props.doc.decisions).toEqual([]); expect(ui.props.currentState?.issues).toHaveLength(3); expect(ui.onApply).not.toHaveBeenCalled();
  });
  it("also replaces technical dependency IDs in preview diagnostics and rejected Apply errors without dropping the warning", async () => {
    const seed = await fixture(), plan = { ...seed.question, id: "question-stage-plan-preview", kind: "stage-plan" as const, sectionId: "scope", targetBlockIds: ["scope-block"] };
    seed.doc.questions.push(plan);
    const ui = await setup("advance-days", seed), message = `Решение пересекает блоки других вопросов: ${plan.id}. Сначала разделите условия; применение не выполнено.`;
    ui.props = { ...ui.props, onPreview: async () => ({ valid: false, issues: [{ code: "commercial-decision-target-overlap", path: "questions.question", message, severity: "error" }], dependencyFingerprint: seed.question.dependencyFingerprint, previewBlocks: [] }) };
    ui.change("Какие дни применяются к авансу", "business"); await ui.click("Посмотреть изменения");
    expect(ui.text()).toContain("Этот вопрос затрагивает пункты других вопросов:"); expect(ui.text()).toContain("Согласованный план этапов — раздел 2 «Состав», пункт 2.1"); expect(ui.text()).not.toContain(plan.id);
    expect(ui.text()).toContain("применение не выполнено"); expect(ui.props.doc.decisions).toEqual([]);
    ui.onApply.mockRejectedValueOnce(new Error(message)); await ui.click("Применить решение");
    expect(ui.text()).not.toContain(plan.id); expect(ui.text()).toContain("Ввод сохранён"); expect(ui.field("Какие дни применяются к авансу").value).toBe("business");
  });
  it("never defaults the advance base/VAT or automatically applies an answer", async () => {
    const ui = await setup("advance-base");
    expect(ui.field("База расчёта аванса").value).toBe(""); expect(ui.field("Порядок учёта НДС в авансе").value).toBe("");
    expect(ui.onApply).not.toHaveBeenCalled(); expect(ui.dirty.mock.calls).toEqual([[false]]);
    await ui.click("Применить решение"); expect(ui.onApply).not.toHaveBeenCalled(); expect(ui.text()).toContain("Выберите отдельно");
    ui.change("База расчёта аванса", "net"); ui.change("Порядок учёта НДС в авансе", "additional");
    await ui.click("Применить решение"); expect(ui.onApply).toHaveBeenCalledWith({ kind: "advance-base", base: "net", vatTreatment: "additional" }); expect(ui.dirty).toHaveBeenLastCalledWith(false);
  });
  it("uses the real gate for specific payment preview and only an explicit owner Apply installs a decision", async () => {
    const ui = await setup();
    ui.props = { ...ui.props, onApply: async (answer) => {
      const { doc, question } = ui.props, validation = await validateTermAnswer(doc, question.id, answer);
      if (!validation.valid) return false;
      const result = await applyTermDecision(doc, { questionId: question.id, answer, expectedRevision: doc.revision, expectedDependencyFingerprint: validation.dependencyFingerprint, decisionId: "user-decision", appliedAt: "2035-01-01T12:00:00Z" });
      ui.props = { ...ui.props, doc: result.document, question: result.document.questions[0] }; return true;
    } };
    ui.change("Какие дни применяются к авансу", "business");
    await ui.click("Посмотреть изменения"); expect(ui.props.doc.decisions).toEqual([]); expect(ui.text()).toContain("5 рабочих дней"); expect(ui.text()).toContain("ещё не применены");
    await ui.click("Применить решение"); expect(ui.props.doc.decisions).toHaveLength(1); expect(JSON.stringify(ui.props.doc.body)).toContain("5 рабочих дней"); expect(ui.dirty).toHaveBeenLastCalledWith(false);
  });
  it("keeps false/throw owner rejections and oversized text intact without implicit approval or truncation", async () => {
    const ui = await setup("source-reference"); ui.change("Как разрешить исходные ссылки", "governing-document"); ui.change("Название действующего документа", "Согласованное задание");
    const explanation = "Документ и условие его подписания определяются отдельно сторонами."; ui.change("Определение документа и события", explanation);
    ui.onApply.mockResolvedValueOnce(false); await ui.click("Применить решение"); expect(ui.field("Определение документа и события").value).toBe(explanation); expect(ui.dirty).toHaveBeenLastCalledWith(true);
    ui.onApply.mockRejectedValueOnce(new Error("Доступ изменился")); await ui.click("Применить решение"); expect(ui.text()).toContain("Доступ изменился"); expect(ui.field("Определение документа и события").value).toBe(explanation);
    const long = "я".repeat(20001); ui.change("Определение документа и события", long); const calls = ui.onApply.mock.calls.length;
    await ui.click("Применить решение"); expect(ui.onApply).toHaveBeenCalledTimes(calls); expect(ui.field("Определение документа и события").value).toBe(long); expect(ui.text()).toContain("Текст не усечён");
  });
  it("uses only direct source-stage facts, leaves unknown durations/max blank, and never invents an additional stage", async () => {
    const ui = await setup("stage-plan", await stageFixture());
    expect(ui.field("Название этапа 1").value).toBe("Этап 1. Анализ"); expect(ui.field("Срок этапа 1").value).toBe("10"); expect(ui.field("Вид дней этапа 1").value).toBe("business");
    expect(ui.field("Название этапа 2").value).toBe("Этап 2. Обсуждение"); expect(ui.field("Срок этапа 2").value).toBe(""); expect(ui.field("Вид дней этапа 2").value).toBe(""); expect(ui.field("Общий максимальный срок").value).toBe("");
    expect(ui.text()).not.toContain("Этап 3:"); expect(ui.dirty).toHaveBeenLastCalledWith(false);
    await ui.click("Применить решение"); expect(ui.onApply).not.toHaveBeenCalled();
    ui.change("Срок этапа 2", "5"); ui.change("Вид дней этапа 2", "business"); ui.change("Общий максимальный срок", "20"); ui.change("Вид дней общего максимума", "business");
    await ui.click("Добавить этап"); expect(ui.field("Название этапа 3").value).toBe(""); await ui.click("Применить решение"); expect(ui.onApply).not.toHaveBeenCalled();
    await ui.click("Удалить этап 3"); await ui.click("Применить решение");
    expect(ui.onApply.mock.calls[0][0]).toMatchObject({ kind: "stage-plan", maximum: { count: "20", dayKind: "business" }, stages: [{ title: "Этап 1. Анализ", duration: { count: "10", dayKind: "business" } }, { title: "Этап 2. Обсуждение", duration: { count: "5", dayKind: "business" } }] });
    expect(ui.onApply.mock.calls[0][0].kind === "stage-plan" && ui.onApply.mock.calls[0][0].stages).toHaveLength(2);
  });
  it("shows an existing stage prefix only once while retaining the entire distinct source stage titles and qualifiers", async () => {
    const seed = await stageFixture(), second = seed.doc.privateAppendix.clauses.find(clause => clause.id === "stage-clause-2")!;
    second.quote = "Этап 2. Обсуждение при наличии материалов\tВстреча по результатам\t5 рабочих дней; параллельно с этапом 1\tПротокол";
    second.quoteHash = await commercialFingerprint(second.quote);
    const third = "Этап 3. Проверка только после разрешения\tПроверка\t7 рабочих дней; параллельно с этапом 2\tОтчёт";
    seed.doc.privateAppendix.clauses.push({ ...second, id: "stage-clause-3", quote: third, quoteHash: await commercialFingerprint(third) });
    seed.doc.privateAppendix.coverage.push({ sourceClauseId: "stage-clause-3", kind: "literal", targetBlockIds: ["stage-table"] });
    const before = structuredClone(seed.doc), ui = await setup("stage-plan", seed);
    const summaries = nodes(ui.render()).filter(node => node.type === "summary").map(node => text(node.props.children));
    expect(summaries).toContain("Этап 1. Анализ — 10 рабочих дней");
    expect(summaries.some(label => label.includes("Этап 2. Обсуждение при наличии материалов"))).toBe(true);
    expect(summaries.some(label => label.includes("Этап 3. Проверка только после разрешения"))).toBe(true);
    expect(summaries.join(" ")).not.toMatch(/Этап [123]: Этап [123]/);
    expect(ui.field("Название этапа 2").value).toBe("Этап 2. Обсуждение при наличии материалов");
    expect(ui.field("Название этапа 3").value).toBe("Этап 3. Проверка только после разрешения");
    expect(ui.text()).toContain("5 рабочих дней; параллельно с этапом 1"); expect(ui.text()).toContain("7 рабочих дней; параллельно с этапом 2");
    expect(seed.doc).toEqual(before); expect(ui.onApply).not.toHaveBeenCalled(); expect(ui.dirty).toHaveBeenLastCalledWith(false);
  });
  it("prefills a maximum only from an explicit source clause and exposes its complete proof", async () => {
    const seed = await stageFixture(), quote = "Максимальный срок — 20 рабочих дней после получения всех исходных материалов.";
    seed.doc.privateAppendix.clauses.push({ id: "source-maximum", containerId: "container", sourceId: "source", sourceName: "Исходный план", locator: "Общий срок", quote, quoteHash: await commercialFingerprint(quote), roles: ["schedule"], classification: "commercial" });
    seed.doc.body.sections[0].blocks.push({ id: "maximum-block", kind: "paragraph", style: "body", content: [{ kind: "text", text: quote }] });
    seed.doc.privateAppendix.coverage.push({ sourceClauseId: "source-maximum", kind: "literal", targetBlockIds: ["maximum-block"] });
    const ui = await setup("stage-plan", seed);
    expect(ui.field("Общий максимальный срок").value).toBe("20"); expect(ui.field("Вид дней общего максимума").value).toBe("business"); expect(ui.field("Срок этапа 2").value).toBe("");
    expect(ui.text()).toContain(quote); expect(ui.text()).toContain("Исходная формулировка срока: По согласованию"); expect(ui.dirty).toHaveBeenLastCalledWith(false); expect(ui.onApply).not.toHaveBeenCalled();
  });
  it("edits concrete parallel edges, retains conditions across mode changes and refuses removed active stage IDs", async () => {
    const ui = await setup("stage-parallelism"); expect(ui.button("Добавить связь").disabled).toBe(true); await ui.click("Применить решение"); expect(ui.onApply).not.toHaveBeenCalled();
    ui.props = { ...ui.props, activeStages: [{ id: "stage-a", title: "Анализ" }, { id: "stage-b", title: "Проверка" }] };
    await ui.click("Добавить связь"); ui.change("Тип связи 1", "may-overlap"); ui.check("Этапы параллельной связи 1: Анализ"); ui.check("Этапы параллельной связи 1: Проверка"); ui.change("Условие параллельной связи 1", "После предоставления независимых комплектов материалов");
    ui.change("Тип связи 1", "after"); ui.change("Начинающийся этап связи 1", "stage-b"); ui.change("После завершения этапа связи 1", "stage-a"); ui.change("Тип связи 1", "may-overlap");
    expect(ui.field("Условие параллельной связи 1").value).toContain("независимых комплектов");
    ui.props = { ...ui.props, activeStages: [{ id: "stage-a", title: "Анализ" }] }; await ui.click("Применить решение"); expect(ui.onApply).not.toHaveBeenCalled(); expect(ui.text()).toContain("не удалены автоматически");
    ui.props = { ...ui.props, activeStages: [{ id: "stage-a", title: "Анализ" }, { id: "stage-b", title: "Проверка" }] }; await ui.click("Применить решение"); expect(ui.onApply).toHaveBeenCalledWith({ kind: "stage-parallelism", relations: [{ kind: "may-overlap", stageIds: ["stage-a", "stage-b"], conditions: "После предоставления независимых комплектов материалов" }] });
  });
  it("builds protocol milestones with explicit conditions and before/after stage choices", async () => {
    const ui = await setup("boundary-protocol"); ui.props = { ...ui.props, activeStages: [{ id: "prepare", title: "Подготовка" }, { id: "test", title: "Тестирование" }] };
    await ui.click("Добавить контрольную точку"); expect(ui.field("Условие контрольной точки 1").value).toBe(""); expect(ui.text()).toContain("Границы согласованы, письменное разрешение получено"); expect(ui.text()).toContain("похожих слов не подтверждает разрешение"); ui.change("Название контрольной точки 1", "Согласование границ"); ui.change("Условие контрольной точки 1", "Границы утверждены, разрешение получено");
    await ui.click("Применить решение"); expect(ui.onApply).not.toHaveBeenCalled();
    ui.check("До начала этапов, точка 1: Тестирование"); ui.check("После завершения этапов, точка 1: Подготовка"); await ui.click("Применить решение");
    expect(ui.onApply).toHaveBeenCalledWith({ kind: "boundary-protocol", milestones: [{ title: "Согласование границ", condition: "Границы утверждены, разрешение получено", beforeStageIds: ["test"], afterStageIds: ["prepare"] }] });
  });
  it("offers exact body targets, governing definitions and own-block rewrites without a blanket acknowledgement", async () => {
    const ui = await setup("source-reference"); expect(ui.field("Как разрешить исходные ссылки").value).toBe(""); expect(ui.text()).toContain("Синтетический источник"); expect(ui.text()).toContain("Исходная ссылка: Договора");
    ui.change("Как разрешить исходные ссылки", "body-target"); ui.check("Цели исходной ссылки: 2. Состав"); await ui.click("Применить решение"); expect(ui.onApply).toHaveBeenLastCalledWith({ kind: "source-reference", referenceIds: ["reference"], resolution: { kind: "body-target", targetIds: ["scope"] } });
    ui.change("Как разрешить исходные ссылки", "replace-clauses"); ui.change("Новая редакция пункта 1", "Работы начинаются после подписания согласованного задания и получения материалов."); await ui.click("Применить решение"); expect(ui.onApply).toHaveBeenLastCalledWith({ kind: "source-reference", referenceIds: ["reference"], resolution: { kind: "replace-clauses", replacements: [{ blockId: "answer-block", publicText: "Работы начинаются после подписания согласованного задания и получения материалов." }] } });
  });
  it("shows concrete ordinal destinations in preview rather than generic references or private IDs", async () => {
    const ui = await setup("source-reference"); ui.props = { ...ui.props, onPreview: async () => ({ valid: true, issues: [], dependencyFingerprint: `sha256:${"a".repeat(64)}`, previewBlocks: [{ id: "answer-block", kind: "paragraph", style: "body", content: [{ kind: "text", text: "Применяется " }, { kind: "local-ref", targetId: "scope" }, { kind: "text", text: " и " }, { kind: "local-ref", targetId: "scope-block" }] }] }) };
    ui.change("Как разрешить исходные ссылки", "body-target"); ui.check("Цели исходной ссылки: 2. Состав"); await ui.click("Посмотреть изменения");
    expect(ui.text()).toContain("Применяется раздел 2 и пункт 2.1"); expect(ui.text()).not.toContain("[локальная ссылка]"); expect(ui.onApply).not.toHaveBeenCalled();
  });
  it("prevents duplicate pending submissions and preserves dirty input when a revision changes during the request", async () => {
    const ui = await setup(), wait = deferred<boolean>(); ui.onApply.mockReturnValueOnce(wait.promise); ui.change("Какие дни применяются к авансу", "calendar");
    const callback = ui.button("Применить решение").onClick!, first = callback(); callback(); expect(ui.onApply).toHaveBeenCalledOnce();
    ui.props = { ...ui.props, doc: { ...structuredClone(ui.props.doc), revision: 2 } }; ui.render(); expect(ui.field("Какие дни применяются к авансу").value).toBe("calendar");
    wait.resolve(false); await first; expect(ui.text()).toContain("Неприменённый ответ сохранён"); expect(ui.button("Применить решение").disabled).toBe(true); expect(ui.dirty).toHaveBeenLastCalledWith(true);
    await ui.click("Начать заново по текущей редакции"); expect(ui.field("Какие дни применяются к авансу").value).toBe(""); expect(ui.dirty).toHaveBeenLastCalledWith(false);
  });
  it("refreshes untouched source forms after another decision without a reset loop or creating answers", async () => {
    const ui = await setup(); ui.props = { ...ui.props, doc: { ...structuredClone(ui.props.doc), revision: 2 } }; ui.render();
    expect(ui.text()).not.toContain("Неприменённый ответ сохранён"); expect(ui.field("Какие дни применяются к авансу").value).toBe(""); expect(ui.button("Применить решение").disabled).toBe(false); expect(ui.onApply).not.toHaveBeenCalled(); expect(ui.dirty.mock.calls).toEqual([[false]]);
  });
  it("guards real callbacks when disabled and clears only the dirty notification on unmount", async () => {
    const ui = await setup(); ui.change("Какие дни применяются к авансу", "business"); const oldField = ui.field("Какие дни применяются к авансу"), oldApply = ui.button("Применить решение");
    ui.props = { ...ui.props, disabled: true }; ui.render(); oldField.onChange!({ target: { value: "calendar" } }); await oldApply.onClick!();
    expect(ui.field("Какие дни применяются к авансу").value).toBe("business"); expect(ui.onApply).not.toHaveBeenCalled(); expect(ui.button("Применить решение").disabled).toBe(true);
    ui.unmount(); expect(ui.dirty).toHaveBeenLastCalledWith(false);
  });
  it("discards a stale preview result without clearing the user's draft", async () => {
    const ui = await setup(), wait = deferred<Awaited<ReturnType<NonNullable<CommercialQuestionEditorProps["onPreview"]>>>>(); ui.props = { ...ui.props, onPreview: () => wait.promise };
    ui.change("Какие дни применяются к авансу", "business"); const preview = ui.button("Посмотреть изменения").onClick!(); ui.props = { ...ui.props, doc: { ...structuredClone(ui.props.doc), revision: 2 } }; ui.render();
    wait.resolve({ valid: true, issues: [], dependencyFingerprint: `sha256:${"a".repeat(64)}`, previewBlocks: [{ id: "answer-block", kind: "paragraph", style: "body", content: [{ kind: "text", text: "СТАРЫЙ ПРЕДПРОСМОТР" }] }] }); await preview;
    expect(ui.text()).not.toContain("СТАРЫЙ ПРЕДПРОСМОТР"); expect(ui.field("Какие дни применяются к авансу").value).toBe("business"); expect(ui.onApply).not.toHaveBeenCalled();
  });
  it("revokes a displayed financial preview when the owner's price dependency changes without an AST revision", async () => {
    const ui = await setup("advance-base"), dependency = `sha256:${"a".repeat(64)}` as const;
    ui.props = { ...ui.props, currentState: { question: ui.props.question, sourceCurrent: true, dependencyFingerprint: dependency, status: "unresolved", issues: [] }, onPreview: async () => ({ valid: true, issues: [], dependencyFingerprint: dependency, previewBlocks: [{ id: "answer-block", kind: "paragraph", style: "body", content: [{ kind: "text", text: "Аванс: 300 рублей по прежней цене" }] }] }) };
    ui.render(); ui.change("База расчёта аванса", "net"); ui.change("Порядок учёта НДС в авансе", "additional"); await ui.click("Посмотреть изменения"); expect(ui.text()).toContain("300 рублей");
    ui.props = { ...ui.props, currentState: { ...ui.props.currentState!, dependencyFingerprint: `sha256:${"b".repeat(64)}` } }; ui.render();
    expect(ui.text()).not.toContain("300 рублей"); expect(ui.field("База расчёта аванса").value).toBe("net"); expect(ui.button("Применить решение").disabled).toBe(true);
    await ui.click("Применить решение"); expect(ui.onApply).not.toHaveBeenCalled(); expect(ui.dirty).toHaveBeenLastCalledWith(true);
  });
  it("does not treat a replaced callback identity as unmount or emit a false dirty reset", async () => {
    const ui = await setup(); ui.change("Какие дни применяются к авансу", "business"); expect(ui.dirty.mock.calls).toEqual([[false], [true]]);
    const replacement = vi.fn(); ui.props = { ...ui.props, onDirtyChange: replacement }; ui.render();
    expect(ui.dirty.mock.calls).toEqual([[false], [true]]); expect(replacement).not.toHaveBeenCalled();
    ui.props = { ...ui.props, onDirtyChange: (value) => replacement(value) }; ui.render(); expect(replacement).not.toHaveBeenCalled();
    await ui.click("Начать заново по текущей редакции"); expect(replacement.mock.calls).toEqual([[false]]);
    ui.unmount(); expect(replacement.mock.calls).toEqual([[false], [false]]);
  });
});
