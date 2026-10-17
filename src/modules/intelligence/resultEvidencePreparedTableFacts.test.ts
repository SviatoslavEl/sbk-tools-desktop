import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import { runResponsePreparation } from "./responsePreparationWorker";
import { prepareIntelligenceSourceFacts } from "./sourcePreparedFacts";
import type { IntelligenceEvidence, IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const fragment = (text: string, row: number, table = "table-1"): IntelligenceFragment => ({ id: `${table}-row-${row}`, locator: `Таблица ${table}, строка ${row}`, text });
const source = (fragments: IntelligenceFragment[], id = "qa-source"): IntelligenceSource => ({ id, name: "Синтетическая таблица QA", fragments, text: fragments.map((part) => part.text).join("\n") });
const header = "№ п/п\tЗаказчик (наименование)\tПредмет договора\tСумма договора, рублей";
const row = (serial: number, number = `QA-${serial}/35`, date = `${String(serial).padStart(2, "0")}.05.2035`, client = `АО «Компания ${serial}»`, amount = `${serial} 234 567,89`) => `${serial}.\t${client}\tУслуги аудита. Договор № ${number} от ${date}.\t${amount}`;
const contracts = (count = 5) => source([fragment(header, 1), ...Array.from({ length: count }, (_, index) => fragment(row(index + 1), index + 2))]);
const nmc = () => source([
  fragment("№\tНаименование\tКол-во\tЦены рынка\t\tН(М)Ц за единицу\t", 4, "sheet-3"),
  fragment("\t\t\tПоставщик 1\tПоставщик 2\tМинимальная цена\tН(М)Ц договора, с учетом округления цены за единицу (руб.)", 5, "sheet-3"),
  fragment("\t\t\tЦена за единицу\tЦена за единицу\t\t", 6, "sheet-3"),
  fragment("1.1.\tТовар\t10\t2115000\t2520000\t2115000\t21150000", 7, "sheet-3"),
  fragment("\tИтого, включая НДС:\t10\t21150000\t25200000\t2115000\t21150000", 8, "sheet-3"),
]);
const card = (destination: IntelligenceItem["destination"], fields: IntelligenceItem["fields"], id = "qa-card"): IntelligenceItem => ({ id, title: "Аудит QA", destination, fields, selectedFields: Object.keys(fields), sourceIds: ["qa-source"], evidence: [] });
const claim = (input: IntelligenceSource, part: IntelligenceFragment, field: string): IntelligenceEvidence => ({ field, sourceId: input.id, fragmentId: part.id, quote: part.text });
const status = (items: IntelligenceItem[], input: IntelligenceSource[], field: string, id = items[0].id) => auditIntelligenceResult(items, input).fields.find((entry) => entry.itemId === id && entry.field === field)?.status;
const prepareContracts = (input = contracts()) => prepareIntelligenceSourceFacts([], [input], ["contracts"]).items;
const prepareNmc = (input = nmc()) => prepareIntelligenceSourceFacts([card("procurement", { nmc: 1 })], [input]).items;

describe("prepared table facts retain independent row/column evidence", () => {
  it("accepts all five source-first worker candidates with their own customer and contract total", () => {
    const input = contracts(), raw = JSON.stringify({ items: [{ destination: "contracts", title: "Справка об опыте QA", fields: { number: "QA-1/35" } }] });
    const before = structuredClone({ input, raw });
    const reply = runResponsePreparation({ revision: 1, raw, sources: [input], destinations: ["contracts"] });
    expect(reply.failed).toBeUndefined(); const items = reply.prepared!.items;
    expect(items).toHaveLength(5);
    const report = auditIntelligenceResult(items, [input]);
    for (const item of items) {
      expect(report.fields.find((entry) => entry.itemId === item.id && entry.field === "customer")?.status).toBe("confirmed");
      expect(report.fields.find((entry) => entry.itemId === item.id && entry.field === "amount")?.status).toBe("confirmed");
      expect(getBlockingEvidenceFindings(report, item)).toEqual([]);
      expect(report.fields.find((entry) => entry.itemId === item.id && entry.field === "amount")?.evidence.map((entry) => entry.quote)).toEqual([item.evidence!.find((entry) => entry.field === "amount")!.quote, header]);
    }
    expect({ input, raw }).toEqual(before);
  });

  it("accepts exact total NMC with separate literal market-table headers, not the unit price", () => {
    const input = nmc(), items = prepareNmc(input), before = structuredClone(items);
    const report = auditIntelligenceResult(items, [input]);
    expect(items[0].fields.nmc).toBe(21150000);
    expect(status(items, [input], "nmc")).toBe("confirmed");
    expect(getBlockingEvidenceFindings(report, items[0]).filter((entry) => entry.field === "nmc")).toEqual([]);
    expect(report.fields.find((entry) => entry.field === "nmc")!.evidence.every((entry) => input.fragments!.some((part) => part.id === entry.fragmentId && part.text === entry.quote))).toBe(true);
    expect(items).toEqual(before);
  });

  it.each(["customer", "amount"])("does not let another contract row prove %s", (field) => {
    const input = contracts(2), items = prepareContracts(input), first = items[0], second = items[1];
    first.fields[field] = second.fields[field];
    first.evidence = first.evidence!.filter((entry) => entry.field !== field).concat(second.evidence!.filter((entry) => entry.field === field));
    expect(status(items, [input], field)).not.toBe("confirmed");
    expect(getBlockingEvidenceFindings(auditIntelligenceResult(items, [input]), first).some((entry) => entry.field === field)).toBe(true);
  });

  it.each(["number", "date", "source", "unselected-number", "unselected-date"])("never blesses a detached row under an invalid card identity: %s", (change) => {
    const input = contracts(2), items = prepareContracts(input), first = items[0];
    if (change === "number") first.fields.number = items[1].fields.number;
    if (change === "date") first.fields.date = items[1].fields.date;
    if (change === "source") first.sourceIds = ["foreign"];
    if (change.startsWith("unselected-")) first.selectedFields = first.selectedFields.filter((field) => field !== change.slice(11));
    expect(status(items, [input], "customer")).not.toBe("confirmed");
    expect(status(items, [input], "amount")).not.toBe("confirmed");
  });

  it.each(["row-omitted", "partial-row", "wrong-fragment", "foreign-header", "unrelated-header"])("rejects incomplete or unrelated collective financial proof: %s", (change) => {
    const input = contracts(1), items = prepareContracts(input), item = items[0];
    const financial = item.evidence!.filter((entry) => entry.field === "amount");
    if (change === "row-omitted") item.evidence = item.evidence!.filter((entry) => entry !== financial[0]);
    if (change === "partial-row") financial[0].quote = String(item.fields.amount);
    if (change === "wrong-fragment") financial[0].fragmentId = input.fragments![0].id;
    if (change === "foreign-header") financial[1].sourceId = "foreign";
    if (change === "unrelated-header") {
      const unrelated = fragment("Комментарий\tИное значение", 1, "table-8"); input.fragments!.push(unrelated);
      financial[1] = claim(input, unrelated, "amount"); item.evidence = item.evidence!.filter((entry) => entry.field !== "amount").concat(financial);
    }
    const report = auditIntelligenceResult(items, [input]);
    expect(getBlockingEvidenceFindings(report, item).some((entry) => entry.field === "amount")).toBe(true);
  });

  it.each(["hidden", "gap", "table", "header-edit", "duplicate", "stale-value"])("does not retain a proof after current source changes: %s", (change) => {
    const input = contracts(1), items = prepareContracts(input);
    if (change === "hidden") input.fragments![0].sheetState = "hidden";
    if (change === "gap") { input.fragments![1].id = "table-1-row-3"; input.fragments![1].locator = "Таблица table-1, строка 3"; }
    if (change === "table") input.fragments![1].id = "table-9-row-2";
    if (change === "header-edit") input.fragments![0].text = header.replace("Сумма договора", "Цена за единицу");
    if (change === "duplicate") input.fragments!.push(structuredClone(input.fragments![0]));
    if (change === "stale-value") input.fragments![1].text = row(1, "QA-1/35", "01.05.2035", "АО Другой", "9 999,00");
    expect(status(items, [input], "customer")).not.toBe("confirmed");
    expect(status(items, [input], "amount")).not.toBe("confirmed");
  });

  it("keeps primary registry aliases only when the selected date and full identity are unique", () => {
    const input = source([fragment(header, 1), fragment(row(1, "QA/35 (2222-2035-00051)", "01.05.2035"), 2), fragment(row(2, "QA/35 (2222-2035-00052)", "02.05.2035"), 3)]);
    const items = prepareContracts(input); items[0].fields.number = "QA/35";
    expect(status(items, [input], "amount")).toBe("confirmed");
    items[0].fields.date = "2035-05-02";
    expect(status(items, [input], "amount")).not.toBe("confirmed");
    items[0].fields.date = "2035-05-01";
    input.fragments![2].text = row(2, "QA/35 (2222-2035-00052)", "01.05.2035");
    expect(status(items, [input], "amount")).not.toBe("confirmed");
  });

  it("never chooses one conflicting same-identity value across owned sources", () => {
    const input = contracts(1), other = contracts(1); other.id = "second"; other.fragments![1].text = row(1, "QA-1/35", "01.05.2035", "АО Другой", "9 999,00");
    const items = prepareContracts(input); items[0].sourceIds.push(other.id);
    expect(status(items, [input, other], "customer")).not.toBe("confirmed");
    expect(status(items, [input, other], "amount")).not.toBe("confirmed");
  });

  it.each(["unit-price", "foreign-currency", "conflicting-total", "extra-header", "missing-row"])("does not promote unsafe NMC support: %s", (change) => {
    const input = nmc(), items = prepareNmc(input), item = items[0];
    if (change === "unit-price") item.fields.nmc = 2115000;
    if (change === "foreign-currency") input.fragments![1].text = input.fragments![1].text.replace("(руб.)", "(USD)");
    if (change === "conflicting-total") {
      const other = source([fragment("Наименование\tНМЦ договора, рублей", 1, "table-2"), fragment("Итого\t99", 2, "table-2")], "second");
      item.sourceIds.push(other.id); expect(status(items, [input, other], "nmc")).not.toBe("confirmed"); return;
    }
    if (change === "extra-header") item.evidence!.push(claim(input, fragment("Иной заголовок", 1, "table-9"), "nmc"));
    if (change === "missing-row") item.evidence = item.evidence!.filter((entry) => entry.fragmentId !== input.fragments![4].id);
    const report = auditIntelligenceResult(items, [input]);
    expect(getBlockingEvidenceFindings(report, item).some((entry) => entry.field === "nmc")).toBe(true);
  });

  it("does not use a foreign-currency contract total as default rubles", () => {
    const input = contracts(1); input.fragments![0].text = header.replace("рублей", "USD");
    const items = prepareContracts(input);
    expect(status(items, [input], "amount")).not.toBe("confirmed");
  });

  it.each(["тыс. рублей", "млн рублей", "копеек", "рублей / месяц", "рублей в год", "AUD", "CAD", "AED"])("does not silently treat scaled/minor/period monetary units as whole rubles: %s", (units) => {
    const input = contracts(1); input.fragments![0].text = header.replace("рублей", units);
    const item = card("contracts", { number: "QA-1/35", date: "2035-05-01", amount: 1234567.89 });
    item.evidence = [claim(input, input.fragments![1], "amount"), claim(input, input.fragments![0], "amount")];
    expect(status([item], [input], "amount")).not.toBe("confirmed");
    const procurement = source([fragment(`Наименование\tНМЦ договора, ${units}`, 1), fragment("Итого\t1234567,89", 2)]);
    const nmcItem = card("procurement", { nmc: 1234567.89 });
    nmcItem.evidence = [claim(procurement, procurement.fragments![1], "nmc"), claim(procurement, procurement.fragments![0], "nmc")];
    expect(status([nmcItem], [procurement], "nmc")).not.toBe("confirmed");
  });

  it("keeps unsafe-unit conflict even without model evidence or with structured spreadsheet cells", () => {
    const input = source([
      Object.assign(fragment("Наименование\tНМЦ договора, тыс. рублей", 1, "sheet-1"), { sheetId: "sheet-1", cells: [{ reference: "A1", text: "Наименование" }, { reference: "B1", text: "НМЦ договора, тыс. рублей" }] }),
      Object.assign(fragment("Итого\t2345", 2, "sheet-1"), { sheetId: "sheet-1", cells: [{ reference: "A2", text: "Итого" }, { reference: "B2", text: "2345", valueType: "number", rawValue: "2345" }] }),
    ]);
    const item = card("procurement", { nmc: 2345 }); delete item.evidence;
    expect(status([item], [input], "nmc")).toBe("conflict");
  });

  it("disables collective proof when the independent source inventory hits its limit", () => {
    const input = contracts(1), items = prepareContracts(input);
    input.fragments!.push(...Array.from({ length: 5000 }, (_, index) => ({ id: `paragraph-${index + 1}`, locator: `Абзац ${index + 1}`, text: "Прочее." })));
    const report = auditIntelligenceResult(items, [input]);
    expect(report.fields.find((entry) => entry.field === "amount")?.status).not.toBe("confirmed");
    expect(getBlockingEvidenceFindings(report, items[0]).some((entry) => entry.code === "audit-limit")).toBe(true);
  });

  it.each(["Размер штрафа за превышение НМЦ договора, рублей", "Обеспечение исполнения: 5% от НМЦ договора, рублей"])("does not bless incidental NMC mentions in penalty/security labels through legacy cell evidence: %s", (label) => {
    const input = source([
      Object.assign(fragment(`Наименование\t${label}`, 1, "sheet-1"), { sheetId: "sheet-1", cells: [{ reference: "A1", text: "Наименование" }, { reference: "B1", text: label }] }),
      Object.assign(fragment("Итого\t100000", 2, "sheet-1"), { sheetId: "sheet-1", cells: [{ reference: "A2", text: "Итого" }, { reference: "B2", text: "100000", valueType: "number", rawValue: "100000" }] }),
    ]);
    const item = card("procurement", { nmc: 100000 });
    expect(status([item], [input], "nmc")).not.toBe("confirmed");
    const raw = JSON.stringify({ items: [{ destination: "procurement", title: "Аудит QA", fields: { nmc: 100000 } }] });
    const reply = runResponsePreparation({ revision: 1, raw, sources: [input], destinations: ["procurement"] });
    expect(reply.failed).toBeUndefined(); expect(reply.prepared!.sourcePreparation?.changes.filter((entry) => entry.field === "nmc") || []).toEqual([]);
    expect(status(reply.prepared!.items, [input], "nmc")).not.toBe("confirmed");
  });

  it.each(["Размер штрафа за превышение НМЦ договора: 100000 руб.", "Обеспечение исполнения: 5% от НМЦ договора: 100000 руб."])("does not use incidental NMC prose as a total: %s", (text) => {
    expect(status([card("procurement", { nmc: 100000 })], [source([{ id: "paragraph-1", locator: "Абзац 1", text }])], "nmc")).not.toBe("confirmed");
  });

  it.each(["Пеня от суммы договора: 100000 руб.", "Размер штрафа от суммы договора: 100000 руб."])("does not use a penalty's mention of contract sum as the actual amount: %s", (text) => {
    expect(status([card("contracts", { amount: 100000 })], [source([{ id: "paragraph-1", locator: "Абзац 1", text }])], "amount")).not.toBe("confirmed");
  });
});
