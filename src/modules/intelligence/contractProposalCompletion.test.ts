import { describe, expect, it } from "vitest";
import { completeContractProposalFields, createContractProposalProver } from "./contractProposalCompletion";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const source = (): IntelligenceSource => ({ id: "contract-qa", name: "Учебный источник", text: "Не использовать агрегат", fragments: [
  "Договор", 'Исполнитель: ООО «Учебные работы»', 'Заказчик: ООО «Контроль QA»',
  "1. Предмет договора", "1.1. Исполнитель оказывает комплекс услуг по проверке учебной системы, состав которых определён в приложении.",
  "2. Состав оказываемых услуг", "2.1. Анализ документации с сохранением ограничений доступа.", "2.2. Проверка компонентов; SBOM при наличии.",
  "3. Итоговые материалы и результат оказания услуг", "3.1. Отчёт с рисками и рекомендациями.", "3.2. Материалы в DOCX и PDF; встреча по результатам.",
  "4. Стоимость услуг и порядок расчетов", "4.1. Стоимость услуг составляет 12 000,00 рублей, в том числе НДС 22%.",
  "4.2. Аванс 25% в течение 4 календарных дней от подписания.", "4.3. Окончательный расчет в течение 6 рабочих дней от акта или истечения срока отказа.",
  "5. Срок оказания услуг", "5.1. Максимальный срок — 16 рабочих дней после полного аванса или всех материалов, что наступит позднее.",
  "6. Входные данные и условия проведения работ", "6.1. Заказчик предоставляет доступы, материалы и разрешения; репозиторий при наличии.",
  "7. Допущения и ограничения", "7.1. Восстановление архитектуры в объём работ не входит.",
].map((text, index) => ({ id: `paragraph-${index + 1}`, locator: `Абзац ${index + 1}`, text })) });
const card = (fields: IntelligenceItem["fields"] = {}): IntelligenceItem => ({ id: "card-qa", title: "Коммерческое предложение", destination: "proposals", fields, selectedFields: Object.keys(fields), sourceIds: ["contract-qa"], evidence: [] });
const freeze = <T,>(value: T): T => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

describe("whole contract to source-derived proposal preparation", () => {
  it("turns an almost-empty response into a substantive editable aggregate, without invented price, dates or contacts", () => {
    const input = source(), item = card({ title: "Коммерческое предложение" }), before = structuredClone({ input, item }); freeze(input); freeze(item);
    const result = completeContractProposalFields([item], [input], ["proposals"]), prepared = result.items[0];
    expect(result.limited).toBe(false); expect(result.changes.length).toBeGreaterThan(5);
    expect(prepared.fields.title).toBe("КП: проверке учебной системы");
    expect(prepared.fields.lines).toEqual(["проверке учебной системы"]);
    expect((prepared.fields.lineDescriptions as string[])[0]).toContain("2.1. Анализ документации");
    expect((prepared.fields.lineDescriptions as string[])[0]).toContain("2.2. Проверка компонентов; SBOM при наличии.");
    expect((prepared.fields.lineDescriptions as string[])[0]).toContain("3.2. Материалы в DOCX и PDF; встреча");
    expect(prepared.fields.paymentTerms).toContain("или истечения срока отказа");
    expect(prepared.fields.deliveryTerms).toContain("что наступит позднее");
    expect(prepared.fields.deliveryTerms).toContain("не входит");
    expect(prepared.fields.issuerName).toBe('ООО «Учебные работы»'); expect(prepared.fields.recipientName).toBe('ООО «Контроль QA»');
    expect(prepared.fields).not.toHaveProperty("documentDate"); expect(prepared.fields).not.toHaveProperty("validUntil");
    expect(prepared.fields).not.toHaveProperty("contactName"); expect(prepared.fields).not.toHaveProperty("unitPrice");
    expect(JSON.stringify(prepared.fields)).not.toContain("12 000,00");
    expect(result.changes.every((change) => change.requiresReview)).toBe(true); expect({ input, item }).toEqual(before);
  });

  it("creates a source-derived card only for the unambiguous explicit one-direction proposal task", () => {
    const input = source(), result = completeContractProposalFields([], [input], ["proposals"]);
    expect(result.items).toHaveLength(1); expect(result.changes.some((change) => change.kind === "created" && change.field === "record")).toBe(true);
    expect(completeContractProposalFields([], [input], ["contracts", "proposals"]).items).toEqual([]);
    expect(completeContractProposalFields([], [input], ["contracts"]).items).toEqual([]);
    expect(completeContractProposalFields([], [input, { ...input, id: "second" }], ["proposals"]).items).toEqual([]);
    input.coverage = { complete: false, requiresOcr: true };
    expect(completeContractProposalFields([], [input], ["proposals"]).items).toEqual([]);
  });

  it("proves the complete freshly recollected multifragment values, not an arbitrary substring or old prefix", () => {
    const input = source(), prepared = completeContractProposalFields([card()], [input], ["proposals"]).items[0];
    const result = createContractProposalProver([input]).prove(prepared, [prepared]);
    expect([...result!.fields.keys()]).toEqual(expect.arrayContaining(["title", "lines", "lineDescriptions", "introduction", "paymentTerms", "deliveryTerms", "issuerName", "recipientName"]));
    expect(result!.claims.size).toBeGreaterThan(10);
    const changed = { ...prepared, fields: { ...prepared.fields, paymentTerms: `Внеисточниковое обещание.\n${prepared.fields.paymentTerms}` } };
    expect(createContractProposalProver([input]).prove(changed, [changed])!.fields.has("paymentTerms")).toBe(false);
    const missingClaim = { ...prepared, evidence: prepared.evidence!.filter((claim) => claim.field !== "lineDescriptions" || !claim.quote.includes("SBOM")) };
    expect(createContractProposalProver([input]).prove(missingClaim, [missingClaim])!.fields.has("lineDescriptions")).toBe(false);
    input.fragments![7].text = "Изменившийся состав другого источника";
    expect(createContractProposalProver([input]).prove(prepared, [prepared])!.fields.has("lineDescriptions")).toBe(false);
  });

  it("preserves existing positions and their relationships, placing full source scope in a separate conclusion", () => {
    const item = card({ lines: ["Первая услуга", "Вторая услуга"], lineDescriptions: ["Первое описание", "Второе описание"], conclusion: "Существующее заключение" });
    const prepared = completeContractProposalFields([item], [source()], ["proposals"]).items[0];
    expect(prepared.fields.lines).toEqual(item.fields.lines); expect(prepared.fields.lineDescriptions).toEqual(item.fields.lineDescriptions);
    expect(prepared.fields.conclusion).toContain("Существующее заключение"); expect(prepared.fields.conclusion).toContain("SBOM при наличии");
    expect(createContractProposalProver([source()]).prove(prepared, [prepared])!.fields.has("conclusion")).toBe(false);
  });

  it("keeps excluded fields excluded and does not overwrite meaningful model names or private notes", () => {
    const item = card({ title: "Редакторское название", recipientName: "Другой заказчик", internalNote: "PRIVATE QA", paymentTerms: "Существующее исключённое условие" });
    item.selectedFields = ["title", "recipientName", "internalNote"];
    const prepared = completeContractProposalFields([item], [source()], ["proposals"]).items[0];
    expect(prepared.fields.title).toBe(item.fields.title); expect(prepared.fields.recipientName).toBe(item.fields.recipientName);
    expect(prepared.fields.internalNote).toBe("PRIVATE QA"); expect(prepared.selectedFields).not.toContain("paymentTerms");
    expect(JSON.stringify(prepared.fields.deliveryTerms)).not.toContain("PRIVATE QA");
  });

  it("is idempotent and never lets two cards share one inferred document owner", () => {
    const input = source(), first = completeContractProposalFields([card()], [input], ["proposals"]);
    const second = completeContractProposalFields(first.items, [input], ["proposals"]);
    expect(second.items).toEqual(first.items); expect(second.changes).toEqual([]);
    const other = { ...card(), id: "card-other" };
    expect(completeContractProposalFields([card(), other], [input], ["proposals"]).changes).toEqual([]);
    expect(createContractProposalProver([input]).prove(first.items[0], [first.items[0], other])).toBeUndefined();
  });

  it("retains full long source rows and all quote pieces without silently truncating", () => {
    const input = source(); input.fragments![6].text = `2.1. Анализ: ${"обязательная проверка; ".repeat(170)}`;
    const prepared = completeContractProposalFields([card()], [input], ["proposals"]).items[0];
    expect((prepared.fields.lineDescriptions as string[])[0]).toContain(input.fragments![6].text);
    expect(prepared.evidence!.every((claim) => claim.quote.length <= 2000)).toBe(true);
    expect(createContractProposalProver([input]).prove(prepared, [prepared])!.fields.has("lineDescriptions")).toBe(true);
    input.fragments![7].text = "2.2. " + "б".repeat(17_000);
    const stopped = completeContractProposalFields([card()], [input], ["proposals"]);
    expect(stopped.limited).toBe(true); expect(stopped.items).toEqual([card()]); expect(stopped.changes).toEqual([]);
  });
});
