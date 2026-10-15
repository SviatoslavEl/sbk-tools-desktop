import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceDestination, IntelligenceFieldValue, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const source = (text: string, extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "source-a", name: "Материалы QA", text, ...extra });
const item = (fields: Record<string, IntelligenceFieldValue>, destination: IntelligenceDestination = "procurement", extra: Partial<IntelligenceItem> = {}): IntelligenceItem => ({ id: "item-a", title: "Карточка QA", destination, fields, sourceIds: ["source-a"], selectedFields: Object.keys(fields), ...extra });
const fieldStatus = (value: ReturnType<typeof auditIntelligenceResult>, field: string) => value.fields.find((entry) => entry.field === field);
const codes = (value: ReturnType<typeof auditIntelligenceResult>) => value.findings.map((entry) => entry.code);

describe("selected-source semantic evidence", () => {
  it("does not treat schema-valid but unsupported prices as confirmed", () => {
    const card = item({ name: "Закупка QA", nmc: 0 });
    const audit = auditIntelligenceResult([card], [source("Закупка QA\nЦена единицы, руб.: 0,00\nНМЦ не указана")]);
    expect(fieldStatus(audit, "nmc")?.status).toBe("conflict"); expect(getBlockingEvidenceFindings(audit, card).some((entry) => entry.field === "nmc")).toBe(true);
  });
  it("checks the selected NMC against an explicit total and keeps the omitted workbook in coverage", () => {
    const card = item({ name: "Поставка оборудования" }, "procurement", { sourceIds: ["technical"] });
    const audit = auditIntelligenceResult([card], [source("Поставка оборудования", { id: "technical" }), source("НМЦ договора, итого: 18 240 000,00 руб.", { id: "pricing", name: "Расчёт цены" })]);
    expect(audit.coverage.find((entry) => entry.category === "price")?.status).toBe("missing"); expect(codes(audit)).toContain("missing-price");
    expect(audit.coverage.find((entry) => entry.category === "price")?.evidence.sourceId).toBe("pricing");
    const fixed = item({ name: "Поставка оборудования", nmc: 18240000 }, "procurement", { sourceIds: ["technical", "pricing"] });
    const fixedAudit = auditIntelligenceResult([fixed], [source("Поставка оборудования", { id: "technical" }), source("НМЦ договора, итого: 18 240 000,00 руб.", { id: "pricing" })]);
    expect(fieldStatus(fixedAudit, "nmc")?.status).toBe("confirmed"); expect(fixedAudit.coverage.find((entry) => entry.category === "price")?.status).toBe("covered");
  });
  it("does not confuse unit price with a total", () => {
    const audit = auditIntelligenceResult([item({ nmc: 1824000 })], [source("НМЦ: цена за единицу 1 824 000,00 руб.\nНМЦ договора, итого: 18 240 000,00 руб.")]);
    expect(fieldStatus(audit, "nmc")?.status).not.toBe("confirmed");
  });
  it("preserves individual certificate minimums rather than accepting a list of certificate names", () => {
    const text = "Обязательные сертификаты:\nOSCP — не менее 5 специалистов\nOSEP — не менее 2 специалистов\nBSCP — не менее 3 специалистов";
    const audit = auditIntelligenceResult([item({ requirements: ["Специалисты с OSCP, OSEP и BSCP"] })], [source(text)]);
    expect(audit.coverage.filter((entry) => entry.category === "certificate")).toHaveLength(3);
    expect(audit.coverage.filter((entry) => entry.category === "certificate").every((entry) => entry.status === "missing")).toBe(true);
    const fixed = auditIntelligenceResult([item({ requirements: ["OSCP — не менее 5 специалистов", "OSEP — не менее 2 специалистов", "BSCP — не менее 3 специалистов"] })], [source(text)]);
    expect(fixed.coverage.filter((entry) => entry.category === "certificate").every((entry) => entry.status === "covered")).toBe(true);
  });
  it("checks numerical thresholds and warranty separately", () => {
    const text = "Требуется количество серверов: 10 шт.\nГарантия: не менее 3 лет.\nТребуется не менее 16 ядер на процессор.";
    const audit = auditIntelligenceResult([item({ requirements: ["Поставить серверы", "Гарантия"] })], [source(text)]);
    expect(audit.coverage.filter((entry) => entry.category === "quantity")).toHaveLength(3); expect(codes(audit)).toContain("missing-quantity");
    const fixed = auditIntelligenceResult([item({ requirements: text.split("\n") })], [source(text)]);
    expect(fixed.coverage.filter((entry) => entry.category === "quantity").every((entry) => entry.status === "covered")).toBe(true);
  });
  it("keeps conditional documents conditional", () => {
    const text = "В состав заявки необходимо приложить коммерческое предложение с печатью при наличии.\nНеобходимо одобрение крупной сделки при необходимости.";
    const wrong = auditIntelligenceResult([item({ requirements: ["Коммерческое предложение с печатью", "Одобрение крупной сделки"] })], [source(text)]);
    expect(wrong.coverage.filter((entry) => entry.category === "document").every((entry) => entry.status === "missing")).toBe(true);
    const correct = auditIntelligenceResult([item({ requirements: text.split("\n") })], [source(text)]);
    expect(correct.coverage.filter((entry) => entry.category === "document").every((entry) => entry.status === "covered")).toBe(true);
  });
  it("keeps letter and numbered licensing activities, not only a generic license name", () => {
    const text = "Требуется лицензия ФСТЭК на ТЗКИ, подпункты «б», «е».\nТребуется лицензия ФСБ, пункты 13, 20, 22.";
    const missing = auditIntelligenceResult([item({ licenses: ["Лицензия ФСТЭК на ТЗКИ", "Лицензия ФСБ"] })], [source(text)]);
    expect(missing.coverage.filter((entry) => entry.category === "document").every((entry) => entry.status === "missing")).toBe(true);
    const correct = auditIntelligenceResult([item({ licenses: text.split("\n") })], [source(text)]);
    expect(correct.coverage.filter((entry) => entry.category === "document").every((entry) => entry.status === "covered")).toBe(true);
  });
  it("does not invent a missing requirement for a number in an address, tax ID or statute", () => {
    const audit = auditIntelligenceResult([item({ notes: "Проверено вручную" })], [source("ИНН 1234567890\nТелефон +7 999 123 45 67\nНеобходимо соблюдать статью 31 Федерального закона 44-ФЗ.")]);
    expect(audit.coverage.filter((entry) => entry.category === "quantity")).toHaveLength(0);
  });
  it("preserves time and explicit timezone from the submission event", () => {
    const text = "Срок подачи заявок: 21.10.2026 16:00 МСК";
    const missing = auditIntelligenceResult([item({ submissionDeadline: "2026-10-21" })], [source(text)]);
    expect(fieldStatus(missing, "submissionDeadline")?.status).toBe("confirmed"); expect(codes(missing)).toContain("missing-deadline-time");
    const wrongZone = auditIntelligenceResult([item({ submissionDeadline: "2026-10-21", notes: "Подача до 16:00" })], [source(text)]);
    expect(codes(wrongZone)).toContain("missing-deadline-time");
    const correct = auditIntelligenceResult([item({ submissionDeadline: "2026-10-21", notes: "Подача до 16:00 МСК" })], [source(text)]);
    expect(correct.coverage.find((entry) => entry.category === "deadline-time")?.status).toBe("covered");
  });
  it("does not infer a timezone when the source gives only a time", () => {
    const audit = auditIntelligenceResult([item({ submissionDeadline: "2026-10-21", notes: "Срок подачи: 10:00:00" })], [source("Окончание подачи заявок: 21.10.2026 10:00:00")]);
    expect(audit.coverage.find((entry) => entry.category === "deadline-time")?.status).toBe("covered"); expect(audit.coverage.find((entry) => entry.category === "deadline-time")?.label).not.toContain("МСК");
  });
  it("does not use the document revision or consideration date as publication or performance", () => {
    const audit = auditIntelligenceResult([item({ publishedDate: "2026-10-12", executionStartDate: "2026-10-29", executionEndDate: "2026-10-29" })], [source("Дата редакции: 12.10.2026\nДата рассмотрения заявок: 29.10.2026 16:00\nПодведение итогов: 29.10.2026 16:00")]);
    expect(fieldStatus(audit, "publishedDate")?.status).toBe("conflict"); expect(fieldStatus(audit, "executionStartDate")?.status).toBe("conflict"); expect(fieldStatus(audit, "executionEndDate")?.status).toBe("conflict");
  });
  it("does not use delivery dates as submission dates", () => {
    const audit = auditIntelligenceResult([item({ submissionDeadline: "2026-12-29", executionStartDate: "2026-12-29" })], [source("Поставка: не ранее 29.12.2026")]);
    expect(fieldStatus(audit, "submissionDeadline")?.status).toBe("conflict"); expect(fieldStatus(audit, "executionStartDate")?.status).toBe("confirmed");
  });
  it("keeps the two events of a delivery window separate on the same line", () => {
    const audit = auditIntelligenceResult([item({ executionStartDate: "2026-12-29", executionEndDate: "2027-01-17" })], [source("Поставка: не ранее 29.12.2026, не позднее 17.01.2027")]);
    expect(fieldStatus(audit, "executionStartDate")?.status).toBe("confirmed"); expect(fieldStatus(audit, "executionEndDate")?.status).toBe("confirmed");
  });
  it("recognizes an explicitly parenthesized timezone without inventing one", () => {
    const audit = auditIntelligenceResult([item({ submissionDeadline: "2026-10-21", notes: "Время подачи 16:00 МСК" })], [source("Срок подачи заявок: 21.10.2026 16:00 (МСК)")]);
    expect(audit.coverage.find((entry) => entry.category === "deadline-time")?.status).toBe("covered");
  });
  it("does not make a relative validity period an explicit expiry date", () => {
    const audit = auditIntelligenceResult([item({ validUntil: "2026-10-16" }, "proposals")], [source("Срок действия коммерческого предложения — 14 календарных дней.")]);
    expect(fieldStatus(audit, "validUntil")?.status).toBe("unverified"); expect(getBlockingEvidenceFindings(audit, "item-a")).toHaveLength(1);
  });
  it.each(["Краткое название", "Значение из источника", "Площадка не указана", "Сведения не отражены организатором процедуры закупки", "Заказчик", "________"]) ("does not confirm the placeholder %s", (placeholder) => {
    const audit = auditIntelligenceResult([item({ platform: placeholder })], [source(placeholder)]);
    expect(fieldStatus(audit, "platform")?.status).toBe("placeholder"); expect(codes(audit)).toContain("placeholder-value");
  });
  it("does not use filenames as factual names or short labels as legal names", () => {
    const audit = auditIntelligenceResult([item({ name: "notice.docx" }, "procurement", { title: "notice.docx" })], [source("Предмет закупки: Поставка оборудования", { name: "notice.docx" })]);
    expect(fieldStatus(audit, "name")?.status).toBe("placeholder"); expect(codes(audit)).toContain("placeholder-title");
    const company = auditIntelligenceResult([item({ name: "АКБ «Банк QA» (ПАО)" }, "counterparties")], [source("Полное юридическое название: Акционерный коммерческий банк «Банк QA» (Публичное акционерное общество)")]);
    expect(fieldStatus(company, "name")?.status).toBe("unverified");
  });
  it("does not derive an electronic marketplace from an EIS notice number", () => {
    const audit = auditIntelligenceResult([item({ platform: "ЕИС" })], [source("Номер извещения в ЕИС: 32600000001")]);
    expect(fieldStatus(audit, "platform")?.status).toBe("conflict");
    const correct = auditIntelligenceResult([item({ platform: "Bidzaar" })], [source("Электронная площадка: Bidzaar")]); expect(fieldStatus(correct, "platform")?.status).toBe("confirmed");
  });
  it("does not appoint an external contact as our responsible employee", () => {
    const audit = auditIntelligenceResult([item({ responsible: "Иванов Иван Иванович" })], [source("Контакт организатора: Иванов Иван Иванович\nТелефон организатора: +7 999 123 45 67")]);
    expect(fieldStatus(audit, "responsible")?.status).toBe("conflict"); expect(getBlockingEvidenceFindings(audit, "item-a")).toHaveLength(1);
    const allowed = auditIntelligenceResult([item({ responsible: "Петров Петр" })], [source("Наш ответственный за заявку: Петров Петр")]); expect(fieldStatus(allowed, "responsible")?.status).toBe("confirmed");
  });
  it("does not mistake generic supplier duties for an internal responsible role", () => {
    const audit = auditIntelligenceResult([item({ responsible: "Поставщик обязан поставить оборудование в срок" })], [source("Поставщик обязан поставить оборудование в срок")]);
    expect(fieldStatus(audit, "responsible")?.status).toBe("conflict");
  });
  it("keeps supplier addresses, contacts and addressees out of buyer fields", () => {
    const text = "Поставщик: ООО «Поставщик QA»\nАдрес поставщика: г. Город-А, улица Первая, 1\nКонтакт поставщика: Иванова Анна\nТелефон поставщика: +7 900 111 22 33\nЗаказчик: ООО «Покупатель QA»";
    const card = item({ issuerName: "ООО «Поставщик QA»", recipientName: "ООО «Покупатель QA»", recipientAddress: "г. Город-А, улица Первая, 1", recipientContact: "+7 900 111 22 33", addresseeName: "Иванова Анна" }, "proposals");
    const audit = auditIntelligenceResult([card], [source(text)]);
    expect(fieldStatus(audit, "issuerName")?.status).toBe("confirmed"); expect(fieldStatus(audit, "recipientName")?.status).toBe("confirmed");
    expect(fieldStatus(audit, "recipientAddress")?.status).toBe("conflict"); expect(fieldStatus(audit, "recipientContact")?.status).toBe("conflict"); expect(fieldStatus(audit, "addresseeName")?.status).toBe("conflict");
  });
  it("checks roles even if a real quoted source contains the value", () => {
    const text = "Адрес поставщика: г. Город-А, улица Первая, 1";
    const audit = auditIntelligenceResult([item({ recipientAddress: "г. Город-А, улица Первая, 1" }, "proposals", { evidence: [{ field: "recipientAddress", sourceId: "source-a", quote: text }] })], [source(text)]);
    expect(fieldStatus(audit, "recipientAddress")?.status).toBe("conflict"); expect(codes(audit)).not.toContain("invalid-evidence-quote");
  });
  it("rejects fabricated quotes, wrong fragment IDs and a quote not supporting the value", () => {
    const audit = auditIntelligenceResult([item({ name: "Закупка QA", customer: "ООО Другой" }, "procurement", { evidence: [
      { field: "name", sourceId: "source-a", fragmentId: "not-selected", quote: "Закупка QA" },
      { field: "customer", sourceId: "source-a", fragmentId: "f1", quote: "Заказчик: ООО Банк QA" },
    ] })], [source("unused", { fragments: [{ id: "f1", locator: "Страница 1", text: "Закупка QA\nЗаказчик: ООО Банк QA" }] })]);
    expect(codes(audit)).toContain("invalid-evidence-quote"); expect(codes(audit)).toContain("evidence-does-not-support-value");
  });
  it("never restores discarded aggregate text or excluded sheets into evidence", () => {
    const audit = auditIntelligenceResult([item({ customer: "Школа из истории" })], [source("Заказчик: Школа из истории\nСтарая цена 2018 года", { fragments: [{ id: "current", locator: "Текущий лист", sheetId: "current", sheetState: "visible", text: "Текущая закупка: Заказчик не указан" }] })]);
    expect(fieldStatus(audit, "customer")?.status).toBe("unverified"); expect(fieldStatus(audit, "customer")?.evidence).toHaveLength(0);
    const none = auditIntelligenceResult([item({ customer: "Школа из истории" })], [source("Заказчик: Школа из истории", { fragments: [] })]); expect(fieldStatus(none, "customer")?.status).toBe("unverified");
  });
  it("does not confirm values from an unrelated selected source not cited by this card", () => {
    const card = item({ customer: "ООО Заказчик-Б", submissionDeadline: "2026-10-25" }, "procurement", { sourceIds: ["a"] });
    const audit = auditIntelligenceResult([card], [source("Заказчик: ООО Заказчик-А\nСрок подачи заявок: 21.10.2026", { id: "a" }), source("Заказчик: ООО Заказчик-Б\nСрок подачи заявок: 25.10.2026", { id: "b" })]);
    expect(fieldStatus(audit, "customer")?.status).toBe("unverified"); expect(fieldStatus(audit, "submissionDeadline")?.status).toBe("unverified");
    expect(fieldStatus(audit, "customer")?.evidence).toHaveLength(0);
  });
  it("warns about explicitly included hidden history without calling the selected text forbidden", () => {
    const audit = auditIntelligenceResult([item({ customer: "ООО История" })], [source("", { fragments: [{ id: "old", locator: "История", sheetId: "old", sheetState: "hidden", includedByUser: true, text: "Заказчик: ООО История" }] })]);
    expect(fieldStatus(audit, "customer")?.status).toBe("confirmed"); expect(codes(audit)).toContain("hidden-sheet-history"); expect(audit.findings.find((entry) => entry.code === "hidden-sheet-history")?.severity).toBe("warning");
  });
  it("blocks unreviewed incomplete OCR coverage while preserving extraction warnings", () => {
    const card = item({ name: "Закупка QA" }); const audit = auditIntelligenceResult([card], [source("Закупка QA", { warnings: ["На странице 2 есть изображение без текста"], coverage: { complete: false, requiresOcr: true, pagesWithoutText: [2], pagesWithImages: [2] } })]);
    const issue = audit.findings.find((entry) => entry.code === "incomplete-source-coverage")!; expect(issue.evidence[0].quote).toContain("странице 2"); expect(getBlockingEvidenceFindings(audit, card)).toContainEqual(issue);
  });
  it("requires one SKU per proposal line and examines parallel descriptions", () => {
    const text = "Артикул: SKU_ALPHA01\nСервер, Intel Xeon 6334\nАртикул: SKU_BETA02\nСервер, Intel Xeon 4310";
    const merged = auditIntelligenceResult([item({ lines: ["Сервер SKU_ALPHA01 и SKU_BETA02"], lineDescriptions: ["Две конфигурации"] }, "proposals")], [source(text)]);
    expect(codes(merged)).toContain("merged-sku-line");
    const separate = auditIntelligenceResult([item({ lines: ["Сервер", "Сервер"], lineDescriptions: ["Артикул SKU_ALPHA01, Intel Xeon 6334", "Артикул SKU_BETA02, Intel Xeon 4310"] }, "proposals")], [source(text)]);
    expect(codes(separate)).not.toContain("merged-sku-line"); expect(separate.coverage.filter((entry) => entry.category === "sku").every((entry) => entry.status === "covered")).toBe(true);
  });
  it("uses unique distinguishing CPUs across following lines but does not merge shared CPU variants", () => {
    const distinct = "Артикул: SKU_ALPHA01\nСервер, Intel Xeon 6334\nАртикул: SKU_BETA02\nСервер, Intel Xeon 4310";
    const combined = auditIntelligenceResult([item({ lines: ["Сервер"], lineDescriptions: ["Intel Xeon 6334 и Intel Xeon 4310"] }, "proposals")], [source(distinct)]);
    expect(codes(combined)).toContain("merged-sku-line");
    const separate = auditIntelligenceResult([item({ lines: ["Сервер", "Сервер"], lineDescriptions: ["Intel Xeon 6334", "Intel Xeon 4310"] }, "proposals")], [source(distinct)]);
    expect(separate.coverage.filter((entry) => entry.category === "sku").every((entry) => entry.status === "covered")).toBe(true);
    const shared = "Артикул: SKU_ALPHA01\nСервер, Intel Xeon 6334\nАртикул: SKU_BETA02\nСервер, Intel Xeon 6334";
    const one = auditIntelligenceResult([item({ lines: ["Сервер SKU_ALPHA01"], lineDescriptions: ["Intel Xeon 6334"] }, "proposals")], [source(shared)]);
    expect(codes(one)).not.toContain("merged-sku-line"); expect(one.coverage.filter((entry) => entry.category === "sku" && entry.status === "missing")).toHaveLength(1);
  });
  it("does not create procurement coverage blockers when only a proposal is requested", () => {
    const audit = auditIntelligenceResult([item({ title: "КП QA" }, "proposals")], [source("НМЦ договора: 200000 руб.\nOSCP — не менее 5 специалистов")]);
    expect(audit.coverage.filter((entry) => entry.category !== "sku")).toHaveLength(0);
  });
  it("assigns coverage to the current source-linked item, not every unrelated procurement", () => {
    const a = item({ name: "Первая" }, "procurement", { id: "a", sourceIds: ["a-doc"] });
    const b = item({ name: "Вторая" }, "procurement", { id: "b", sourceIds: ["b-doc"] });
    const audit = auditIntelligenceResult([a, b], [source("OSCP — не менее 5 специалистов", { id: "a-doc" }), source("Вторая закупка", { id: "b-doc" })]);
    expect(audit.coverage[0].itemIds).toEqual(["a"]); expect(audit.findings.filter((entry) => entry.code === "missing-certificate").every((entry) => entry.itemId === "a")).toBe(true);
  });
  it("does not block empty or explicitly unchecked fields", () => {
    const card = item({ nmc: 100, responsible: "Внешний контакт", customer: "" }, "procurement", { selectedFields: ["customer"] });
    const audit = auditIntelligenceResult([card], [source("Контакт организатора: Внешний контакт")]); expect(audit.fields).toHaveLength(0); expect(getBlockingEvidenceFindings(audit, card)).toHaveLength(0);
  });
  it("ties explicit review acknowledgements to the exact current value and evidence", () => {
    const original = item({ customer: "Неподтверждённая компания" }); const audit = auditIntelligenceResult([original], [source("Сведения отсутствуют")]);
    const reviewed = getBlockingEvidenceFindings(audit, original).map((entry) => entry.id); expect(getBlockingEvidenceFindings(audit, original, reviewed)).toHaveLength(0);
    const changed = item({ customer: "Другая неподтверждённая компания" }); const updated = auditIntelligenceResult([changed], [source("Сведения отсутствуют")]); expect(getBlockingEvidenceFindings(updated, changed, reviewed).length).toBeGreaterThan(0);
  });
  it("bounds work and output for 5000 rows and 100 cards, reporting the incomplete audit explicitly", () => {
    const lines = Array.from({ length: 5000 }, (_, index) => `Требуется сертификат QA${index} — не менее 5 специалистов, обязательное условие ${index}.`);
    const cards = Array.from({ length: 100 }, (_, index) => item({ name: `Закупка QA${index}`, requirements: ["Общее описание"] }, "procurement", { id: `item-${index}` }));
    const started = performance.now(); const audit = auditIntelligenceResult(cards, [source(lines.join("\n"))]); const elapsed = performance.now() - started;
    expect(audit.findings.length).toBeLessThanOrEqual(615); expect(audit.coverage.length).toBeLessThanOrEqual(256); expect(audit.fields.length).toBeLessThanOrEqual(1000);
    expect(audit.findings.filter((entry) => entry.code === "audit-limit")).toHaveLength(100);
    expect(getBlockingEvidenceFindings(audit, cards[99]).some((entry) => entry.code === "audit-limit")).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  });
  it.each([
    { sheetState: "hidden" as const }, { sheetState: "veryHidden" as const },
    { sheetState: "hidden" as const, includedByUser: false },
  ])("does not audit excluded or unselected hidden fragments: %j", (flags) => {
    const audit = auditIntelligenceResult([item({ customer: "ООО История", nmc: 100000, submissionDeadline: "2026-10-21" }, "procurement", { evidence: [{ field: "customer", sourceId: "source-a", fragmentId: "old", quote: "Заказчик: ООО История" }] })], [source("Заказчик: ООО История", { fragments: [{ id: "old", locator: "Исключённый лист", text: "Заказчик: ООО История\nНМЦ: 100000 руб.\nСрок подачи заявок: 21.10.2026 16:00 МСК\nOSCP — не менее 5 специалистов", ...flags }] })]);
    expect(audit.fields.every((field) => field.status === "unverified")).toBe(true);
    expect(audit.coverage).toHaveLength(0); expect(codes(audit)).toContain("invalid-evidence-quote"); expect(codes(audit)).not.toContain("hidden-sheet-history");
  });
  it("retains actual extractor visible:false wire fragments and opt-in hidden:true history", () => {
    const current = { id: "current", locator: "Текущий лист", sheetState: "visible" as const, includedByUser: false, text: "Заказчик: ООО Текущий QA\nНМЦ: 100000 руб.\nOSCP — не менее 5 специалистов" };
    const hidden = { id: "old", locator: "Скрытая история", sheetState: "hidden" as const, includedByUser: true, text: "Дата публикации: 21.10.2026" };
    const card = item({ customer: "ООО Текущий QA", nmc: 100000, publishedDate: "2026-10-21", requirements: ["OSCP — не менее 5 специалистов"] });
    const audit = auditIntelligenceResult([card], [source("", { fragments: [current, hidden] })]);
    expect(audit.fields.every((entry) => entry.status === "confirmed")).toBe(true); expect(audit.coverage.every((entry) => entry.status === "covered")).toBe(true);
    expect(audit.findings.find((entry) => entry.code === "hidden-sheet-history")?.evidence[0].locator).toBe("Скрытая история");
  });
  it("requires each certificate's own count when several appear in one row or output entry", () => {
    const text = "OSCP — не менее 5 специалистов; OSEP — не менее 2 специалистов; PenTest+ — не менее 3 специалистов";
    const wrong = auditIntelligenceResult([item({ requirements: ["OSCP — не менее 5 специалистов; OSEP — не менее 5 специалистов; PenTest+ — не менее 5 специалистов"] })], [source(text)]);
    expect(wrong.coverage.filter((entry) => entry.category === "certificate").map((entry) => entry.status)).toEqual(["covered", "missing", "missing"]);
    const correct = auditIntelligenceResult([item({ requirements: [text] })], [source(text)]);
    expect(correct.coverage.filter((entry) => entry.category === "certificate").map((entry) => entry.status)).toEqual(["covered", "covered", "covered"]);
  });
  it("recognizes counts before each certificate without assigning another certificate's count", () => {
    const text = "Не менее 5 специалистов с OSCP, не менее 2 специалистов с OSEP";
    const correct = auditIntelligenceResult([item({ requirements: [text] })], [source(text)]);
    expect(correct.coverage.filter((entry) => entry.category === "certificate").map((entry) => entry.status)).toEqual(["covered", "covered"]);
    const wrong = auditIntelligenceResult([item({ requirements: ["Не менее 5 специалистов с OSCP, не менее 5 специалистов с OSEP"] })], [source(text)]);
    expect(wrong.coverage.filter((entry) => entry.category === "certificate").map((entry) => entry.status)).toEqual(["covered", "missing"]);
  });
  it.each([
    ["Не менее 5 специалистов с OSCP", "Не более 5 специалистов с OSCP"],
    ["Не более 5 специалистов с OSCP", "Не менее 5 специалистов с OSCP"],
    ["OSCP — не менее 5 специалистов при наличии", "OSCP — не менее 5 специалистов"],
    ["Требуется не менее 16 ядер на процессор", "Требуется не более 16 ядер на процессор"],
    ["Необходимо приложить доверенность или документ о полномочиях", "Необходимо приложить доверенность и документ о полномочиях"],
  ])("does not cover changed bounds or lost qualifiers: %s", (text, changed) => {
    const audit = auditIntelligenceResult([item({ requirements: [changed] })], [source(text)]);
    expect(audit.coverage.every((entry) => entry.status !== "covered")).toBe(true); expect(audit.coverage.length).toBeGreaterThan(0);
  });
  it("does not assign quantities, VAT percentages or years to NMC in an overall-price row", () => {
    const text = "Итого 10 шт.; 100000 руб.; НДС 20%; расчёт 2026 года";
    for (const nmc of [10, 20, 2026]) expect(fieldStatus(auditIntelligenceResult([item({ nmc })], [source(text)]), "nmc")?.status).toBe("conflict");
    expect(fieldStatus(auditIntelligenceResult([item({ nmc: 100000 })], [source(text)]), "nmc")?.status).toBe("conflict");
    const correct = auditIntelligenceResult([item({ nmc: 100000 })], [source("Итого 10 шт.; НМЦ: 100000 руб.; НДС 20%; расчёт 2026 года")]);
    expect(fieldStatus(correct, "nmc")?.status).toBe("confirmed"); expect(correct.coverage.filter((entry) => entry.category === "price").map((entry) => entry.label)).toEqual(["Явная общая цена: 100000"]);
  });
  it("does not mistake a separately labeled VAT amount for the overall total", () => {
    for (const text of ["НМЦ: 100000 руб.; НДС: 20000 руб.", "НМЦ: 100000 руб., в том числе НДС 20000 руб."]) {
      const wrong = auditIntelligenceResult([item({ nmc: 20000 })], [source(text)]);
      expect(fieldStatus(wrong, "nmc")?.status).toBe("conflict");
      expect(wrong.coverage.filter((entry) => entry.category === "price").map((entry) => entry.label)).toEqual(["Явная общая цена: 100000"]);
    }
  });
  it("keeps spreadsheet totals next to a separate numeric value", () => {
    const audit = auditIntelligenceResult([item({ nmc: 100000 })], [source("НМЦ договора, руб.\n100000")]);
    expect(fieldStatus(audit, "nmc")?.status).toBe("confirmed"); expect(audit.coverage.find((entry) => entry.category === "price")?.status).toBe("covered");
  });
  it("never retroactively claims a tax ID using the following price label", () => {
    const text = "ИНН\n1234567890\nНачальная (максимальная) цена\nдоговора\n3746800";
    const wrong = auditIntelligenceResult([item({ nmc: 1234567890 })], [source(text)]);
    expect(fieldStatus(wrong, "nmc")?.status).toBe("conflict");
    expect(wrong.coverage.filter((check) => check.category === "price").map((check) => check.label)).toEqual(["Явная общая цена: 3746800"]);
    const right = auditIntelligenceResult([item({ nmc: 3746800 })], [source(text)]);
    expect(fieldStatus(right, "nmc")?.status).toBe("confirmed");
  });
  it("does not convert an arbitrary proposal total into tender NMC or a missing-NMC obligation", () => {
    const text = "Стоимость сервера по коммерческому предложению: 100000 руб. Итого: 100000 руб.";
    const card = item({ nmc: 100000 }); const audit = auditIntelligenceResult([card], [source(text)]);
    expect(fieldStatus(audit, "nmc")?.status).toBe("conflict"); expect(getBlockingEvidenceFindings(audit, card).some((finding) => finding.field === "nmc")).toBe(true);
    expect(audit.coverage.filter((check) => check.category === "price")).toHaveLength(0);
    const contract = auditIntelligenceResult([item({ amount: 100000 }, "contracts")], [source("Цена договора: 100000 руб.")]);
    expect(fieldStatus(contract, "amount")?.status).toBe("confirmed");
  });
  it.each(["USD", "EUR", "$", "€", "CNY", "KZT", "BYN", "долларов США", "евро", "юаней", "тенге", "белорусских рублей"])("does not silently interpret foreign currency as a ruble amount: %s", (currency) => {
    const procurement = auditIntelligenceResult([item({ nmc: 100000 })], [source(`НМЦ: 100000 ${currency}`)]);
    expect(fieldStatus(procurement, "nmc")?.status).toBe("conflict"); expect(procurement.coverage.filter((check) => check.category === "price")).toHaveLength(0);
    const contract = auditIntelligenceResult([item({ amount: 100000 }, "contracts")], [source(`Цена договора: 100000 ${currency}`)]);
    expect(fieldStatus(contract, "amount")?.status).toBe("conflict");
    const share = auditIntelligenceResult([item({ ourShareAmount: 100000 }, "contracts")], [source(`Наша доля: 100000 ${currency}`)]);
    expect(fieldStatus(share, "ourShareAmount")?.status).toBe("conflict");
  });
  it("does not lose a foreign currency on a separate preceding NMC header", () => {
    const audit = auditIntelligenceResult([item({ nmc: 100000 })], [source("НМЦ, USD\n100000")]);
    expect(fieldStatus(audit, "nmc")?.status).toBe("conflict");
    const contract = auditIntelligenceResult([item({ amount: 100000 }, "contracts")], [source("НМЦ, USD\n100000")]);
    expect(fieldStatus(contract, "amount")?.status).toBe("conflict");
  });
  it.each(["НМЦ: 100000 руб.", "Начальная (максимальная) цена договора: 100000 руб.", "Предельная стоимость закупки: 100000 руб."])("retains explicitly designated NMC: %s", (text) => {
    const audit = auditIntelligenceResult([item({ nmc: 100000 })], [source(text)]);
    expect(fieldStatus(audit, "nmc")?.status).toBe("confirmed"); expect(audit.coverage.find((check) => check.category === "price")?.status).toBe("covered");
  });
  it.each(["НМЦ не указана: 100000 руб.", "НМЦ не указана\n100000"])("does not use a negated NMC label: %s", (text) => {
    expect(fieldStatus(auditIntelligenceResult([item({ nmc: 100000 })], [source(text)]), "nmc")?.status).toBe("conflict");
  });
  it.each(["Цена договора: 100000 руб.", "Наша доля 20% от цены договора 100000 руб.", "Наша доля 20%; общая цена договора 100000 руб."])("does not call the contract total our share: %s", (text) => {
    const card = item({ ourShareAmount: 100000 }, "contracts"), audit = auditIntelligenceResult([card], [source(text)]);
    expect(fieldStatus(audit, "ourShareAmount")?.status).toBe("conflict"); expect(getBlockingEvidenceFindings(audit, card).some((finding) => finding.field === "ourShareAmount")).toBe(true);
  });
  it("requires our share's own monetary label and does not borrow the total", () => {
    const text = "Общая цена договора: 100000 руб.; Наша доля: 20000 руб.";
    const wrong = auditIntelligenceResult([item({ ourShareAmount: 100000 }, "contracts")], [source(text)]);
    const correct = auditIntelligenceResult([item({ ourShareAmount: 20000 }, "contracts")], [source(text)]);
    expect(fieldStatus(wrong, "ourShareAmount")?.status).toBe("conflict"); expect(fieldStatus(correct, "ourShareAmount")?.status).toBe("confirmed");
  });
  it("keeps a comma-separated table deadline time as an independent blocking condition", () => {
    const text = "Приём предложений до\t21.10.2026, 16:00";
    const audit = auditIntelligenceResult([item({ submissionDeadline: "2026-10-21" })], [source(text)]);
    expect(fieldStatus(audit, "submissionDeadline")?.status).toBe("confirmed");
    expect(audit.coverage.find((check) => check.category === "deadline-time")?.status).toBe("missing"); expect(codes(audit)).toContain("missing-deadline-time");
    const excludedDate = item({ notes: "Другие условия" });
    expect(codes(auditIntelligenceResult([excludedDate], [source(text)]))).toContain("missing-deadline-time");
  });
  it("recognizes a PDF's wrapped deadline label without borrowing consideration time", () => {
    const text = "Дата и время начала подачи\nзаявок\n2026-10-09 19:01:00\nДата и время окончания подачи\nзаявок\n2026-10-21 10:00:00\nДата и время рассмотрения\nзаявок\n2026-10-29 16:00:00";
    const audit = auditIntelligenceResult([item({ submissionDeadline: "2026-10-21", notes: "Другие условия" })], [source(text)]);
    expect(fieldStatus(audit, "submissionDeadline")?.status).toBe("confirmed");
    const times = audit.coverage.filter((check) => check.category === "deadline-time");
    expect(times).toHaveLength(1); expect(times[0].label).toContain("10:00:00"); expect(times[0].status).toBe("missing");
    expect(codes(audit)).toContain("missing-deadline-time");
  });
  it("does not inherit wrapped event labels across fragments", () => {
    const audit = auditIntelligenceResult([item({ submissionDeadline: "2026-10-21" })], [source("", { fragments: [{ id: "p1", locator: "Страница 1", text: "Дата и время окончания подачи заявок" }, { id: "p2", locator: "Страница 2", text: "2026-10-21 10:00:00" }] })]);
    expect(fieldStatus(audit, "submissionDeadline")?.status).toBe("conflict");
  });
  it("does not lose the equipment quantity in a DOCX table without a repeated obligation verb", () => {
    const fragments = [{ id: "table-row-1", locator: "Таблица, строка 1", text: "№ пп\tНаименование оборудования\tКол-во\nшт." }, { id: "table-row-2", locator: "Таблица, строка 2", text: "1\tСервер в составе:\t10" }];
    const missing = auditIntelligenceResult([item({ requirements: ["Поставка серверов"] })], [source("", { fragments })]);
    expect(missing.coverage.some((check) => check.category === "quantity" && check.label.includes("10") && check.status === "missing")).toBe(true); expect(codes(missing)).toContain("missing-quantity");
    const fixed = auditIntelligenceResult([item({ requirements: ["Сервер в составе: 10"] })], [source("", { fragments })]);
    expect(fixed.coverage.find((check) => check.category === "quantity")?.status).toBe("covered");
  });
  it("keeps numbered application documents even when each row does not repeat an obligation verb", () => {
    const documents = ["1. Заявка в виде коммерческого предложения, заверенная подписью и печатью при наличии.", "2. Копия выписки из единого государственного реестра юридических лиц, полученная не ранее 30 дней.", "3. Копии документов, подтверждающие полномочия лица на подачу заявки.", "4. Решение об одобрении сделки при необходимости.", "5. Декларация по форме приложения № 2.", "7. Запрос на аккредитацию (карточка предприятия).", "8. КНД 1120101 об отсутствии налоговой задолженности.", "9. Типовой проект Договора с существенными условиями извещения."];
    const fragments = documents.map((text, index) => ({ id: `paragraph-${index + 1}`, locator: `Абзац ${index + 1}`, text }));
    const missing = auditIntelligenceResult([item({ requirements: ["Общие требования"] })], [source("", { fragments })]);
    expect(missing.coverage.filter((check) => check.category === "document")).toHaveLength(8);
    expect(missing.findings.filter((finding) => finding.code === "missing-document")).toHaveLength(8);
    const fixed = auditIntelligenceResult([item({ requirements: documents })], [source("", { fragments })]);
    expect(fixed.coverage.filter((check) => check.category === "document").every((check) => check.status === "covered")).toBe(true);
  });
  it("flags a lost distinguishing CPU even when a PDF places both SKU rows before detailed configurations", () => {
    const text = "1 SKUQA_ALPHA01 шт 2\n2 SKUQA_BETA02 шт 2\nКонтакт поставщика\nКоммерческое предложение\nДата: 02.10.2026\nОписание\nУсловия\nСервер в составе:\nШасси\nПроцессор Intel Xeon 6334\nСервер в составе:\nШасси\nПроцессор Intel Xeon 4310";
    const card = item({ lines: ["SKUQA_ALPHA01", "SKUQA_BETA02"], lineDescriptions: ["Xeon 6334", "Xeon 6334"] }, "proposals");
    const audit = auditIntelligenceResult([card], [source(text)]);
    expect(audit.coverage.some((check) => check.label.includes("4310") && check.status === "missing")).toBe(true);
    expect(getBlockingEvidenceFindings(audit, card).some((finding) => finding.code === "missing-sku-configuration")).toBe(true);
  });
  it("assigns post-labeled dates to their own nearest event, not the following date's event", () => {
    const text = "21.10.2026 дата публикации; 25.10.2026 срок подачи заявок";
    const correct = auditIntelligenceResult([item({ publishedDate: "2026-10-21", submissionDeadline: "2026-10-25" })], [source(text)]);
    expect(correct.fields.map((entry) => entry.status)).toEqual(["confirmed", "confirmed"]);
    const wrong = auditIntelligenceResult([item({ submissionDeadline: "2026-10-21", publishedDate: "2026-10-25" })], [source(text)]);
    expect(wrong.fields.map((entry) => entry.status)).toEqual(["conflict", "conflict"]);
  });
  it("does not confirm a correct calendar date using an invalid source time", () => {
    const audit = auditIntelligenceResult([item({ submissionDeadline: "2026-10-21", notes: "Подача 99:99 МСК" })], [source("Срок подачи заявок: 21.10.2026 99:99 МСК")]);
    expect(fieldStatus(audit, "submissionDeadline")?.status).toBe("conflict"); expect(audit.coverage.filter((entry) => entry.category === "deadline-time")).toHaveLength(0);
  });
  it("does not accept a submission time or timezone as a substring of a different value", () => {
    for (const notes of ["Подача 116:000 МСК", "Подача 16:00 МСК-EXTRA"]) {
      const audit = auditIntelligenceResult([item({ submissionDeadline: "2026-10-21", notes })], [source("Срок подачи заявок: 21.10.2026 16:00 МСК")]);
      expect(codes(audit)).toContain("missing-deadline-time");
    }
  });
  it("distinguishes explicitly labeled full and short legal names", () => {
    const full = "Публичное акционерное общество «Банк QA»", short = "ПАО «Банк QA»";
    const text = `Полное наименование: ${full}; Краткое наименование: ${short}`;
    const abbreviated = auditIntelligenceResult([item({ name: short }, "counterparties")], [source(text)]);
    expect(fieldStatus(abbreviated, "name")?.status).toBe("conflict"); expect(getBlockingEvidenceFindings(abbreviated, "item-a")).toHaveLength(1);
    const legal = auditIntelligenceResult([item({ name: full }, "counterparties")], [source(text)]);
    expect(fieldStatus(legal, "name")?.status).toBe("confirmed");
  });
  it("does not use a generic filename without an extension as content proof", () => {
    const audit = auditIntelligenceResult([item({ name: "Тендер QA" })], [source("Сведения о предмете не указаны", { name: "Тендер QA" })]);
    expect(fieldStatus(audit, "name")?.status).toBe("placeholder");
  });
  it("keeps opposing parties separated even when their labels share one row", () => {
    const text = "Поставщик: ООО Поставщик QA; Заказчик: ООО Покупатель QA";
    const correct = auditIntelligenceResult([item({ issuerName: "ООО Поставщик QA", recipientName: "ООО Покупатель QA" }, "proposals")], [source(text)]);
    expect(correct.fields.map((entry) => entry.status)).toEqual(["confirmed", "confirmed"]);
    const swapped = auditIntelligenceResult([item({ issuerName: "ООО Покупатель QA", recipientName: "ООО Поставщик QA" }, "proposals")], [source(text)]);
    expect(swapped.fields.map((entry) => entry.status)).toEqual(["conflict", "conflict"]);
  });
  it("does not prove a nearby contact's role from model-supplied unlabeled company names", () => {
    const text = "ООО Покупатель QA\nКонтакт: Иванова Анна\nТелефон: +7 900 111 22 33";
    const audit = auditIntelligenceResult([item({ recipientName: "ООО Покупатель QA", addresseeName: "Иванова Анна", recipientContact: "+7 900 111 22 33" }, "proposals")], [source(text)]);
    expect(audit.fields.every((entry) => entry.status === "unverified")).toBe(true); expect(getBlockingEvidenceFindings(audit, "item-a")).toHaveLength(3);
  });
  it("carries the last explicit side label to the next row, not the first label in a mixed row", () => {
    const text = "Поставщик: ООО Поставщик QA; Заказчик: ООО Покупатель QA\nТелефон: +7 900 111 22 33";
    const audit = auditIntelligenceResult([item({ contactPhone: "+7 900 111 22 33", recipientContact: "+7 900 111 22 33" }, "proposals")], [source(text)]);
    expect(fieldStatus(audit, "contactPhone")?.status).toBe("conflict"); expect(fieldStatus(audit, "recipientContact")?.status).toBe("confirmed");
  });
  it("does not borrow another certificate's comparator from a shared output row", () => {
    const audit = auditIntelligenceResult([item({ requirements: ["OSCP — не более 5 специалистов; OSEP — не менее 5 специалистов"] })], [source("OSCP — не менее 5 специалистов; OSEP — не менее 5 специалистов")]);
    expect(audit.coverage.filter((entry) => entry.category === "certificate").map((entry) => entry.status)).toEqual(["missing", "covered"]);
  });
  it("does not silently drop a shared certificate minimum that cannot be assigned deterministically", () => {
    const audit = auditIntelligenceResult([item({ requirements: ["Не менее 5 специалистов с OSCP и OSEP"] })], [source("Не менее 5 специалистов с OSCP и OSEP")]);
    expect(audit.coverage.filter((entry) => entry.category === "certificate").some((entry) => entry.status === "uncertain")).toBe(true);
    expect(getBlockingEvidenceFindings(audit, "item-a").some((entry) => entry.code === "missing-certificate")).toBe(true);
  });
  it("accepts a literal four-line proof from one exact locator but not cross-fragment synthesis", () => {
    const quote = "Закупка QA\nВторая строка\nТретья строка\nЧетвёртая строка";
    const card = item({ name: "Закупка QA" }, "procurement", { evidence: [{ field: "name", sourceId: "source-a", fragmentId: "f1", quote }] });
    const exact = auditIntelligenceResult([card], [source("", { fragments: [{ id: "f1", locator: "Страница 7", text: quote }] })]);
    expect(codes(exact)).not.toContain("invalid-evidence-quote");
    const split = auditIntelligenceResult([card], [source("", { fragments: [{ id: "f1", locator: "Страница 7", text: "Закупка QA\nВторая строка" }, { id: "f2", locator: "Страница 8", text: "Третья строка\nЧетвёртая строка" }] })]);
    expect(codes(split)).toContain("invalid-evidence-quote");
  });
  it.each(["ЗАКУПКА QA", "Закупка QА", "Закупка-QA"])("rejects nonliteral evidence even if normalized text looks similar: %s", (quote) => {
    const audit = auditIntelligenceResult([item({ name: "Закупка QA" }, "procurement", { evidence: [{ field: "name", sourceId: "source-a", quote }] })], [source("Закупка QA")]);
    expect(codes(audit)).toContain("invalid-evidence-quote");
  });
  it("accepts only whitespace differences in a literal evidence quote", () => {
    const audit = auditIntelligenceResult([item({ name: "Закупка QA" }, "procurement", { evidence: [{ field: "name", sourceId: "source-a", quote: "Закупка   QA" }] })], [source("Закупка\u00a0QA")]);
    expect(codes(audit)).not.toContain("invalid-evidence-quote");
  });
  it("never concatenates un-IDed fragments to invent a quoted locator", () => {
    const audit = auditIntelligenceResult([item({ name: "Закупка QA" }, "procurement", { evidence: [{ field: "name", sourceId: "source-a", quote: "Закупка QA Продолжение" }] })], [source("", { fragments: [{ locator: "Страница 1", text: "Закупка QA" }, { locator: "Страница 2", text: "Продолжение" }] })]);
    expect(codes(audit)).toContain("invalid-evidence-quote");
  });
  it("makes date-budget exhaustion explicit rather than silently claiming a complete audit", () => {
    const audit = auditIntelligenceResult([item({ publishedDate: "2026-10-21" })], [source(Array.from({ length: 1100 }, () => "Дата публикации: 21.10.2026").join("\n"))]);
    expect(codes(audit)).toContain("audit-limit");
  });
  it("bounds a single oversized row and never confirms its unexamined suffix", () => {
    const text = `Закупка QA ${"X".repeat(25000)} Заказчик: ООО За пределами`;
    const audit = auditIntelligenceResult([item({ customer: "ООО За пределами" })], [source(text)]);
    expect(fieldStatus(audit, "customer")?.status).toBe("unverified"); expect(codes(audit)).toContain("audit-limit");
  });
  it("bounds indexing of long non-email and malformed email tokens", () => {
    const started = performance.now();
    const audit = auditIntelligenceResult([item({ contactEmail: "qa@example.test" }, "proposals")], [source(`${"X".repeat(19000)}\n${"a".repeat(19000)}@.`)]);
    expect(fieldStatus(audit, "contactEmail")?.status).toBe("unverified"); expect(performance.now() - started).toBeLessThan(500);
  });
  it("retains ordinary email indexing while requiring its explicitly labeled party", () => {
    const audit = auditIntelligenceResult([item({ contactEmail: "qa.supplier+1@example.test", recipientContact: "qa.buyer@example.test" }, "proposals")], [source("Поставщик: ООО QA\nEmail: qa.supplier+1@example.test\nЗаказчик: ООО Банк QA\nEmail: qa.buyer@example.test")]);
    expect(audit.fields.map((entry) => entry.status)).toEqual(["confirmed", "confirmed"]);
  });
  it("confirms a same-sheet Excel total only in its explicit ruble NMC column", () => {
    const fragments = [
      { id: "header", locator: "Лист QA, A3:P3", sheetId: "qa", sheetState: "visible" as const, includedByUser: false, text: "Наименование\tЦена за единицу, руб.\tН(М)Ц договора, с округлением цены за единицу (руб.)", cells: [{ reference: "A3", text: "Наименование", valueType: "text" }, { reference: "D3", text: "Цена за единицу, руб.", valueType: "text" }, { reference: "P3", text: "Н(М)Ц договора, с округлением цены за единицу (руб.)", valueType: "text" }] },
      { id: "total", locator: "Лист QA, A7:P7", sheetId: "qa", sheetState: "visible" as const, includedByUser: false, text: "Итого\t431000\t876543.21", cells: [{ reference: "A7", text: "Итого", valueType: "text" }, { reference: "D7", text: "431000", rawValue: "431000", valueType: "number" }, { reference: "P7", text: "876543.21", rawValue: "876543.21", valueType: "number" }] },
    ];
    const correct = auditIntelligenceResult([item({ nmc: 876543.21 })], [source("", { fragments })]);
    expect(fieldStatus(correct, "nmc")?.status).toBe("confirmed"); expect(codes(correct)).not.toContain("missing-price");
    const wrong = auditIntelligenceResult([item({ nmc: 431000 })], [source("", { fragments })]);
    expect(fieldStatus(wrong, "nmc")?.status).toBe("conflict");
    const anotherSheet = auditIntelligenceResult([item({ nmc: 876543.21 })], [source("", { fragments: [fragments[0], { ...fragments[1], sheetId: "unrelated" }] })]);
    expect(fieldStatus(anotherSheet, "nmc")?.status).not.toBe("confirmed");
    const foreignHeader = { ...fragments[0], text: fragments[0].text.replace("(руб.)", "(USD)"), cells: fragments[0].cells.map((cell) => ({ ...cell, text: cell.text.replace("(руб.)", "(USD)") })) };
    expect(fieldStatus(auditIntelligenceResult([item({ nmc: 876543.21 })], [source("", { fragments: [foreignHeader, fragments[1]] })]), "nmc")?.status).not.toBe("confirmed");
    const hiddenHeader = { ...fragments[0], sheetState: "hidden" as const, includedByUser: false };
    expect(fieldStatus(auditIntelligenceResult([item({ nmc: 876543.21 })], [source("", { fragments: [hiddenHeader, fragments[1]] })]), "nmc")?.status).not.toBe("confirmed");
    const changedHeader = { ...foreignHeader, id: "changed-header", locator: "Лист QA, P4", cells: foreignHeader.cells.map((cell) => ({ ...cell, reference: cell.reference.replace("3", "4") })) };
    expect(fieldStatus(auditIntelligenceResult([item({ nmc: 876543.21 })], [source("", { fragments: [fragments[0], changedHeader, fragments[1]] })]), "nmc")?.status).not.toBe("confirmed");
    const missingHeader = { ...fragments[0], text: "НМЦ не указана, руб.", cells: [{ reference: "P3", text: "НМЦ не указана, руб.", valueType: "text" }] };
    expect(fieldStatus(auditIntelligenceResult([item({ nmc: 876543.21 })], [source("", { fragments: [missingHeader, fragments[1]] })]), "nmc")?.status).not.toBe("confirmed");
    const vat = { ...fragments[1], text: "Итого НДС\t876543.21", cells: [{ reference: "A7", text: "Итого НДС", valueType: "text" }, fragments[1].cells[2]] };
    expect(fieldStatus(auditIntelligenceResult([item({ nmc: 876543.21 })], [source("", { fragments: [fragments[0], vat] })]), "nmc")?.status).not.toBe("confirmed");
    const otherSource = auditIntelligenceResult([item({ nmc: 876543.21 }, "procurement", { sourceIds: ["total-only"] })], [source("", { fragments: [fragments[0]] }), source("", { id: "total-only", fragments: [fragments[1]] })]);
    expect(fieldStatus(otherSource, "nmc")?.status).not.toBe("confirmed");
  });
  it.each(["Итого по разделу 1", "Всего по разделу 2", "Итого: подытог", "Итого, промежуточный итог", "Промежуточный итог"])("does not treat a subtotal as overall NMC or close its column heading: %s", (subtotal) => {
    const fragments = [
      { id: "header", locator: "Лист QA, P1", sheetId: "qa", sheetState: "visible" as const, text: "НМЦ, руб.", cells: [{ reference: "P1", text: "НМЦ, руб.", valueType: "text" }] },
      { id: "subtotal", locator: "Лист QA, A9:P9", sheetId: "qa", sheetState: "visible" as const, text: `${subtotal}\t100`, cells: [{ reference: "A9", text: subtotal, valueType: "text" }, { reference: "P9", text: "100", rawValue: "100", valueType: "number" }] },
      { id: "total", locator: "Лист QA, A10:P10", sheetId: "qa", sheetState: "visible" as const, text: "Всего\t200", cells: [{ reference: "A10", text: "Всего", valueType: "text" }, { reference: "P10", text: "200", rawValue: "200", valueType: "number" }] },
    ];
    const wrong = auditIntelligenceResult([item({ nmc: 100 })], [source("", { fragments })]);
    expect(fieldStatus(wrong, "nmc")?.status).not.toBe("confirmed"); expect(getBlockingEvidenceFindings(wrong, "item-a").length).toBeGreaterThan(0);
    const correct = auditIntelligenceResult([item({ nmc: 200 })], [source("", { fragments })]);
    expect(fieldStatus(correct, "nmc")?.status).toBe("confirmed");
    expect(correct.coverage.filter((check) => check.category === "price").map((check) => check.label)).toEqual(["Явная общая цена: 200"]);
  });
  it("assembles explicit NMC rubles and kopeks around bounded written-out words", () => {
    const quote = "Начальная (максимальная) цена договора составляет: 876 543 (восемьсот семьдесят шесть тысяч пятьсот сорок три) руб., 21 коп., в том числе НДС";
    const card = item({ nmc: 876543.21 }, "procurement", { evidence: [{ field: "nmc", sourceId: "source-a", quote }] });
    const audit = auditIntelligenceResult([card], [source(quote)]);
    expect(fieldStatus(audit, "nmc")?.status).toBe("confirmed"); expect(codes(audit)).not.toContain("evidence-does-not-support-value");
    expect(audit.coverage.filter((check) => check.category === "price").map((check) => check.label)).toEqual(["Явная общая цена: 876543.21"]);
    expect(fieldStatus(auditIntelligenceResult([item({ nmc: 876543 })], [source(quote)]), "nmc")?.status).toBe("conflict");
    const short = "НМЦ: 876543 руб., 21 коп.";
    expect(fieldStatus(auditIntelligenceResult([item({ nmc: 876543.21 })], [source(short)]), "nmc")?.status).toBe("confirmed");
    expect(fieldStatus(auditIntelligenceResult([item({ nmc: 876543 })], [source(short)]), "nmc")?.status).toBe("conflict");
    expect(fieldStatus(auditIntelligenceResult([item({ nmc: 876543 })], [source("НМЦ: 876543 руб., 121 коп.")]), "nmc")?.status).toBe("conflict");
  });
  it("canonicalizes a genuine date quote without treating a different event as evidence", () => {
    const quote = "Поставка оборудования не позднее 11.04.2031 года.";
    const card = item({ executionEndDate: "2031-04-11" }, "procurement", { evidence: [{ field: "executionEndDate", sourceId: "source-a", fragmentId: "delivery", quote }] });
    const audit = auditIntelligenceResult([card], [source("", { fragments: [{ id: "delivery", locator: "Абзац QA", text: quote }] })]);
    expect(fieldStatus(audit, "executionEndDate")?.status).toBe("confirmed"); expect(codes(audit)).not.toContain("evidence-does-not-support-value");
    const otherEvent = auditIntelligenceResult([card], [source("", { fragments: [{ id: "delivery", locator: "Абзац QA", text: quote.replace("Поставка оборудования не позднее", "Подведение итогов:") }] })]);
    expect(codes(otherEvent)).toContain("semantic-conflict"); expect(codes(otherEvent)).toContain("invalid-evidence-quote");
  });
  it.each(["7.", "8)", "9.2."])("does not require a document-list index to survive in business text: %s", (prefix) => {
    const condition = "Декларация участника с приложением подтверждения за последние 30 дней.";
    const correct = auditIntelligenceResult([item({ requirements: [condition] })], [source(`${prefix} ${condition}`)]);
    expect(correct.coverage.find((check) => check.category === "document")?.status).toBe("covered"); expect(codes(correct)).not.toContain("missing-document");
    const wrong = auditIntelligenceResult([item({ requirements: [condition.replace("30", "60")] })], [source(`${prefix} ${condition}`)]);
    expect(codes(wrong)).toContain("missing-document");
  });
  it.each(["–", "—", "\t"])("recognizes explicit company roles with a normal separator: %s", (separator) => {
    const text = `Поставщик ${separator} ООО Поставщик QA; Организатор ${separator} ООО Заказчик QA`;
    const audit = auditIntelligenceResult([item({ issuerName: "ООО Поставщик QA", recipientName: "ООО Заказчик QA" }, "proposals")], [source(text)]);
    expect(audit.fields.map((field) => field.status)).toEqual(["confirmed", "confirmed"]);
    const wrong = auditIntelligenceResult([item({ recipientName: "ООО Поставщик QA" }, "proposals")], [source(text)]);
    expect(fieldStatus(wrong, "recipientName")?.status).toBe("conflict");
  });
  it("carries an explicit source-wide timezone into the submission coverage label", () => {
    const fragments = [{ id: "zone", locator: "Примечание QA", text: "Время в документе указано в часовом поясе MSK." }, { id: "deadline", locator: "Таблица QA", text: "Приём предложений до\t11.04.2031, 13:30" }];
    const missing = auditIntelligenceResult([item({ submissionDeadline: "2031-04-11", notes: "Подача 13:30" })], [source("", { fragments })]);
    expect(codes(missing)).toContain("missing-deadline-time");
    expect(missing.coverage.find((check) => check.category === "deadline-time")?.label).toContain("MSK");
    const fixed = auditIntelligenceResult([item({ submissionDeadline: "2031-04-11", notes: "Подача 13:30 МСК" })], [source("", { fragments })]);
    expect(fixed.coverage.find((check) => check.category === "deadline-time")?.status).toBe("covered");
    expect(missing.coverage.find((check) => check.category === "deadline-time")?.supportingEvidence?.[0].fragmentId).toBe("zone");
  });
  it("does not borrow a global timezone from another source or an excluded hidden fragment", () => {
    const deadline = source("Срок подачи заявок: 11.04.2031 13:30", { id: "deadline" });
    const card = item({ submissionDeadline: "2031-04-11", notes: "Подача 13:30" }, "procurement", { sourceIds: ["deadline"] });
    const other = source("Время в документе указано в MSK.");
    expect(auditIntelligenceResult([card], [deadline, other]).coverage.find((check) => check.category === "deadline-time")?.label).not.toContain("MSK");
    const hidden = { id: "zone", locator: "История QA", sheetState: "hidden" as const, includedByUser: false, text: other.text };
    const current = { id: "deadline", locator: "Текущий QA", text: deadline.text };
    expect(auditIntelligenceResult([item(card.fields)], [source("", { fragments: [hidden, current] })]).coverage.find((check) => check.category === "deadline-time")?.label).not.toContain("MSK");
  });
  it("keeps conflicting common zones uncertain and lets only an explicit local zone override them", () => {
    const prefix = "Время в документе указано в MSK.\nВремя в документе указано в UTC.\n";
    const card = item({ submissionDeadline: "2031-04-11", notes: "Подача 13:30 MSK" });
    const uncertain = auditIntelligenceResult([card], [source(`${prefix}Срок подачи заявок: 11.04.2031 13:30`)]);
    expect(uncertain.coverage.find((check) => check.category === "deadline-time")?.status).toBe("uncertain"); expect(codes(uncertain)).toContain("missing-deadline-time");
    const explicit = auditIntelligenceResult([card], [source(`${prefix}Срок подачи заявок: 11.04.2031 13:30 MSK`)]);
    expect(explicit.coverage.find((check) => check.category === "deadline-time")?.status).toBe("covered");
  });
  it("accepts exact supporting excerpts inside a composed note but not unrelated evidence", () => {
    const quote = "Срок подачи заявок: 11.04.2031 13:30 MSK";
    const fields = { submissionDeadline: "2031-04-11", notes: `Моя заметка\nПодача: 2031-04-11 13:30 MSK — ${quote}` };
    const card = item(fields, "procurement", { evidence: [{ field: "notes", sourceId: "source-a", quote }] });
    expect(codes(auditIntelligenceResult([card], [source(quote)]))).not.toContain("evidence-does-not-support-value");
    const wrong = { ...card, evidence: [{ field: "notes", sourceId: "source-a", quote: "Другой фрагмент" }] };
    expect(codes(auditIntelligenceResult([wrong], [source(`${quote}\nДругой фрагмент`) ]))).toContain("evidence-does-not-support-value");
  });
  it("confirms a literal multiline proposal description within one selected fragment", () => {
    const text = "Сервер QA-A\nCPU-A\nRAM-A\nDisk-A\nСервер QA-B\nCPU-B\nRAM-B";
    const card = item({ lines: ["Сервер QA-A", "Сервер QA-B"], lineDescriptions: ["CPU-A\nRAM-A\nDisk-A", "CPU-B\nRAM-B"] }, "proposals", { evidence: [{ field: "lineDescriptions", sourceId: "source-a", quote: "CPU-A" }] });
    const audit = auditIntelligenceResult([card], [source(text)]);
    expect(fieldStatus(audit, "lineDescriptions")?.status).toBe("confirmed"); expect(getBlockingEvidenceFindings(audit, card)).toHaveLength(0);
    const unknownSuffix = { ...card, fields: { ...card.fields, lineDescriptions: ["CPU-A\nRAM-A\nDisk-A\n99%", "CPU-B\nRAM-B"] } };
    const unknownAudit = auditIntelligenceResult([unknownSuffix], [source(text)]);
    expect(fieldStatus(unknownAudit, "lineDescriptions")?.status).toBe("unverified"); expect(getBlockingEvidenceFindings(unknownAudit, unknownSuffix).some((finding) => finding.field === "lineDescriptions")).toBe(true);
    const split = source(text, { fragments: [{ id: "a", locator: "Страница A", text: "Сервер QA-A\nCPU-A" }, { id: "b", locator: "Страница B", text: "RAM-A\nDisk-A\nСервер QA-B\nCPU-B\nRAM-B" }] });
    expect(fieldStatus(auditIntelligenceResult([card], [split]), "lineDescriptions")?.status).toBe("unverified");
    const hidden = source(text, { fragments: [{ id: "hidden", locator: "История QA", sheetState: "hidden", includedByUser: false, text }] });
    expect(fieldStatus(auditIntelligenceResult([card], [hidden]), "lineDescriptions")?.status).toBe("unverified");
    const other = source(text, { id: "other" });
    expect(fieldStatus(auditIntelligenceResult([card], [source("Нет описания"), other]), "lineDescriptions")?.status).toBe("unverified");
  });
  it.each(["notes", "paymentTerms"])("does not let an email hide unsupported suffixes in %s", (field) => {
    const quote = "Наш контакт: qa@example.org";
    const card = item({ [field]: "qa@example.org; 99%" }, field === "paymentTerms" ? "proposals" : "procurement", { evidence: [{ field, sourceId: "source-a", quote }] });
    const audit = auditIntelligenceResult([card], [source(quote)]);
    expect(fieldStatus(audit, field)?.status).toBe("unverified"); expect(codes(audit)).toContain("evidence-does-not-support-value");
    if (field === "paymentTerms") expect(getBlockingEvidenceFindings(audit, card).length).toBeGreaterThan(0);
  });
  it("retains exact pure-email/list comparisons without accepting a longer email domain", () => {
    const text = "Поставщик: ООО QA\nEmail: qa@example.org; second@example.org\nЗаказчик: ООО Покупатель QA\nEmail: buyer@example.org";
    const correct = auditIntelligenceResult([item({ contactEmail: "qa@example.org; second@example.org" }, "proposals")], [source(text)]);
    expect(fieldStatus(correct, "contactEmail")?.status).toBe("confirmed");
    const wrong = auditIntelligenceResult([item({ contactEmail: "qa@example.org" }, "proposals")], [source("Поставщик: ООО QA\nEmail: qa@example.org.evil")]);
    expect(fieldStatus(wrong, "contactEmail")?.status).toBe("unverified");
    const otherRole = auditIntelligenceResult([item({ contactEmail: "buyer@example.org" }, "proposals")], [source(text)]);
    expect(fieldStatus(otherRole, "contactEmail")?.status).toBe("conflict");
  });
  it("makes structural cell-budget exhaustion visible rather than reading unbounded metadata", () => {
    const fragments = [{ id: "metadata", locator: "Лист QA", sheetId: "qa", text: "QA", cells: Array.from({ length: 20001 }, () => ({ reference: "A1", text: "", valueType: "empty" })) }];
    expect(codes(auditIntelligenceResult([item({ name: "QA" })], [source("", { fragments })]))).toContain("audit-limit");
  });
});
