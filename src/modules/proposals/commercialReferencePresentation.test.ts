import { describe, expect, it, vi } from "vitest";
import { taskSourceSnapshotKey } from "../intelligence/taskSourceIdentity";
import { createCommercialReferencePresenter } from "./commercialReferencePresentation";
import { prepareCommercialDocument } from "./commercialPreparation";
import { projectCommercialBodyPublic } from "./commercialPublic";
import type { ProposalCommercialDocumentV1 } from "./commercialDocument";
import * as documentFunctions from "./commercialDocument";

async function fixture() {
  const lines = ["Договор", "1. Предмет договора", "1.1. Исполнитель оказывает комплекс услуг по анализу учебной системы.",
    "2. Состав оказываемых услуг", "2.1. Проверка выполняется в соответствии с ТЗ.",
    "3. Стоимость услуг и порядок расчётов", "3.1. Стоимость услуг составляет 1000,00 рублей без НДС.",
    "3.2. Аванс 20 процентов от суммы, указанной в п. 3.1 Договора, в течение 5 дней после подписания Договора.",
    "4. Срок оказания услуг", "4.1. Срок составляет 10 рабочих дней от подписания Договора.",
    "Приложение № 1", "к Договору", "Техническое задание № 1", "1. Предмет договора",
    "1.1. Исполнитель оказывает комплекс услуг по проверке учебной системы согласно Договору.",
    "2. Состав оказываемых услуг", "2.1. Анализ документации выполняется по настоящему ТЗ.",
    "3. Итоговые материалы и результат оказания услуг", "3.1. Отчёт предоставляется в соответствии с Договором."];
  const source = { id: "PRIVATE-source", name: "/Users/PRIVATE/source.docx", text: lines.join("\n"), fragments: lines.map((text, index) => ({ id: `PRIVATE-fragment-${index}`, locator: `PRIVATE-locator-${index}`, text })), coverage: { complete: true, requiresOcr: false } };
  const result = await prepareCommercialDocument({ sources: [source], sourceSnapshotKey: await taskSourceSnapshotKey([source]) });
  expect(result.document).toBeDefined();
  return structuredClone(result.document!);
}
const presenter = (doc: ProposalCommercialDocumentV1) => createCommercialReferencePresenter({ appendix: doc.privateAppendix, document: doc, anchors: projectCommercialBodyPublic(doc.body).anchors });

describe("closed reference presentation for UI and public review", () => {
  it("distinguishes all four governing directions by subject and next action, retaining every owned reference", async () => {
    const doc = await fixture(), before = structuredClone(doc), present = presenter(doc);
    const definitions = doc.questions.filter(question => question.kind === "source-reference" && question.sectionId === "section-definitions");
    expect(definitions).toHaveLength(4);
    const shown = definitions.map(present);
    expect(new Set(shown.map(value => value.caption)).size).toBe(4);
    expect(new Set(shown.map(value => value.nextAction)).size).toBe(4);
    expect(shown.map(value => value.action).sort()).toEqual(["define-contract", "define-task", "identify-contract-from-task", "identify-task-from-contract"].sort());
    shown.forEach((value, index) => {
      expect(value.status).toBe("checked-reference-locations");
      expect(value.referenceCount).toBe(definitions[index].sourceReferenceIds.length);
      expect(value.context).toContain(`Ссылок в вопросе: ${value.referenceCount}.`);
      expect(value.locatedReferenceCount).toBeGreaterThan(0);
      expect(value.affectedPublicAnchors.every(anchor => /^s\d+b\d+$/u.test(anchor))).toBe(true);
      expect(value.affectedPublicAnchors.some(anchor => definitions[index].targetBlockIds.some(id => projectCommercialBodyPublic(doc.body).anchors.get(id) === anchor))).toBe(false);
    });
    expect(shown.find(value => value.action === "identify-task-from-contract")!.topics).toContain("scope");
    expect(shown.find(value => value.action === "define-contract")!.topics).toEqual(expect.arrayContaining(["payment", "schedule"]));
    expect(shown.find(value => value.action === "identify-contract-from-task")!.topics).toContain("deliverables");
    expect(JSON.stringify(shown)).not.toMatch(/PRIVATE|\/Users|sha256:|fragment-|clause-|container-|1000/);
    expect(doc).toEqual(before); expect(doc.decisions).toEqual([]);
  });

  it("keeps numeric original-price caution separate from body price, advance approval and governing-document questions", async () => {
    const doc = await fixture(), present = presenter(doc), numeric = doc.questions.find(question => question.kind === "source-reference" && question.sourceReferenceIds.some(id => doc.privateAppendix.references.find(reference => reference.id === id)?.printed === "3.1"))!;
    expect(numeric).toBeDefined(); const shown = present(numeric);
    expect(shown.action).toBe("review-price-reference"); expect(shown.context).toContain("Пункт 3.1 исходного договора, не пункт этого КП");
    expect(shown.nextAction).toContain("Применение исходной цены и база аванса проверяются отдельно");
    expect(shown.topics).toEqual(["payment"]); expect(JSON.stringify(shown)).not.toMatch(/1000|НДС|net|gross/);
    expect(doc.decisions).toEqual([]);
  });

  it.each(["reference-span", "foreign-owner", "duplicate-reference", "question-owner", "excluded-owner", "foreign-document", "unknown-source-kind", "root-kind-swap", "child-kind-swap", "child-parent-swap"] as const)("uses a generic fallback for %s, without copying private metadata", async variant => {
    const doc = await fixture(), question = doc.questions.find(question => question.kind === "source-reference" && question.sectionId === "section-definitions")!;
    const reference = doc.privateAppendix.references.find(reference => reference.id === question.sourceReferenceIds[0])!;
    if (variant === "reference-span") reference.span.startUtf16++;
    if (variant === "foreign-owner") doc.privateAppendix.containers.find(container => container.id === doc.privateAppendix.clauses.find(clause => clause.id === reference.sourceClauseId)!.containerId)!.sourceId = "PRIVATE-foreign-source";
    if (variant === "duplicate-reference") doc.privateAppendix.references.push(structuredClone(reference));
    if (variant === "question-owner") question.sourceClauseIds = ["PRIVATE-other-clause"];
    if (variant === "excluded-owner") doc.privateAppendix.clauses.find(clause => clause.id === reference.sourceClauseId)!.classification = "excluded-material";
    if (variant === "unknown-source-kind") doc.privateAppendix.containers.find(container => container.id === doc.privateAppendix.clauses.find(clause => clause.id === reference.sourceClauseId)!.containerId)!.kind = "unknown";
    if (variant === "root-kind-swap") doc.privateAppendix.containers.find(container => !container.parentId)!.kind = "technical-task";
    if (variant === "child-kind-swap") doc.privateAppendix.containers.find(container => container.parentId)!.kind = "contract";
    if (variant === "child-parent-swap") doc.privateAppendix.containers.find(container => container.parentId)!.parentId = doc.privateAppendix.containers.find(container => container.parentId)!.id;
    const present = variant === "foreign-document" ? createCommercialReferencePresenter({ appendix: structuredClone(doc.privateAppendix), document: doc }) : presenter(doc);
    const shown = present(question);
    expect(shown.status).toBe("unknown"); expect(shown.caption).toBe("Смысл исходных ссылок"); expect(shown.topics).toEqual([]); expect(shown.affectedPublicAnchors).toEqual([]);
    expect(JSON.stringify(shown)).not.toMatch(/PRIVATE|\/Users|sha256:/);
  });

  it("does not describe an edited public paragraph as a fresh exact source location", async () => {
    const doc = await fixture(), question = doc.questions.find(question => question.kind === "source-reference" && presenter(doc)(question).action === "identify-task-from-contract")!;
    const sourceId = doc.privateAppendix.references.find(reference => reference.id === question.sourceReferenceIds[0])!.sourceClauseId;
    const coverage = doc.privateAppendix.coverage.find(entry => entry.sourceClauseId === sourceId)!;
    if (!("targetBlockIds" in coverage)) throw new Error("fixture coverage");
    const block = doc.body.sections.flatMap(section => section.blocks).find(block => coverage.targetBlockIds.includes(block.id))!;
    if (block.kind !== "paragraph") throw new Error("fixture paragraph");
    block.content = [{ kind: "text", text: "Самостоятельная редакция пользователя." }]; doc.revision++;
    const shown = presenter(doc)(question);
    expect(shown.topics).toEqual([]); expect(shown.locatedReferenceCount).toBe(0); expect(shown.affectedPublicAnchors).toEqual([]);
    expect(shown.context).toContain("остальные связи ещё требуют проверки");
    expect(shown.context).not.toMatch(/Связанные разделы проекта|неизменённая копия|точная копия|готов к отправке/);
  });

  it("rejects a forged existing-body target association and does not use arbitrary public headings as safe topic text", async () => {
    const doc = await fixture(), question = doc.questions.find(question => question.kind === "source-reference" && presenter(doc)(question).action === "identify-task-from-contract")!;
    const reference = doc.privateAppendix.references.find(reference => reference.id === question.sourceReferenceIds[0])!, entry = doc.privateAppendix.coverage.find(entry => entry.sourceClauseId === reference.sourceClauseId)!;
    if (!("targetBlockIds" in entry)) throw new Error("fixture coverage");
    entry.targetBlockIds = [doc.body.sections.find(section => section.kind === "payment")!.blocks[0].id];
    doc.body.sections.forEach(section => { section.title = "/Users/PRIVATE/forged-heading"; });
    const shown = presenter(doc)(question);
    expect(shown.topics).toEqual([]); expect(shown.affectedPublicAnchors).toEqual([]); expect(JSON.stringify(shown)).not.toMatch(/PRIVATE|\/Users/);
  });

  it("does not promote a changed section category or custom public title into a new source topic", async () => {
    const doc = await fixture(), find = presenter(doc), question = doc.questions.find(question => question.kind === "source-reference" && find(question).action === "identify-task-from-contract")!;
    const section = doc.body.sections.find(section => section.kind === "scope")!; section.kind = "payment";
    expect(presenter(doc)(question).topics).toEqual([]);
    section.kind = "scope"; section.title = "/Users/PRIVATE/custom-public-heading";
    const shown = presenter(doc)(question); expect(shown.topics).toEqual([]); expect(shown.locatedReferenceCount).toBeGreaterThan(0); expect(JSON.stringify(shown)).not.toMatch(/PRIVATE|\/Users/);
  });

  it("provides a safe compatible context without a document, but never claims body locations and keeps returned values immutable", async () => {
    const doc = await fixture(), question = doc.questions.find(question => question.kind === "source-reference")!, present = createCommercialReferencePresenter({ appendix: doc.privateAppendix });
    const shown = present(question); expect(shown.status).toBe("checked-reference-locations"); expect(shown.affectedPublicAnchors).toEqual([]); expect(shown.topics).toEqual([]);
    expect(present(question)).toBe(shown); expect(Object.isFrozen(shown)).toBe(true); expect(Object.isFrozen(shown.topics)).toBe(true);
    const noSource = createCommercialReferencePresenter({})(question); expect(noSource.status).toBe("unknown"); expect(noSource.context).toBe("");
  });

  it("indexes captured question ownership once rather than reserializing prior questions for every label", async () => {
    const doc = await fixture(), template = doc.questions.find(question => question.kind === "source-reference")!;
    doc.questions = Array.from({ length: 250 }, (_, index) => ({ ...template, id: `question-index-${index}` }));
    const canonical = vi.spyOn(documentFunctions, "commercialCanonicalJson");
    try {
      const present = presenter(doc), output = doc.questions.map(present);
      expect(output.every(value => value.status === "checked-reference-locations")).toBe(true);
      const count = () => canonical.mock.calls.filter(([value]) => value && typeof value === "object" && "id" in value && typeof value.id === "string" && value.id.startsWith("question-index-")).length;
      expect(count()).toBe(500); // 250 captured keys + 250 requested keys.
      doc.questions.forEach(question => expect(present(question)).toBe(output[doc.questions.indexOf(question)]));
      expect(count()).toBe(750); // Cached labels never rescan the captured set.
    } finally { canonical.mockRestore(); }
  });
});
