import { describe, expect, it } from "vitest";
import { completeIntelligenceConditions } from "./automaticConditions";
import { extractIntelligenceConditionFacts } from "./sourceConditionFacts";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const card = (): IntelligenceItem => ({ id: "qa-card", title: "QA", destination: "procurement", fields: {}, selectedFields: [], sourceIds: ["qa-source"] });
const textSource = (text: string): IntelligenceSource => ({ id: "qa-source", name: "Контрольный источник", text });
const apply = (source: IntelligenceSource) => completeIntelligenceConditions([card()], [source], { includeOperational: true });
const rows = [
  "1\tПравоспособность\tУчастник должен обладать правоспособностью\tДекларация участника",
  "2\tОпыт\tНаличие опыта аудита банков\tСведения о выполненных договорах",
  "3\tИнфраструктура\tНаличие опыта в платёжных системах\tСведения о работах / договорах",
  "4\tГруппа\tРуководитель и не менее ___ специалистов ИБ\tРезюме членов группы",
  "5\tМодели угроз\tНаличие опыта по методическим документам ФСТЭК\tИнформация о специалистах",
  "6\tМетодика\tОценка ГОСТ 57580.1 по методике ГОСТ 57580.2\tОписание подхода / примеры отчётов",
  "7\tЛицензирование (при наличии)\tЛицензия ФСТЭК либо опыт без обязательного лицензирования\tКопия лицензии либо сведения об опыте",
  "8\tДостоверность\tВсе сведения должны быть достоверными\tДекларация достоверности",
];
const table = (): IntelligenceSource => ({ ...textSource("Не использовать агрегат"), fragments: ["№\tНаименование требования\tСодержание требования\tДокументы / сведения для подтверждения", ...rows].map((text, index) => ({ id: `sheet-1-row-${index + 1}`, locator: `Лист QA, A${index + 1}:D${index + 1}`, sheetId: "1", text })) });

describe("complete explicit requirement table rows", () => {
  it("copies all eight whole rows, preserving unknown counts/OR/proof instead of adding the header as a document", () => {
    const source = table(), before = structuredClone(source), inventory = extractIntelligenceConditionFacts([source]), result = apply(source);
    expect(inventory.facts.map((fact) => fact.quote)).toEqual(rows);
    expect(result.items[0].fields.requirements).toEqual(rows); expect(result.changes).toHaveLength(8);
    expect(result.items[0].evidence?.map((entry) => entry.quote)).toEqual(rows);
    expect(result.changes.every((entry) => entry.requiresReview)).toBe(true); expect(source).toEqual(before);
  });
  it.each(["hidden", "gap", "newtable", "shape", "duplicates"])("does not inherit table ownership through %s", (kind) => {
    const source = table(), fragments = source.fragments!;
    if (kind === "hidden") fragments[1].sheetState = "hidden";
    if (kind === "gap") fragments.splice(1, 1);
    if (kind === "newtable") fragments[1].id = "sheet-2-row-2";
    if (kind === "shape") fragments[1].text += "\textra";
    if (kind === "duplicates") fragments[2].id = fragments[1].id;
    // The independent generic inventory may still find literal declarations;
    // it must not manufacture the neutral row 3 from an unrelated header.
    expect(extractIntelligenceConditionFacts([source]).facts.find((entry) => entry.quote === rows[2])?.category).not.toBe("document");
  });
  it("does not resurrect excluded fragments from source.text", () => {
    const source = table(); source.text = source.fragments!.map((entry) => entry.text).join("\n"); source.fragments = [];
    expect(apply(source).changes).toEqual([]);
  });
});

describe("bounded literal operational completion", () => {
  it("retains complete hierarchical component rows including merged parent and empty layout cells", () => {
    const lines = ["№ пп\tНаименование оборудования\tТребуемые технические характеристики\tКол-во\nшт.", "1\tСервер в составе:\t10", "1.1\tПроцессор\tCPU 16 cores или выше\t1", "1.2\tМодуль памяти\t16ГБ ECC RDIMM\t2", "1.3\tКабель\t\tСиловой кабель\t\t2", "1.4\tBMC\tУдалённая консоль FullHD; полный список см. ниже\t1"];
    const source = { ...textSource("Не использовать агрегат"), fragments: lines.map((text, index) => ({ id: `table-row-${index + 1}`, locator: `Таблица, строка ${index + 1}`, text })) };
    const result = apply(source); expect(result.items[0].fields.requirements).toEqual(lines.slice(1));
    expect(result.changes.every((entry) => entry.category === "quantity" && entry.requiresReview)).toBe(true);
    expect(result.items[0].fields).not.toHaveProperty("quantity"); expect(result.items[0].fields).not.toHaveProperty("lineDescriptions");
  });
  it("retains an explicit non-quantity cross without converting it to a number or losing the following component", () => {
    const lines = ["№ пп\tНаименование оборудования\tХарактеристика\tКол-во", "1\tСервер в составе:\t10", "1.1\tКонтроллер\tКонтроллер RAID\tх", "1.2\tБлок питания\t800Вт или выше с горячей заменой\t2", "1.3.\tУправление\tКонсоль BMC FullHD\tX", "1.4\tРельсы\tПоддержка CMA\t1"];
    const source = { ...textSource(""), fragments: lines.map((text, index) => ({ id: `table-row-${index + 1}`, locator: `Таблица, строка ${index + 1}`, text })) }, result = apply(source);
    expect(result.items[0].fields.requirements).toEqual(lines.slice(1));
    expect(extractIntelligenceConditionFacts([source]).facts.filter((fact) => /\t[хX]$/u.test(fact.quote)).every((fact) => fact.ambiguous)).toBe(true);
    expect(result.items[0].fields).not.toHaveProperty("quantity");
  });
  it.each(["gap", "hidden", "unrelated-table"])("stops explicit component ownership at %s", (kind) => {
    const lines = ["№ пп\tНаименование оборудования\tХарактеристика\tКол-во", "1\tСервер\tBMC\t10", "1.1\tПамять\tECC RDIMM\t2"];
    const source = { ...textSource(""), fragments: lines.map((text, index) => ({ id: `table-row-${index + 1}`, locator: `Таблица, строка ${index + 1}`, text, sheetState: "visible" as "visible" | "hidden" })) };
    if (kind === "gap") source.fragments.splice(1, 1);
    if (kind === "hidden") source.fragments[1].sheetState = "hidden";
    if (kind === "unrelated-table") source.fragments[1].id = "table-2-row-2";
    expect(apply(source).changes.find((entry) => entry.quote === lines[2])).toBeUndefined();
  });
  it("does not promote a historical equipment/quantity table to application requirements", () => {
    const source = { ...textSource(""), fragments: ["Источники ценовой информации:", "№ пп\tНаименование оборудования\tХарактеристика\tКол-во", "1\tСервер\tBMC\t10"].map((text, index) => ({ id: `table-row-${index + 1}`, locator: `Таблица, строка ${index + 1}`, text })) };
    expect(apply(source).changes).toEqual([]); expect(apply(source).skipped.some((entry) => entry.reason === "informational-document")).toBe(true);
  });
  it("retains complete quantities, payment, licence qualifications and service deadlines for review", () => {
    const clauses = ["Количество серверов: 10 шт.", "Условия оплаты: в течение 14 рабочих дней после подписания акта.", "Срок поставки: не позднее 45 календарных дней; восстановление не более 8 часов.", "Участник должен иметь лицензию ФСТЭК на ТЗКИ либо подтвердить неприменимость.", "Требуется поддержка 24 часа в сутки."];
    const source = { ...textSource(clauses.join("\n")), fragments: clauses.map((text, index) => ({ id: `paragraph-${index + 1}`, locator: `Абзац ${index + 1}`, text })) }, result = apply(source);
    expect(result.items[0].fields.requirements).toEqual(clauses); expect(result.changes.map((entry) => entry.category)).toEqual(["quantity", "payment", "delivery", "license", "requirement"]);
    expect(result.changes.every((entry) => entry.requiresReview)).toBe(true);
  });
  it("never upgrades a historical price source to a participant obligation", () => {
    const source = textSource("Источники ценовой информации:\n1. Условия оплаты по ранее полученному предложению: аванс 50%.");
    expect(apply(source).changes).toEqual([]); expect(apply(source).skipped.some((entry) => entry.reason === "informational-document")).toBe(true);
  });
  it("keeps the certificate/document-only API stable and does not add a new structured quantity field", () => {
    const source = textSource("Количество серверов: 10 шт.");
    expect(completeIntelligenceConditions([card()], [source]).changes).toEqual([]);
    expect(Object.keys(apply(source).items[0].fields)).toEqual(["requirements"]);
  });
});
