import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceDestination, IntelligenceFieldValue, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

// Deliberately invented fixtures: no private audit documents or model output.
const source = (text: string, extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "qa83-source", name: "Синтетические материалы QA83", text, ...extra });
const item = (fields: Record<string, IntelligenceFieldValue>, destination: IntelligenceDestination = "procurement", extra: Partial<IntelligenceItem> = {}): IntelligenceItem => ({ id: "qa83-item", title: "Проверка карточки QA83", destination, fields, selectedFields: Object.keys(fields), sourceIds: ["qa83-source"], ...extra });
const field = (report: ReturnType<typeof auditIntelligenceResult>, name: string, itemId = "qa83-item") => report.fields.find((entry) => entry.field === name && entry.itemId === itemId);
const time = (report: ReturnType<typeof auditIntelligenceResult>) => report.coverage.find((entry) => entry.category === "deadline-time");
const deadline = "Срок подачи заявок: 18.05.2034, 11:20 MSK";

describe("D03 generic result-title safeguard", () => {
  it.each(["Закупка", "Тендер", "Договор", "Контракт", "КП", "Коммерческое предложение", "Карточка", "Компания", "Сотрудник", "Документ"])("warns about the exact generic title without changing or blocking its value: %s", (title) => {
    const card = item({ notes: "Документ" }, "procurement", { title });
    const original = JSON.stringify(card);
    const report = auditIntelligenceResult([card], [source("Документ")]);
    expect(report.findings.find((entry) => entry.code === "placeholder-title")?.severity).toBe("warning");
    expect(report.findings.some((entry) => entry.code === "placeholder-value")).toBe(false);
    expect(getBlockingEvidenceFindings(report, card)).toEqual([]);
    expect(field(report, "notes")?.status).toBe("confirmed");
    expect(JSON.stringify(card)).toBe(original);
  });
  it.each(["Закупка серверов QA-83", "КП Dell PowerEdge R760", "Коммерческое предложение СБК-ИИ-А", "Контракт ИТ/А", "Тендер ИБ-QA83", "Документ о поставке СЕРВЕР-QA"])("does not flag a meaningful Latin/Cyrillic product or subject title: %s", (title) => {
    expect(auditIntelligenceResult([item({ notes: "Документ" }, "procurement", { title })], [source("Документ")]).findings.some((entry) => entry.code === "placeholder-title")).toBe(false);
  });
});

describe("QA83 event-local submission provenance", () => {
  it("D02-R83 recognizes an explicit document-wide zone after a revision prefix", () => {
    const declaration = "Редакция извещения от 10.05.2034, 09:10, время в документе указано в часовом поясе MSK";
    const input = source(`${declaration}\nСрок подачи заявок: 18.05.2034, 11:20`);
    const missing = auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes: "Подача 11:20" })], [input]);
    expect(time(missing)?.label).toContain("MSK");
    expect(time(missing)?.status).toBe("missing");
    expect(time(missing)?.supportingEvidence?.[0].quote).toBe(declaration);
    const complete = auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes: "Подача 11:20 MSK" })], [input]);
    expect(time(complete)?.status).toBe("covered");
    expect(time(complete)?.evidence.quote).toBe("Срок подачи заявок: 18.05.2034, 11:20");
  });
  it.each([false, true])("preserves a glued zone after an explicit global timezone phrase (fragments=%s)", (fragmented) => {
    const declaration = "Редакция извещения от 10.05.2034,09:10, время в документе указано в часовом поясеMSK";
    const text = `${declaration}\nПриём предложений до 18.05.2034,11:20.`;
    const input = source(text, fragmented ? { fragments: [{ id: "page", locator: "Страница QA", text }] } : {});
    const report = auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes: "" })], [input]);
    expect(time(report)?.label).toContain("MSK");
    expect(time(report)?.status).toBe("missing");
    expect(time(report)?.supportingEvidence?.[0].quote).toBe(declaration);
    const notes = `${time(report)!.label} — ${time(report)!.evidence.quote}\n${declaration}`;
    expect(time(auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes })], [input]))?.status).toBe("covered");
  });
  it.each([
    "Редакция извещения от 10.05.2034, 09:10 MSK",
    "Редакция извещения от 10.05.2034, время публикации в документе указано в MSK",
    "Редакция извещения от 10.05.2034 MSK, время в документе указано без пояса",
    "Редакция извещения от 10.05.2034, время публикации в документе указано в часовом поясеMSK",
    "Время в документе указано без поясаMSK",
  ])("does not turn a different event's zone into a common rule: %s", (declaration) => {
    const report = auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes: "Подача 11:20" })], [source(`${declaration}\nСрок подачи заявок: 18.05.2034, 11:20`)]);
    expect(time(report)?.label).not.toContain("MSK");
    expect(time(report)?.supportingEvidence).toBeUndefined();
  });
  it.each(["Подача 11:20 MSK 19.05.2034", "Подача 18.05.2034 11:20 MSK, 19.05.2034", "Подача 11:20 2034-05-19", "Подача 11:20 MSK 31.02.2034"])("N12 rejects a contradictory or invalid date after the time: %s", (notes) => {
    const card = item({ submissionDeadline: "2034-05-18", notes });
    const report = auditIntelligenceResult([card], [source(deadline)]);
    expect(time(report)?.status).toBe("missing");
    expect(getBlockingEvidenceFindings(report, card).some((entry) => entry.code === "missing-deadline-time")).toBe(true);
  });
  it.each(["Подача 11:20 MSK 18.05.2034", "Подача 11:20 UTC+3, 2034-05-18", "Подача 18.05.2034 11:20 MSK, 18.05.2034"])("accepts a matching date after the clock: %s", (notes) => {
    expect(time(auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes })], [source(deadline)]))?.status).toBe("covered");
  });
  it("does not attach a different explicitly labelled event after the clock", () => {
    const notes = "Подача 11:20 MSK, дата редакции 19.05.2034 09:00 UTC";
    expect(time(auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes })], [source(deadline)]))?.status).toBe("covered");
  });
  it("does not ignore a wrong following date even when the source has no timezone", () => {
    expect(time(auditIntelligenceResult([item({ submissionDeadline: "2034-05-18", notes: "Подача 11:20 19.05.2034" })], [source("Срок подачи заявок: 18.05.2034, 11:20")]))?.status).toBe("missing");
  });
});

describe("QA83 roles, contract numbers and wrapped addresses", () => {
  it.each([". ", "; ", "\t", "\n"])("N13 binds a value to its explicit role across %j", (separator) => {
    const text = `Поставщик: ООО «Орбита QA»${separator}Заказчик: АО «Сфера QA».`;
    const correct = auditIntelligenceResult([item({ issuerName: "ООО «Орбита QA»", recipientName: "АО «Сфера QA»" }, "proposals")], [source(text)]);
    expect(correct.fields.map((entry) => entry.status)).toEqual(["confirmed", "confirmed"]);
    const wrong = auditIntelligenceResult([item({ issuerName: "АО «Сфера QA»", recipientName: "ООО «Орбита QA»" }, "proposals")], [source(text)]);
    expect(wrong.fields.map((entry) => entry.status)).toEqual(["conflict", "conflict"]);
  });
  it("keeps dots inside a legal name and carries the final explicit role forward", () => {
    const text = "Поставщик: ООО им. А.С. Попова. Заказчик: АО «Сфера QA»\nТелефон: +7 900 123 45 67";
    const report = auditIntelligenceResult([item({ issuerName: "ООО им. А.С. Попова", contactPhone: "+7 900 123 45 67", recipientContact: "+7 900 123 45 67" }, "proposals")], [source(text)]);
    expect(field(report, "issuerName")?.status).toBe("confirmed");
    expect(field(report, "contactPhone")?.status).toBe("conflict");
    expect(field(report, "recipientContact")?.status).toBe("confirmed");
  });
  it("ends a role at the next explicitly labelled opposite-party contact", () => {
    const text = "Поставщик: ООО «Орбита QA». Контакт заказчика: Петрова Тестовая";
    const report = auditIntelligenceResult([item({ contactName: "Петрова Тестовая", addresseeName: "Петрова Тестовая" }, "proposals")], [source(text)]);
    expect(field(report, "contactName")?.status).toBe("conflict");
    expect(field(report, "addresseeName")?.status).toBe("confirmed");
  });
  it.each(["ДОГОВОР ПОСТАВКИ №________", "Договор поставки № 41/2034-QA", "Приложение № 41/2034-QA к договору поставки"])("N15 does not confirm the document type as its identifier: %s", (text) => {
    const card = item({ number: "Договор поставки" }, "contracts", { evidence: [{ field: "number", sourceId: "qa83-source", quote: text }] });
    const report = auditIntelligenceResult([card], [source(text)]);
    expect(field(report, "number")?.status).not.toBe("confirmed");
    expect(getBlockingEvidenceFindings(report, card).some((entry) => entry.field === "number")).toBe(true);
  });
  it.each(["Договор поставки № 41/2034-QA", "Номер договора: 41/2034-QA", "№ договора: 41/2034-QA", "Контракт №41/2034-QA от 10.05.2034"])("accepts a filled alphanumeric/slash identifier: %s", (text) => {
    expect(field(auditIntelligenceResult([item({ number: "41/2034-QA" }, "contracts")], [source(text)]), "number")?.status).toBe("confirmed");
  });
  it.each(["Приложение № 41/2034-QA к договору", "Федеральный закон № 41/2034-QA", "Доверенность № 41/2034-QA", "Договор поставки №____, приложение №41/2034-QA", "Договор поставки, доверенность №41/2034-QA", "Договор поставки, спецификация №41/2034-QA"])("does not borrow another document's number: %s", (text) => {
    expect(field(auditIntelligenceResult([item({ number: "41/2034-QA" }, "contracts")], [source(text)]), "number")?.status).not.toBe("confirmed");
  });
  it("rejects a substring of a longer contract identifier", () => {
    expect(field(auditIntelligenceResult([item({ number: "41/2034" }, "contracts")], [source("Договор поставки №41/2034-QA")]), "number")?.status).not.toBe("confirmed");
  });
  it("accepts a short numeric identifier but does not fill a partial template", () => {
    expect(field(auditIntelligenceResult([item({ number: "7" }, "contracts")], [source("Договор № 7")]), "number")?.status).toBe("confirmed");
    for (const number of ["7", "7___"]) expect(field(auditIntelligenceResult([item({ number }, "contracts")], [source("Договор № 7___")]), "number")?.status).not.toBe("confirmed");
  });
  it.each(["ИТ/А", "ABC", "СВ", "А", "б/н"])("accepts a filled letter-only identifier in an explicit number slot: %s", (number) => {
    const report = auditIntelligenceResult([item({ number }, "contracts")], [source(`Номер договора: ${number}`)]);
    expect(field(report, "number")?.status).toBe("confirmed");
  });
  it.each(["Договор", "Поставки", "Приложение", "Номер", "Не", "От", "Указать", "Неуказано", "Неприсвоен", "TBD", "ABC___"])("does not treat a service word or partial placeholder after the number label as a filled identifier: %s", (number) => {
    expect(field(auditIntelligenceResult([item({ number }, "contracts")], [source(`Договор поставки № ${number}`)]), "number")?.status).not.toBe("confirmed");
  });
  const address = "123456, г. Тестоград, улица Опытная, д.7";
  const wrapped = "Адрес местонахождения: 123456, г. Тестоград,\nулица Опытная, д.7";
  it("N16 folds only whitespace inside one actual wrapped address", () => {
    const card = item({ address }, "counterparties", { evidence: [{ field: "address", sourceId: "qa83-source", fragmentId: "address", quote: address }] });
    const report = auditIntelligenceResult([card], [source("unused", { fragments: [{ id: "address", locator: "Строка адреса", text: wrapped }] })]);
    expect(field(report, "address")?.status).toBe("confirmed");
    expect(field(report, "address")?.evidence[0].quote).toBe(wrapped);
    expect(getBlockingEvidenceFindings(report, card)).toEqual([]);
    expect(field(auditIntelligenceResult([item({ address: address.replace("д.7", "д.8") }, "counterparties")], [source(wrapped)]), "address")?.status).not.toBe("confirmed");
  });
  it("retains ownership checks for a wrapped supplier address", () => {
    const text = wrapped.replace("Адрес местонахождения", "Адрес поставщика");
    expect(field(auditIntelligenceResult([item({ recipientAddress: address }, "proposals")], [source(text)]), "recipientAddress")?.status).toBe("conflict");
  });
  it("does not concatenate fragments, sources, table cells or a new address", () => {
    const fragments = [{ id: "a", locator: "Страница 1", text: "Адрес: 123456, г. Тестоград," }, { id: "b", locator: "Страница 2", text: "улица Опытная, д.7" }];
    expect(field(auditIntelligenceResult([item({ address }, "counterparties")], [source("unused", { fragments })]), "address")?.status).not.toBe("confirmed");
    expect(field(auditIntelligenceResult([item({ address }, "counterparties", { sourceIds: ["qa83-source", "other"] })], [source(fragments[0].text), source(fragments[1].text, { id: "other" })]), "address")?.status).not.toBe("confirmed");
    for (const text of ["Адрес: 123456, г. Тестоград,\nАдрес поставки: улица Опытная, д.7", "Адрес: 123456, г. Тестоград,\nАдрес: улица Опытная, д.7", "Адрес: 123456, г. Тестоград,\tулица Опытная, д.7"]) {
      expect(field(auditIntelligenceResult([item({ address }, "counterparties")], [source(text)]), "address")?.status).not.toBe("confirmed");
    }
  });
});

describe("N14 explicit review of multi-lot deadline association", () => {
  const text = "Лот 1: Поставка оборудования QA\nСрок подачи: 18.05.2034, 11:20 MSK\nЛот 2: Проверка системы QA\nСрок подачи: 19.05.2034, 15:30 MSK";
  it.each([false, true])("requires an explicit review even if values occur somewhere in the source (swapped=%s)", (swapped) => {
    const cards = [item({ name: "Лот 1: Поставка оборудования QA", submissionDeadline: swapped ? "2034-05-19" : "2034-05-18", notes: swapped ? "Срок подачи: 19.05.2034, 15:30 MSK" : "Срок подачи: 18.05.2034, 11:20 MSK" }, "procurement", { id: "lot-1" }), item({ name: "Лот 2: Проверка системы QA", submissionDeadline: swapped ? "2034-05-18" : "2034-05-19", notes: swapped ? "Срок подачи: 18.05.2034, 11:20 MSK" : "Срок подачи: 19.05.2034, 15:30 MSK" }, "procurement", { id: "lot-2" })];
    const report = auditIntelligenceResult(cards, [source(text)]);
    expect(report.coverage.filter((entry) => entry.category === "deadline-time").every((entry) => entry.status === "uncertain")).toBe(true);
    for (const card of cards) {
      const finding = getBlockingEvidenceFindings(report, card).find((entry) => entry.code === "ambiguous-lot-deadline");
      expect(finding).toBeDefined();
      expect(finding?.message).toMatch(/лот|привяз/u);
      expect(getBlockingEvidenceFindings(report, card, [finding!.id]).some((entry) => entry.code === "ambiguous-lot-deadline")).toBe(false);
      const changed = { ...card, fields: { ...card.fields, notes: `${card.fields.notes}\nУточнение лота QA` } };
      const changedReport = auditIntelligenceResult([changed, ...cards.filter((entry) => entry.id !== card.id)], [source(text)]);
      expect(getBlockingEvidenceFindings(changedReport, changed, [finding!.id]).some((entry) => entry.code === "ambiguous-lot-deadline")).toBe(true);
    }
  });
  it("does not impose multi-lot uncertainty on one lot or discarded fragments", () => {
    const rows = text.split("\n");
    const card = item({ submissionDeadline: "2034-05-18", notes: "Подача 11:20 MSK" });
    for (const input of [source(rows.slice(0, 2).join("\n")), source("unused", { fragments: [{ id: "current", locator: "Лот QA", text: rows.slice(0, 2).join("\n") }, { id: "hidden", locator: "История QA", sheetState: "hidden", text: rows.slice(2).join("\n") }] })]) {
      const report = auditIntelligenceResult([card], [input]);
      expect(time(report)?.status).toBe("covered");
      expect(report.findings.some((entry) => entry.code === "ambiguous-lot-deadline")).toBe(false);
    }
  });
  it("does not waive an out-of-source date just because lots are ambiguous", () => {
    const card = item({ submissionDeadline: "2034-05-20", notes: "Подача 11:20 MSK" });
    const report = auditIntelligenceResult([card], [source(text)]);
    expect(field(report, "submissionDeadline")?.status).toBe("unverified");
    expect(getBlockingEvidenceFindings(report, card).some((entry) => entry.field === "submissionDeadline")).toBe(true);
  });
});
