import { describe, expect, it } from "vitest";
import { extractIntelligenceConditionFacts, intelligenceConditionLimits } from "./sourceConditionFacts";
import type { IntelligenceSource } from "./workbenchTypes";

const source = (text: string, id = "source-a"): IntelligenceSource => ({ id, name: "Synthetic source", text });
const fragmentSource = (text: string, id = "source-a"): IntelligenceSource => ({ ...source(text, id), fragments: [{ id: "p-1", locator: "Абзац 1", text }] });

describe("bounded literal condition inventory", () => {
  it("uses exact section headings as boundaries without counting them as certificate or document clauses", () => {
    const rows = ["1. Сертификат OSCP — не менее 5 специалистов.", "2. Сертификат OSEP — не менее 2 специалистов.", "1. Копия действующей лицензии ФСТЭК.", "2. Копия доверенности, если заявку подписывает представитель.", "3. Декларация соответствия требованиям участника."];
    const text = `Синтетическая закупка Mac QA.\nСертификаты специалистов:\n${rows.slice(0, 2).join("\n")}\nДокументы в составе заявки:\n${rows.slice(2).join("\n")}`;
    const result = extractIntelligenceConditionFacts([fragmentSource(text)]);
    expect(result.facts.map((fact) => fact.quote)).toEqual(rows);
    expect(result.facts.map((fact) => fact.category)).toEqual(["certificate", "certificate", "document", "document", "document"]);
    expect(result.facts.every((fact) => text.includes(fact.quote))).toBe(true);
    expect(result.limited).toBe(false);
  });
  it("classifies a requested licence copy as a complete document without turning bare licences into documents", () => {
    const copy = "1. Копия лицензии ФСТЭК на пункты 4, 7, если требуется, либо выписка из реестра.";
    const licence = "2. Лицензия ФСТЭК на пункты 4, 7 (за исключением работ для собственных нужд).";
    const result = extractIntelligenceConditionFacts([fragmentSource(`${copy}\n${licence}`)]);
    expect(result.facts).toEqual([
      expect.objectContaining({ quote: copy, category: "document", ambiguous: true }),
      expect.objectContaining({ quote: licence, category: "license", ambiguous: true }),
    ]);
  });

  it("retains every certificate and its own minimum without borrowing the adjacent count", () => {
    const rows = [["OSCP", 5], ["OSEP", 2], ["BSCP", 3], ["OSWE", 3], ["OSWP", 3], ["KLCP", 1], ["eJPT", 1], ["CompTIA Pentest+", 1], ["HTB CPTS", 3]] as const;
    const text = rows.map(([name, minimum]) => `o\tСертификат ${name} – не менее ${minimum};`).join("\n");
    const result = extractIntelligenceConditionFacts([fragmentSource(text)]);
    expect(result.limited).toBe(false); expect(result.facts).toHaveLength(9);
    for (const [index, fact] of result.facts.entries()) {
      expect(fact).toMatchObject({ sourceId: "source-a", fragmentId: "p-1", locator: "Абзац 1", category: "certificate", quote: `o\tСертификат ${rows[index][0]} – не менее ${rows[index][1]};` });
      expect(text.includes(fact.quote)).toBe(true);
    }
  });
  it("preserves eight separately numbered application documents, including conditions and choices", () => {
    const rows = [
      "1. Заявка в виде коммерческого предложения с подписью и печатью (при наличии);",
      "2. Копия выписки из ЕГРЮЛ, полученная не ранее 30 дней;",
      "3. Копии документов, подтверждающие полномочия, либо доверенность;",
      "4. Решение об одобрении сделки, если требуется, либо справка об отсутствии необходимости;",
      "5. Декларация по форме приложения;", "7. Запрос на аккредитацию (карточка предприятия);",
      "8. КНД 1120101 об отсутствии налоговой задолженности;", "9. Типовой проект Договора с существенными условиями.",
    ];
    const text = rows.join("\n"); const result = extractIntelligenceConditionFacts([fragmentSource(text)]);
    expect(result.facts.map((fact) => fact.quote)).toEqual(rows);
    expect(result.facts.every((fact) => fact.category === "document")).toBe(true);
    expect(result.facts[0].ambiguous).toBe(true); expect(result.facts[2].ambiguous).toBe(true);
  });
  it("keeps license activity numbers and their exceptions literally in the same source clause", () => {
    const text = "3.1) Лицензия ФСБ на пункты 13, 20, 22 (за исключением работ для собственных нужд).";
    const result = extractIntelligenceConditionFacts([fragmentSource(text)]);
    expect(result.facts).toEqual([{ sourceId: "source-a", sourceName: "Synthetic source", fragmentId: "p-1", locator: "Абзац 1", quote: text, category: "license", ambiguous: true }]);
  });
  it("retains alternative license confirmations and an open-register declaration exception separately", () => {
    const choices = "Участник должен предоставить один из документов:\n- копию лицензии (при наличии);\nили\n- выписку из реестра;\nлибо сведения о номере и дате лицензии.";
    const exception = "Информация и документы могут не включаться в заявку, если находятся в открытом реестре и в заявку включена декларация.";
    const result = extractIntelligenceConditionFacts([{ ...source("old aggregate"), fragments: [{ id: "choice", locator: "Пункт 3", text: choices }, { id: "exception", locator: "Примечание", text: exception }] }]);
    expect(result.facts).toHaveLength(2);
    expect(result.facts[0]).toMatchObject({ category: "license", quote: choices, ambiguous: true });
    expect(result.facts[1]).toMatchObject({ category: "exception", quote: exception, ambiguous: true });
    expect(result.facts[0].quote).not.toContain("открытом реестре");
  });
  it("does not turn operator-provided documents into an unconditional participant obligation", () => {
    const text = "2) Информация и документы направляются заказчику оператором площадки (не включаются участником закупки в состав заявки).";
    const result = extractIntelligenceConditionFacts([fragmentSource(text)]);
    expect(result.facts[0]).toMatchObject({ category: "exception", ambiguous: true, quote: text });
  });
  it("does not mistake a tax identifier or document heading for payment conditions", () => {
    const result = extractIntelligenceConditionFacts([fragmentSource("идентификационный номер налогоплательщика (при наличии)."), fragmentSource("ТРЕБОВАНИЯ К СОДЕРЖАНИЮ, СОСТАВУ ЗАЯВКИ И ИНСТРУКЦИЯ ПО ЕЕ ЗАПОЛНЕНИЮ", "heading")]);
    expect(result.facts.some((fact) => fact.category === "payment")).toBe(false);
    expect(result.facts.some((fact) => fact.sourceId === "heading")).toBe(false);
  });
  it("separates payment and delivery labels while retaining exact wording and lower bounds", () => {
    const text = "Описание документа.\nУсловия оплаты: постоплата через 14 рабочих дней после принятия УПД.\nСрок поставки: не ранее 29.12.2026 и не позднее 17.01.2027.";
    const result = extractIntelligenceConditionFacts([fragmentSource(text)]);
    expect(result.facts.map((fact) => [fact.category, fact.quote])).toEqual([
      ["payment", "Условия оплаты: постоплата через 14 рабочих дней после принятия УПД."],
      ["delivery", "Срок поставки: не ранее 29.12.2026 и не позднее 17.01.2027."],
    ]);
    expect(result.facts[1].ambiguous).toBe(true);
  });
  it("separates extended field labels even when the preceding extracted line has no full stop", () => {
    const rows = ["Фиксация цены на срок действия контракта: фиксируется на весь срок", "Условия оплаты: постоплата через 14 рабочих дней", "Адрес, условия и сроки исполнения: согласно Техническому заданию, таблица 1."];
    const result = extractIntelligenceConditionFacts([fragmentSource(rows.join("\n"))]);
    expect(result.facts.map((fact) => fact.quote)).toEqual(rows);
    expect(result.facts.map((fact) => fact.category)).toEqual(["requirement", "payment", "delivery"]);
  });
  it("keeps wrapped qualifiers in one contiguous quote and never joins neighboring fragments", () => {
    const text = "Лицензия ФСТЭК, подпункты б и е,\nпри наличии основания предоставляется выписка.";
    const result = extractIntelligenceConditionFacts([{ ...source(""), fragments: [{ id: "a", locator: "A", text }, { id: "b", locator: "B", text: "Сертификат OSCP — не менее 2." }] }]);
    expect(result.facts[0].quote).toBe(text); expect(result.facts[0].fragmentId).toBe("a");
    expect(result.facts[1].quote).toBe("Сертификат OSCP — не менее 2."); expect(result.facts[1].fragmentId).toBe("b");
  });
  it("does not separate a wrapped declaration condition from the exemption it qualifies", () => {
    const text = "Документы могут не включаться в заявку, если сведения есть в открытом реестре,\nучастник должен включить декларацию соответствия.";
    const result = extractIntelligenceConditionFacts([fragmentSource(text)]);
    expect(result.facts).toHaveLength(1); expect(result.facts[0]).toMatchObject({ quote: text, category: "exception", ambiguous: true });
  });
  it("includes quantities and non-document qualification conditions without inventing fields", () => {
    const result = extractIntelligenceConditionFacts([fragmentSource("Не менее 10 серверов.\n• Исполнитель должен обладать исследовательской лабораторией.")]);
    expect(result.facts.map((fact) => fact.category)).toEqual(["quantity", "requirement"]);
    expect(result.facts.every((fact) => !Object.keys(fact).some((key) => ["confirmed", "fields", "selectedFields"].includes(key)))).toBe(true);
  });
  it("recognizes a literal unit/count table row without importing a neighboring header or price as a count", () => {
    const header = "№\tНаименование\tЕд. изм.\tКол-во\tЦена за ед.";
    const row = "1\tСервер\tшт\t10\t5000,00";
    const result = extractIntelligenceConditionFacts([{ ...source(""), fragments: [{ id: "header", locator: "Header", text: header }, { id: "row", locator: "Row", text: row }] }]);
    expect(result.facts).toHaveLength(1); expect(result.facts[0]).toMatchObject({ fragmentId: "row", quote: row, category: "quantity", ambiguous: true });
  });
  it("treats explicit empty or selected fragments as authoritative instead of restoring aggregate text", () => {
    const aggregate = "Сертификат OSCP — не менее 5.";
    expect(extractIntelligenceConditionFacts([{ ...source(aggregate), fragments: [] }]).facts).toEqual([]);
    expect(extractIntelligenceConditionFacts([{ ...source(aggregate), fragments: [{ id: "empty", locator: "Empty", text: "" }] }]).facts).toEqual([]);
    const selected = { ...source(aggregate), fragments: [{ id: "visible", locator: "Visible", text: "Не менее 2 специалистов.", includedByUser: false }] };
    expect(extractIntelligenceConditionFacts([selected]).facts.map((fact) => fact.quote)).toEqual(["Не менее 2 специалистов."]);
  });
  it.each(["hidden", "veryHidden"] as const)("requires explicit opt-in for %s sheets", (sheetState) => {
    const hidden = { ...source(""), fragments: [{ id: "sheet", locator: "Sheet", text: "Сертификат OSCP — не менее 5.", sheetState }] };
    expect(extractIntelligenceConditionFacts([hidden]).facts).toEqual([]);
    expect(extractIntelligenceConditionFacts([{ ...hidden, fragments: [{ ...hidden.fragments[0], includedByUser: true }] }]).facts).toHaveLength(1);
  });
  it("deduplicates the same literal quote within a source, but never across sources", () => {
    const text = "Сертификат OSCP — не менее 5.";
    const a = { ...source(text), fragments: [{ id: "first", locator: "First", text }, { id: "duplicate", locator: "Duplicate", text }] };
    const result = extractIntelligenceConditionFacts([a, fragmentSource(text, "source-b")]);
    expect(result.facts.map((fact) => [fact.sourceId, fact.fragmentId])).toEqual([["source-a", "first"], ["source-b", "p-1"]]);
  });
  it("is deterministic and does not mutate frozen source material or its provenance", () => {
    const input = fragmentSource("1. Копия лицензии ФСТЭК, подпункты б и е.");
    Object.freeze(input.fragments![0]); Object.freeze(input.fragments); Object.freeze(input);
    const before = JSON.stringify(input), first = extractIntelligenceConditionFacts([input]), second = extractIntelligenceConditionFacts([input]);
    expect(second).toEqual(first); expect(JSON.stringify(input)).toBe(before);
    expect(first.facts[0]).toMatchObject({ sourceName: "Synthetic source", sourceId: input.id, fragmentId: "p-1" });
  });
  it("marks oversized clauses limited instead of presenting a truncated exception as a complete fact", () => {
    const huge = "Лицензия требуется. " + "x".repeat(intelligenceConditionLimits.quoteCharacters) + " За исключением случаев из другого пункта.";
    const result = extractIntelligenceConditionFacts([fragmentSource(huge)]);
    expect(result.limited).toBe(true); expect(result.facts).toEqual([]);
  });
  it("keeps a clause exceeding the receiving list limit whole, with an explicit review flag", () => {
    const text = "Лицензия ФСБ требуется: " + "условие ".repeat(300) + "только если применимо исключение.";
    expect(text.length).toBeGreaterThan(intelligenceConditionLimits.listFieldCharacters);
    const result = extractIntelligenceConditionFacts([fragmentSource(text)]);
    expect(result.limited).toBe(false); expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({ quote: text, ambiguous: true });
  });
  it("bounds total source characters and still reports uninspected material", () => {
    const result = extractIntelligenceConditionFacts([fragmentSource("x".repeat(intelligenceConditionLimits.characters + 1))]);
    expect(result.limited).toBe(true); expect(result.facts).toEqual([]);
  });
  it("bounds facts and retains complete literal numbering in the returned prefix", () => {
    const text = Array.from({ length: intelligenceConditionLimits.facts + 1 }, (_, index) => `${index + 1}. Сертификат OSCP — не менее ${index + 1};`).join("\n");
    const result = extractIntelligenceConditionFacts([fragmentSource(text)]);
    expect(result.limited).toBe(true); expect(result.facts).toHaveLength(intelligenceConditionLimits.facts);
    expect(result.facts[0].quote).toBe("1. Сертификат OSCP — не менее 1;");
  });
  it("bounds blank fragment and source scans, not only recognized conditions", () => {
    expect(extractIntelligenceConditionFacts(Array.from({ length: intelligenceConditionLimits.sources + 1 }, (_, index) => source("", String(index)))).limited).toBe(true);
    const fragments = Array.from({ length: intelligenceConditionLimits.fragments + 1 }, (_, index) => ({ id: String(index), locator: "Empty", text: "" }));
    expect(extractIntelligenceConditionFacts([{ ...source(""), fragments }]).limited).toBe(true);
  });
  it("bounds very many wrapped lines without returning a misleading half-clause", () => {
    const text = "Лицензия ФСБ требуется:\n" + Array.from({ length: intelligenceConditionLimits.lines + 1 }, () => "продолжение условия").join("\n");
    const result = extractIntelligenceConditionFacts([fragmentSource(text)]);
    expect(result.limited).toBe(true); expect(result.facts).toEqual([]);
  });
});
