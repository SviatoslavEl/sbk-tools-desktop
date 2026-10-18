import { describe, expect, it } from "vitest";
import { completeContractProposalFields, createContractProposalProver } from "./contractProposalCompletion";
import { runResponsePreparation } from "./responsePreparationWorker";
import { buildIntelligenceResponseSchema } from "./workbenchModel";
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
    expect(prepared.fields.title).toBe("КП по проверке учебной системы");
    expect(prepared.fields.lines).toEqual(["Услуги по проверке учебной системы"]);
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

  it("recovers the exact all-null/sourceIds-empty provider class through the real preparation pipeline", () => {
    const input = source(), schema = buildIntelligenceResponseSchema(["proposals"]) as { properties: { items: { items: { properties: { fields: { properties: Record<string, unknown> } } } } } };
    const fields = Object.fromEntries(Object.keys(schema.properties.items.items.properties.fields.properties).map((key) => [key, null]));
    const raw = JSON.stringify({ items: [{ destination: "proposals", title: "Коммерческое предложение", fields, positions: null, sourceIds: [], evidence: [] }] });
    const request = { revision: 4, raw, sources: [input], destinations: ["proposals"] }, before = structuredClone(request);
    const reply = runResponsePreparation(request);
    expect(reply.failed).toBeUndefined(); expect(reply.prepared?.items).toHaveLength(1);
    const prepared = reply.prepared!.items[0];
    expect(prepared.sourceIds).toEqual([input.id]); expect(prepared.fields.lines).toEqual(["Услуги по проверке учебной системы"]);
    expect(prepared.fields.paymentTerms).toContain("или истечения срока отказа");
    expect((prepared.fields.lineDescriptions as string[])[0]).toContain("SBOM при наличии");
    expect(prepared.proposalSourceParties).toHaveLength(2);
    expect(reply.prepared!.sourcePreparation!.changes.some((change) => change.field === "record" && change.kind === "replaced" && JSON.stringify(change.previousValue) === "[]" && JSON.stringify(change.value) === JSON.stringify([input.id]))).toBe(true);
    expect(reply.prepared!.sourcePreparation!.skipped.some((skip) => skip.reason === "contract-proposal-empty-shell-bound")).toBe(true);
    expect(request).toEqual(before);
  });

  it("retains the empty shell ID and records the source binding without mutating it", () => {
    const input = source(), item = { ...card({ title: "Коммерческое предложение" }), sourceIds: [] }, before = structuredClone(item);
    const prepared = completeContractProposalFields([item], [input], ["proposals"]);
    expect(prepared.items[0].id).toBe(item.id); expect(prepared.items[0].sourceIds).toEqual([input.id]);
    expect(prepared.items[0].fields.lines).toHaveLength(1); expect(item).toEqual(before);
    expect(createContractProposalProver([input]).prove(prepared.items[0], prepared.items)?.fields.has("lineDescriptions")).toBe(true);
  });

  it.each(["meaningful-title", "meaningful-field", "unchecked-field", "zero", "evidence", "multiple-cards", "multiple-documents", "all-directions", "partial-source"])("does not infer an empty-shell owner for %s", (variant) => {
    const input = source(), item = { ...card(), sourceIds: [] }, items = [item], sources = [input];
    let destinations: Array<IntelligenceItem["destination"]> = ["proposals"];
    if (variant === "meaningful-title") item.title = "Аудит другой системы";
    if (variant === "meaningful-field" || variant === "unchecked-field") { item.fields.recipientName = "Иная компания"; item.selectedFields = variant === "unchecked-field" ? [] : ["recipientName"]; }
    if (variant === "zero") item.fields.unknownAmount = 0;
    if (variant === "evidence") item.evidence = [{ field: "title", sourceId: input.id, fragmentId: input.fragments![4].id, quote: input.fragments![4].text }];
    if (variant === "multiple-cards") items.push({ ...card(), id: "second-empty", sourceIds: [] });
    if (variant === "multiple-documents") sources.push({ ...input, id: "second-source" });
    if (variant === "all-directions") destinations = ["proposals", "contracts", "counterparties", "staff", "procurement"];
    if (variant === "partial-source") input.coverage = { complete: false, requiresOcr: true };
    const result = completeContractProposalFields(items, sources, destinations);
    expect(result.items[0].sourceIds).toEqual([]); expect(result.changes).toEqual([]);
    expect(result.skipped.some((skip) => skip.reason === "contract-proposal-empty-shell-bound")).toBe(false);
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

  it("adds only distinct document and service prefixes to the same literal printed phrase", () => {
    const input = source(), phrase = "сопровождению API-сервиса «Тест» и проверке модуля QA";
    input.fragments![4].text = `1.1. Исполнитель оказывает комплекс услуг по ${phrase}, состав которых определён в приложении.`;
    const prepared = completeContractProposalFields([card()], [input], ["proposals"]).items[0];
    expect(prepared.title).toBe(`КП по ${phrase}`);
    expect(prepared.fields.title).toBe(`КП по ${phrase}`);
    expect(prepared.fields.lines).toEqual([`Услуги по ${phrase}`]);
    expect(prepared.fields.introduction).toContain(input.fragments![4].text);
    expect((prepared.fields.lineDescriptions as string[])[0]).toContain("SBOM при наличии");
    const proof = createContractProposalProver([input]).prove(prepared, [prepared])!;
    expect(proof.fields.has("title")).toBe(true); expect(proof.fields.has("lines")).toBe(true);
    expect(proof.fields.get("title")!.evidence.some((entry) => entry.quote === input.fragments![4].text)).toBe(true);
    expect(proof.fields.get("lines")!.evidence.some((entry) => entry.quote === input.fragments![4].text)).toBe(true);
  });

  it("keeps the old short literal fallback when no printed dative phrase is available", () => {
    const input = source(), exact = "Исполнитель оказывает согласованные услуги аудита учебной системы.";
    input.fragments![4].text = `1.1. ${exact}`;
    const prepared = completeContractProposalFields([card()], [input], ["proposals"]).items[0];
    expect(prepared.fields.title).toBe(exact); expect(prepared.fields.lines).toEqual([exact]);
    const proof = createContractProposalProver([input]).prove(prepared, [prepared])!;
    expect(proof.fields.has("title")).toBe(true); expect(proof.fields.has("lines")).toBe(true);
  });

  it("does not assume that a labelled subject is dative or change its existing short-title form", () => {
    const input = source(); input.fragments![4].text = "1.1. Предмет: Аудит учебной системы.";
    const prepared = completeContractProposalFields([card()], [input], ["proposals"]).items[0];
    expect(prepared.fields.title).toBe("КП: Аудит учебной системы");
    expect(prepared.fields.lines).toEqual(["Аудит учебной системы"]);
    expect(createContractProposalProver([input]).prove(prepared, [prepared])!.fields.has("lines")).toBe(true);
  });

  it("fits both prefixes within the 200-character names without shortening an over-limit source phrase", () => {
    const input = source(), phrase = "проверке " + "а".repeat(190 - "проверке ".length);
    input.fragments![4].text = `1.1. Исполнитель оказывает комплекс услуг по ${phrase}.`;
    const prepared = completeContractProposalFields([card()], [input], ["proposals"]).items[0];
    expect(prepared.fields.title).toBe(`КП по ${phrase}`);
    expect(prepared.fields.lines).toEqual([`Услуги по ${phrase}`]);
    expect((prepared.fields.title as string).length).toBeLessThanOrEqual(200);
    expect((prepared.fields.lines as string[])[0]).toHaveLength(200);
    expect(createContractProposalProver([input]).prove(prepared, [prepared])!.fields.has("lines")).toBe(true);

    input.fragments![4].text = `1.1. Исполнитель оказывает комплекс услуг по ${phrase}б.`;
    const over = completeContractProposalFields([card()], [input], ["proposals"]).items[0];
    expect(over.fields).not.toHaveProperty("title"); expect(over.fields).not.toHaveProperty("lines");
    expect(over.fields.introduction).toContain(`${phrase}б`);
    expect(createContractProposalProver([input]).prove(prepared, [prepared])!.fields.has("title")).toBe(false);
    expect(createContractProposalProver([input]).prove(prepared, [prepared])!.fields.has("lines")).toBe(false);
  });

  it.each(["old-document-prefix", "copied-document-line", "changed-phrase", "missing-title-evidence", "missing-line-evidence"])("does not weaken the closed title/line proof for %s", (variant) => {
    const input = source(), prepared = completeContractProposalFields([card()], [input], ["proposals"]).items[0];
    const changed = structuredClone(prepared);
    if (variant === "old-document-prefix") changed.fields.title = "КП: проверке учебной системы";
    if (variant === "copied-document-line") changed.fields.lines = [prepared.fields.title as string];
    if (variant === "changed-phrase") { changed.fields.title = "КП по разработке учебной системы"; changed.fields.lines = ["Услуги по разработке учебной системы"]; }
    if (variant === "missing-title-evidence") changed.evidence = changed.evidence!.filter((entry) => entry.field !== "title");
    if (variant === "missing-line-evidence") changed.evidence = changed.evidence!.filter((entry) => entry.field !== "lines");
    const proof = createContractProposalProver([input]).prove(changed, [changed])!;
    if (["old-document-prefix", "changed-phrase", "missing-title-evidence"].includes(variant)) expect(proof.fields.has("title")).toBe(false);
    if (["copied-document-line", "changed-phrase", "missing-line-evidence"].includes(variant)) expect(proof.fields.has("lines")).toBe(false);
    expect(proof.fields.has("lineDescriptions")).toBe(true);
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
