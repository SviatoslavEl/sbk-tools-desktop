import { describe, expect, it } from "vitest";
import { extractPreparedTableFacts, prepareIntelligenceSourceFacts, SOURCE_PREPARATION_LIMITS } from "./sourcePreparedFacts";
import type { IntelligenceDestination, IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const fragment = (text: string, row: number, table = "table-1"): IntelligenceFragment => ({ id: `${table}-row-${row}`, locator: `Таблица ${table}, строка ${row}`, text });
const source = (fragments: IntelligenceFragment[], id = "qa-source"): IntelligenceSource => ({ id, name: "Анонимный исходный документ", fragments, text: fragments.map((entry) => entry.text).join("\n") });
const card = (destination: IntelligenceDestination, fields: IntelligenceItem["fields"] = {}, id = "qa-card", sourceIds = ["qa-source"]): IntelligenceItem => ({ id, title: "Кандидат ИИ", destination, fields, selectedFields: Object.keys(fields), sourceIds, evidence: [] });
const freeze = <T,>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };
const contractHeader = "№ п/п\tСроки выполнения (год и месяц)\tЗаказчик (наименование)\tПредмет и содержание договора\tСумма договора, рублей";
const contractRow = (serial: number, number = `QA-${serial}/35`, date = `${String((serial - 1) % 28 + 1).padStart(2, "0")}.05.2035`, client = `АО «Компания ${serial}»`, amount = "1 234 567,89") => `${serial}.\tмай 2035 - июнь 2035\t${client}\tУслуги тестирования. Договор № ${number} от ${date}.\t${amount}`;
const contracts = (count = 5) => source([fragment(contractHeader, 1), ...Array.from({ length: count }, (_, index) => fragment(contractRow(index + 1), index + 2))]);
const nmc = (value = "21150000", unit = "2115000", id = "qa-source") => source([
  fragment("Наименование\tКол-во\tН(М)Ц за единицу (руб.)\tН(М)Ц договора, с учетом округления (руб.)", 1, "sheet-1"),
  fragment("Сервер по ТЗ\t10\t2115000\t", 2, "sheet-1"),
  fragment(`Итого, включая НДС:\t10\t${unit}\t${value}`, 3, "sheet-1"),
], id);

describe("bounded source-first unsaved contract preparation", () => {
  it("prepares every proven row, preserves full numbers and own row/header proof without model mutation", () => {
    const input = contracts(); input.fragments![1].text = contractRow(1, "QA-1/35 (2222-2035-00051)");
    const model = card("contracts", { number: "QA-1/35 (2222-2035-00051)", customer: "Неверный заказчик", date: "2035-01-01", amount: 1 }, "existing");
    const before = structuredClone({ input, model }); freeze(input); freeze(model);
    const result = prepareIntelligenceSourceFacts([model], [input]);
    expect(result.items).toHaveLength(5); expect(result.limited).toBe(false);
    expect(result.items[0].id).toBe("existing");
    expect(result.items[0].fields).toMatchObject({ number: "QA-1/35 (2222-2035-00051)", date: "2035-05-01", customer: "АО «Компания 1»", amount: 1234567.89 });
    expect(result.items.every((entry) => !entry.fields.startDate && !entry.fields.endDate && !entry.fields.performingLegalEntity && !entry.fields.contractRole)).toBe(true);
    expect(result.items.every((entry) => String(entry.fields.notes).includes("май 2035 - июнь 2035"))).toBe(true);
    for (const [index, item] of result.items.entries()) {
      expect(item.evidence!.filter((entry) => entry.field === "amount").map((entry) => entry.quote)).toEqual([input.fragments![index + 1].text, contractHeader]);
      for (const entry of item.evidence || []) expect(input.fragments!.some((part) => part.id === entry.fragmentId && part.text.includes(entry.quote))).toBe(true);
    }
    expect(result.changes.filter((entry) => entry.kind === "created")).toHaveLength(4);
    expect(result.changes.find((entry) => entry.field === "customer")).toMatchObject({ kind: "replaced", previousValue: "Неверный заказчик", value: "АО «Компания 1»", requiresReview: true });
    expect({ input, model }).toEqual(before);
  });

  it("matches by proven identity, not model or table row order, and is idempotent", () => {
    const input = contracts(3);
    const models = [card("contracts", { number: "QA-3/35" }, "third"), card("contracts", { number: "QA-1/35" }, "first")];
    const result = prepareIntelligenceSourceFacts(models, [input]);
    expect(result.items.find((entry) => entry.id === "third")!.fields.date).toBe("2035-05-03");
    expect(result.items.find((entry) => entry.id === "first")!.fields.date).toBe("2035-05-01");
    const again = prepareIntelligenceSourceFacts(result.items, [input]);
    expect(again.items).toEqual(result.items); expect(again.changes).toEqual([]);
  });

  it("can prepare explicit table candidates when model returns none, only for selected contracts", () => {
    expect(prepareIntelligenceSourceFacts([], [contracts(2)]).items).toEqual([]);
    expect(prepareIntelligenceSourceFacts([], [contracts(2)], ["contracts"]).items).toHaveLength(2);
    expect(prepareIntelligenceSourceFacts([card("staff")], [contracts(2)]).items).toHaveLength(1);
  });

  it("does not attach foreign evidence, silently remove unknown cards or merge sources by list order", () => {
    const unrelated = card("contracts", { number: "QA-1/35", subject: "Чужой договор" }, "foreign", ["another-source"]);
    const unknown = card("contracts", { number: "UNKNOWN" }, "unknown");
    const result = prepareIntelligenceSourceFacts([unrelated, unknown], [contracts(1)]);
    expect(result.items).toHaveLength(3); expect(result.items[0]).toEqual(unrelated); expect(result.items[1]).toEqual(unknown);
    expect(result.items[2].sourceIds).toEqual(["qa-source"]);
  });

  it("uses a full registry alias only when its date/source identify a unique row", () => {
    const input = source([fragment(contractHeader, 1), fragment(contractRow(1, "QA/35 (2222-2035-00051)", "01.05.2035"), 2), fragment(contractRow(2, "QA/35 (2222-2035-00052)", "02.05.2035"), 3)]);
    const ambiguous = card("contracts", { number: "QA/35" });
    const blocked = prepareIntelligenceSourceFacts([ambiguous], [input]);
    expect(blocked.items).toEqual([ambiguous]); expect(blocked.skipped.some((entry) => entry.reason === "ambiguous-contract-card")).toBe(true);
    const dated = card("contracts", { number: "QA/35", date: "2035-05-02" });
    const prepared = prepareIntelligenceSourceFacts([dated], [input]);
    expect(prepared.items[0].fields.number).toBe("QA/35 (2222-2035-00052)");
    expect(prepared.items).toHaveLength(2);
  });

  it("does not choose between duplicate candidate cards or conflicting same-number rows", () => {
    const input = contracts(1), a = card("contracts", { number: "QA-1/35" }, "a"), b = card("contracts", { number: "QA-1/35" }, "b");
    expect(prepareIntelligenceSourceFacts([a, b], [input]).items).toEqual([a, b]);
    const conflict = source([fragment(contractHeader, 1), fragment(contractRow(1, "QA/35", "01.05.2035", "АО Первый"), 2), fragment(contractRow(2, "QA/35", "01.05.2035", "АО Второй"), 3)]);
    const result = prepareIntelligenceSourceFacts([], [conflict], ["contracts"]);
    expect(result.items).toEqual([]); expect(result.skipped).toHaveLength(2);
  });

  it("keeps confidential client and printed month ranges as reference, not invented name/date", () => {
    const input = source([fragment(contractHeader, 1), fragment(contractRow(1, "C-1", "01.05.2035", "Банк, наименование заказчика конфиденциально"), 2)]);
    const result = prepareIntelligenceSourceFacts([], [input], ["contracts"]);
    expect(result.items[0].fields.customer).toBeUndefined(); expect(result.items[0].fields.notes).toContain("конфиденциально");
    expect(result.items[0].fields.startDate).toBeUndefined(); expect(result.items[0].fields.endDate).toBeUndefined();
  });

  it("never inherits a table header through a hidden row, gap, different table or unrelated paragraph", () => {
    const hidden = fragment(contractRow(1), 2); hidden.sheetState = "hidden";
    for (const middle of [hidden, { id: "paragraph-1", locator: "Абзац 1", text: "Другая секция" }]) {
      const result = prepareIntelligenceSourceFacts([], [source([fragment(contractHeader, 1), middle, fragment(contractRow(2), 3)])], ["contracts"]);
      expect(result.items).toEqual([]);
    }
    expect(prepareIntelligenceSourceFacts([], [source([fragment(contractHeader, 1), fragment(contractRow(1), 3)])], ["contracts"]).items).toEqual([]);
    expect(prepareIntelligenceSourceFacts([], [source([fragment(contractHeader, 1), fragment(contractRow(1), 2, "table-2")])], ["contracts"]).items).toEqual([]);
  });

  it("does not resurrect aggregate text or duplicate/hidden fragments, opt-in is explicit", () => {
    const input = contracts(1), empty = { ...input, fragments: [] };
    expect(prepareIntelligenceSourceFacts([], [empty], ["contracts"]).items).toEqual([]);
    const duplicate = { ...input, fragments: [...input.fragments!, input.fragments![0]] };
    expect(prepareIntelligenceSourceFacts([], [duplicate], ["contracts"]).items).toEqual([]);
    expect(prepareIntelligenceSourceFacts([], [input, input], ["contracts"]).items).toEqual([]);
    const hidden = structuredClone(input); hidden.fragments!.forEach((entry) => { entry.sheetState = "hidden"; });
    expect(prepareIntelligenceSourceFacts([], [hidden], ["contracts"]).items).toEqual([]);
    hidden.fragments!.forEach((entry) => { entry.includedByUser = true; });
    expect(prepareIntelligenceSourceFacts([], [hidden], ["contracts"]).items).toHaveLength(1);
  });

  it("does not parse templates, invalid dates, standalone law numbers or two contract numbers in one cell", () => {
    for (const subject of ["Договор № ___ от 01.05.2035", "Договор № C-1 от 31.02.2035", "Федеральный закон № 44-ФЗ от 01.05.2035", "Договор № C-1 от 01.05.2035 и Договор № C-2 от 02.05.2035"]) {
      expect(prepareIntelligenceSourceFacts([], [source([fragment(contractHeader, 1), fragment(`1\tмай 2035\tАО Альфа\t${subject}\t1000`, 2)])], ["contracts"]).items).toEqual([]);
    }
  });

  it("rolls back the entire helper at card, text, receipt and proof boundaries, never cuts a list prefix", () => {
    const existing = Array.from({ length: 100 }, (_, index) => card("contracts", { number: `OLD-${index}` }, `old-${index}`));
    const capped = prepareIntelligenceSourceFacts(existing, [contracts(1)]); expect(capped.items).toEqual(existing); expect(capped.limited).toBe(true); expect(capped.changes).toEqual([]);
    const tooMany = prepareIntelligenceSourceFacts([], [contracts(101)], ["contracts"]); expect(tooMany.items).toEqual([]); expect(tooMany.limited).toBe(true);
    const tooLong = contracts(1); tooLong.fragments![1].text += "X".repeat(2001);
    const proofFailure = prepareIntelligenceSourceFacts([], [tooLong], ["contracts"]); expect(proofFailure.items).toEqual([]); expect(proofFailure.skipped[0].reason).toBe("proof-too-long");
    const large = source([{ id: "page-1", locator: "Большой фрагмент", text: "X".repeat(SOURCE_PREPARATION_LIMITS.fragmentCharacters + 1) }]);
    expect(prepareIntelligenceSourceFacts([], [contracts(1), large], ["contracts"]).items).toEqual([]);
    expect(prepareIntelligenceSourceFacts([], [contracts(80)], ["contracts"]).limited).toBe(true);
  });
});

describe("explicit NMC column preparation", () => {
  it("uses the labelled contract total, never a vendor/unit price, and includes header evidence", () => {
    const input = nmc(), model = card("procurement", { name: "Закупка оборудования", nmc: 2115000 });
    const before = structuredClone({ input, model }); freeze(input); freeze(model);
    const result = prepareIntelligenceSourceFacts([model], [input]);
    expect(result.items[0].fields.nmc).toBe(21150000); expect(result.items[0].fields.quantity).toBeUndefined();
    expect(result.changes[0]).toMatchObject({ field: "nmc", kind: "replaced", previousValue: 2115000, value: 21150000 });
    expect(result.items[0].evidence!.filter((entry) => entry.field === "nmc").some((entry) => entry.quote.includes("Н(М)Ц договора"))).toBe(true);
    expect({ input, model }).toEqual(before);
  });

  it("accepts generic full Russian headers and full multirow market-price layouts", () => {
    const generic = source([fragment("Наименование\tНачальная (максимальная) цена договора, рублей", 1, "sheet-2"), fragment("Итого\t123456,78", 2, "sheet-2")]);
    expect(prepareIntelligenceSourceFacts([card("procurement")], [generic]).items[0].fields.nmc).toBe(123456.78);
    const market = source([
      fragment("№\tНаименование\tКол-во\tЦены рынка\t\tН(М)Ц за единицу\t", 4, "sheet-3"),
      fragment("\t\t\tПоставщик 1\tПоставщик 2\tМинимальная цена\tН(М)Ц договора, с учетом округления цены за единицу (руб.)", 5, "sheet-3"),
      fragment("\t\t\tЦена за единицу\tЦена за единицу\t\t", 6, "sheet-3"),
      fragment("1.1.\tТовар\t10\t2115000\t2520000\t2115000\t21150000", 7, "sheet-3"),
      fragment("\tИтого, включая НДС:\t10\t21150000\t25200000\t2115000\t21150000", 8, "sheet-3"),
    ]);
    const result = prepareIntelligenceSourceFacts([card("procurement")], [market]);
    expect(result.items[0].fields.nmc).toBe(21150000); expect(result.items[0].evidence!.filter((entry) => entry.field === "nmc")).toHaveLength(4);
  });

  it("does not guess an aggregate, conflicting total, formula, two labelled columns or foreign source", () => {
    const model = card("procurement", { nmc: 99 });
    const multipleRows = source([fragment("Товар\tНМЦ договора", 1), fragment("А\t100", 2), fragment("Б\t200", 3)]);
    expect(prepareIntelligenceSourceFacts([model], [multipleRows]).items[0].fields.nmc).toBe(99);
    const conflicts = prepareIntelligenceSourceFacts([model], [nmc("100"), nmc("200", "20", "source-b")].map((entry) => entry));
    expect(conflicts.items[0].fields.nmc).toBe(100); // source-b is not owned, never borrowed
    const owned = { ...model, sourceIds: ["qa-source", "source-b"] };
    expect(prepareIntelligenceSourceFacts([owned], [nmc("100"), nmc("200", "20", "source-b")]).items[0].fields.nmc).toBe(99);
    for (const printed of ["=A1*B1", "1e7", "1 23 456", "100–200", "20%", "0"]) expect(prepareIntelligenceSourceFacts([model], [nmc(printed)]).items[0].fields.nmc).toBe(99);
    const both = source([fragment("НМЦ договора А\tНМЦ договора Б", 1), fragment("100\t200", 2)]);
    expect(prepareIntelligenceSourceFacts([model], [both]).items[0].fields.nmc).toBe(99);
  });

  it("does not assign one total to multiple cards, nor infer it from an unlabelled amount or unit header", () => {
    const a = card("procurement", {}, "a"), b = card("procurement", {}, "b");
    const result = prepareIntelligenceSourceFacts([a, b], [nmc()]); expect(result.items).toEqual([a, b]); expect(result.skipped[0].reason).toBe("multiple-cards");
    for (const header of ["Цена товара", "Штраф по договору", "НМЦ за единицу", "НМЦ договора за единицу", "Предложение поставщика"]) {
      const input = source([fragment(`Наименование\t${header}`, 1), fragment("Итого\t21150000", 2)]);
      expect(prepareIntelligenceSourceFacts([a], [input]).items[0].fields.nmc).toBeUndefined();
    }
  });

  it("does not allocate equal NMC totals to a card across explicit lots, but ignores ordinary lot prose", () => {
    const model = card("procurement");
    const explicit = nmc(); explicit.fragments!.unshift({ id: "paragraph-1", locator: "Абзац 1", text: "Лот А: серверы\nЛот Б: услуги" });
    expect(prepareIntelligenceSourceFacts([model], [explicit]).items[0].fields.nmc).toBeUndefined();
    const prose = nmc(); prose.fragments!.unshift({ id: "paragraph-1", locator: "Абзац 1", text: "Лот включает серверы. Состав лота описан в приложении." });
    expect(prepareIntelligenceSourceFacts([model], [prose]).items[0].fields.nmc).toBe(21150000);
    const compactOcr = nmc(); compactOcr.fragments!.unshift({ id: "paragraph-1", locator: "Абзац 1", text: "Лоты №1 и2:" });
    expect(prepareIntelligenceSourceFacts([model], [compactOcr]).items[0].fields.nmc).toBeUndefined();
  });

  it("exports exact monetary-cell metadata without trusting currency/unit labels of adjacent columns", () => {
    const input = source([
      fragment("Товар\tЦена за единицу, USD\tН(М)Ц договора, рублей", 1),
      fragment("Итого\t10\t21150000", 2),
    ]);
    const before = structuredClone(input); freeze(input);
    const facts = extractPreparedTableFacts([input]);
    expect(facts.nmcs[0]).toMatchObject({ totalLabel: "Н(М)Ц договора, рублей", amountText: "21150000", value: 21150000 });
    expect(facts.nmcs[0].headers[0].quote).toBe(input.fragments![0].text);
    const contract = extractPreparedTableFacts([contracts(1)]).contracts[0];
    expect(contract).toMatchObject({ amountLabel: "Сумма договора, рублей", amountText: "1 234 567,89" });
    expect(input).toEqual(before);
    expect(extractPreparedTableFacts([{ ...input, fragments: [] }]).nmcs).toEqual([]);
    expect(extractPreparedTableFacts([source([{ locator: "Too big", text: "X".repeat(20001) }])])).toMatchObject({ contracts: [], nmcs: [], limited: true });
  });

  it("never converts an explicitly foreign monetary column to implicit roubles", () => {
    const foreignNmc = source([fragment("Товар\tНМЦ договора, USD", 1), fragment("Итого\t10000", 2)]);
    const prepared = prepareIntelligenceSourceFacts([card("procurement")], [foreignNmc]);
    expect(prepared.items[0].fields.nmc).toBeUndefined(); expect(prepared.skipped[0].reason).toBe("foreign-currency");
    const foreignContract = contracts(1); foreignContract.fragments![0].text = contractHeader.replace("рублей", "USD");
    const out = prepareIntelligenceSourceFacts([], [foreignContract], ["contracts"]);
    expect(out.items).toHaveLength(1); expect(out.items[0].fields.amount).toBeUndefined(); expect(out.skipped[0].reason).toBe("foreign-currency");
    expect(extractPreparedTableFacts([foreignContract]).contracts[0].amountLabel).toContain("USD");
  });

  it("never silently interprets scaled, minor or per-period contract/NMC values as whole-contract roubles", () => {
    for (const unit of ["тыс. рублей", "млн рублей", "миллионов рублей", "копеек", "коп.", "рублей за месяц", "рублей в месяц", "руб./мес.", "рублей за единицу"]) {
      const input = contracts(1); input.fragments![0].text = contractHeader.replace("рублей", unit);
      const prepared = prepareIntelligenceSourceFacts([], [input], ["contracts"]);
      expect(prepared.items).toHaveLength(1); expect(prepared.items[0].fields.amount, unit).toBeUndefined();
      expect(prepared.skipped.some((entry) => entry.reason === "unsupported-money-units"), unit).toBe(true);
      const amountLabel = extractPreparedTableFacts([input]).contracts[0].amountLabel; expect(amountLabel).toContain(unit);
      const procurement = source([fragment("Товар\tНМЦ договора, " + unit, 1), fragment("Итого\t2345", 2)]);
      const nmcResult = prepareIntelligenceSourceFacts([card("procurement")], [procurement]);
      expect(nmcResult.items[0].fields.nmc, unit).toBeUndefined(); expect(nmcResult.skipped.some((entry) => entry.reason === "unsupported-money-units"), unit).toBe(true);
    }
    // An already parsed candidate is retained visibly, not secretly converted.
    const scaled = contracts(1); scaled.fragments![0].text = contractHeader.replace("рублей", "тыс. рублей");
    const model = card("contracts", { number: "QA-1/35", amount: 1234567.89 });
    expect(prepareIntelligenceSourceFacts([model], [scaled]).items[0].fields.amount).toBe(model.fields.amount);
  });

  it("requires review for explicit unrecognised currency codes rather than silently defaulting them to RUB", () => {
    for (const code of ["AUD", "CAD", "AED", "ABC"]) {
      const input = contracts(1); input.fragments![0].text = contractHeader.replace("рублей", code);
      const prepared = prepareIntelligenceSourceFacts([], [input], ["contracts"]);
      expect(prepared.items[0].fields.amount, code).toBeUndefined(); expect(prepared.skipped[0].reason).toBe("unsupported-money-units");
      const total = source([fragment("Товар\tНМЦ договора, " + code, 1), fragment("Итого\t2345", 2)]);
      expect(prepareIntelligenceSourceFacts([card("procurement")], [total]).items[0].fields.nmc, code).toBeUndefined();
    }
    for (const label of ["рублей", "RUB", "RUR", "рублей, VAT included"]) {
      const input = contracts(1); input.fragments![0].text = contractHeader.replace("рублей", label);
      expect(prepareIntelligenceSourceFacts([], [input], ["contracts"]).items[0].fields.amount, label).toBe(1234567.89);
    }
  });

  it("requires a primary total label, not a penalty, security, percentage or share merely mentioning NMC/contract sum", () => {
    for (const label of ["Размер штрафа за превышение НМЦ договора, рублей", "Обеспечение исполнения: 5% от НМЦ договора, рублей", "Процент от НМЦ договора, рублей", "Наша доля от НМЦ договора, рублей"]) {
      const input = source([fragment("Наименование\t" + label, 1), fragment("Итого\t100000", 2)]);
      expect(extractPreparedTableFacts([input]).nmcs, label).toEqual([]);
      expect(prepareIntelligenceSourceFacts([card("procurement")], [input]).items[0].fields.nmc, label).toBeUndefined();
    }
    for (const label of ["Размер штрафа: сумма договора, рублей", "Обеспечение: сумма договора, рублей", "Наша доля: сумма договора, рублей"]) {
      const input = contracts(1); input.fragments![0].text = contractHeader.replace("Сумма договора, рублей", label);
      expect(extractPreparedTableFacts([input]).contracts, label).toEqual([]);
      expect(prepareIntelligenceSourceFacts([], [input], ["contracts"]).items, label).toEqual([]);
    }
    for (const label of ["Сумма договора, рублей", "Общая сумма договора, рублей", "Итоговая сумма договора, рублей"]) {
      const input = contracts(1); input.fragments![0].text = contractHeader.replace("Сумма договора, рублей", label);
      expect(prepareIntelligenceSourceFacts([], [input], ["contracts"]).items[0].fields.amount, label).toBe(1234567.89);
    }
    for (const label of ["Н(М)Ц договора, рублей", "Общая НМЦ договора, рублей", "Начальная (максимальная) цена договора, рублей"]) {
      const input = source([fragment("Наименование\t" + label, 1), fragment("Итого\t100000", 2)]);
      expect(prepareIntelligenceSourceFacts([card("procurement")], [input]).items[0].fields.nmc, label).toBe(100000);
    }
  });
});

const team = () => source([
  { id: "paragraph-1", locator: "Абзац 1", text: "Контакт менеджера команды" },
  fragment("Параметр\tЗначение", 1), fragment("ФИО\tКрылов Антон", 2), fragment("Роль\tКоммерческий директор", 3),
  fragment("Телефон\t+7 (000) 111-22-33", 4), fragment("Email\tmanager@example.test", 5),
  { id: "paragraph-2", locator: "Абзац 2", text: "Состав проектной команды" },
  fragment("ФИО\tРоль в проекте\tВ штате\tОпыт и квалификация\tЗакрываемые направления ТЗ", 6),
  fragment("Орлов Антон Сергеевич\tРуководитель проекта\tДа\tБолее 25 лет в ИБ, 300 проектов за 5 лет.\tАудит и пентест", 7),
  fragment("Соколов Иван Павлович\tПентестер\tДа\t6 лет в ИБ. Анализ защищенности.\tПентест", 8),
  fragment("Волков Петр Иванович\tЭксперт\tНет\t12 лет опыта. Сертификат QA-EXPERT.\tИнфраструктура", 9),
  fragment("Рыбаков Илья Олегович\tАналитик\tДа\t10 лет в ИБ.\tМоделирование угроз", 10),
  fragment("Лебедев Олег Андреевич\tРазработчик\tДа\t8 лет опыта разработки.\tИнструменты", 11),
]);
describe("source-owned staff roster preparation", () => {
  it("derives every explicit technical row, not model count, and visibly quarantines a separate manager", () => {
    const input = team(), model = [card("staff", { fullName: "Соколов Иван Павлович", role: "Не та роль", experienceYears: 25, experienceNotes: "300 проектов", phone: "+70001112233", email: "manager@example.test", basis: "Трудовой договор" }, "technical"), card("staff", { fullName: "Крылов Антон", role: "Менеджер", phone: "+70001112233" }, "manager")];
    const before = structuredClone({ input, model }); freeze(input); freeze(model);
    const result = prepareIntelligenceSourceFacts(model, [input]);
    expect(result.items).toHaveLength(6); // 5 real roster candidates + preserved quarantined contact
    expect(result.items.filter((entry) => entry.selectedFields.includes("fullName"))).toHaveLength(5);
    const technical = result.items.find((entry) => entry.id === "technical")!;
    expect(technical.fields).toMatchObject({ experienceYears: 6, experienceNotes: "6 лет в ИБ. Анализ защищенности.", role: "Пентестер", basis: "Трудовой договор", email: "manager@example.test" });
    expect(technical.selectedFields).not.toContain("basis"); expect(technical.selectedFields).not.toContain("phone"); expect(technical.selectedFields).not.toContain("email");
    expect(result.items.find((entry) => entry.id === "manager")!.selectedFields).toEqual([]);
    expect(result.changes.filter((entry) => entry.kind === "quarantined").map((entry) => entry.field)).toEqual(expect.arrayContaining(["basis", "phone", "email", "fullName"]));
    expect(result.skipped.some((entry) => entry.reason === "contact-manager-not-roster")).toBe(true);
    expect({ input, model }).toEqual(before);
  });

  it("preserves lower-bound experience literally without manufacturing exact years, certificates or employment basis", () => {
    const input = team();
    const result = prepareIntelligenceSourceFacts([card("staff", { fullName: "Орлов Антон Сергеевич", experienceYears: 25 })], [input]);
    const leader = result.items.find((entry) => entry.fields.fullName === "Орлов Антон Сергеевич")!;
    expect(leader.fields.experienceNotes).toContain("Более 25 лет"); expect(leader.selectedFields).not.toContain("experienceYears");
    expect(result.items.every((entry) => !entry.fields.certificates && !entry.fields.basis)).toBe(true);
  });

  it("does not quarantine a roster member because they also are a manager, nor unknown outside-roster people by absence", () => {
    const input = team(); input.fragments![2].text = "ФИО\tСоколов Иван Павлович";
    const member = card("staff", { fullName: "Соколов Иван Павлович", email: "manager@example.test" }, "member");
    const unknown = card("staff", { fullName: "Неизвестный Иван Иванович" }, "unknown");
    const result = prepareIntelligenceSourceFacts([member, unknown], [input]);
    expect(result.items.find((entry) => entry.id === "member")!.selectedFields).toContain("email");
    expect(result.items.find((entry) => entry.id === "unknown")).toEqual(unknown);
  });

  it("does not inherit roster through hidden/interrupted rows, mix foreign sources or choose conflicting same-name profiles", () => {
    const input = team(); input.fragments![8].sheetState = "hidden";
    const broken = prepareIntelligenceSourceFacts([], [input], ["staff"]); expect(broken.items).toEqual([]);
    const first = team(), other = team(); other.id = "other-source"; other.fragments![9].text = other.fragments![9].text.replace("6 лет", "16 лет");
    const owner = card("staff", { fullName: "Соколов Иван Павлович", experienceYears: 99 }, "shared", ["qa-source", "other-source"]);
    const conflict = prepareIntelligenceSourceFacts([owner], [first, other]);
    expect(conflict.items.find((entry) => entry.id === "shared")!.fields.experienceYears).toBe(99);
    expect(conflict.skipped.some((entry) => entry.reason === "conflicting-person-sources")).toBe(true);
  });

  it("quarantines only education values literally misclassified from this person's explicit experience cell", () => {
    const input = team();
    const a = card("staff", { fullName: "Соколов Иван Павлович", education: ["6 лет в ИБ. Анализ защищенности."] }, "a");
    const b = card("staff", { fullName: "Волков Петр Иванович", education: ["Диплом QA университета"] }, "b");
    const result = prepareIntelligenceSourceFacts([a, b], [input]);
    expect(result.items.find((entry) => entry.id === "a")!.selectedFields).not.toContain("education");
    expect(result.items.find((entry) => entry.id === "a")!.fields.education).toEqual(a.fields.education);
    expect(result.changes.find((entry) => entry.field === "education")).toMatchObject({ kind: "quarantined", previousValue: a.fields.education });
    expect(result.items.find((entry) => entry.id === "b")!.selectedFields).toContain("education");
    const unknownMixed = card("staff", { fullName: "Соколов Иван Павлович", education: ["6 лет в ИБ.", "Диплом QA"] });
    expect(prepareIntelligenceSourceFacts([unknownMixed], [input]).items[0].selectedFields).toContain("education");
  });

  it("retains a real member's explicitly labelled own-row contacts even if a manager uses the same company contact", () => {
    const input = team();
    input.fragments![7].text += "\tТелефон\tEmail";
    for (let index = 8; index < input.fragments!.length; index++) input.fragments![index].text += "\t+7 (000) 111-22-33\tmanager@example.test";
    const model = card("staff", { fullName: "Соколов Иван Павлович", phone: "+70001112233", email: "manager@example.test" });
    const result = prepareIntelligenceSourceFacts([model], [input]);
    expect(result.items[0].fields.phone).toBe("+7 (000) 111-22-33");
    expect(result.items[0].selectedFields).toContain("phone"); expect(result.items[0].selectedFields).toContain("email");
    expect(result.changes.some((entry) => entry.itemId === model.id && entry.kind === "quarantined" && ["phone", "email"].includes(entry.field))).toBe(false);
  });
});
