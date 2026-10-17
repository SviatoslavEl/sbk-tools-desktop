import { describe, expect, it } from "vitest";
import { collectLiteralCompleteness, LITERAL_COMPLETENESS_LIMITS } from "./literalCompleteness";
import type { IntelligenceDateFact } from "./resultEvidence";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const fragment = (index: number, text: string, extra: Partial<IntelligenceFragment> = {}): IntelligenceFragment => ({ id: `paragraph-${index}`, locator: `Абзац ${index}`, text, ...extra });
const source = (fragments: IntelligenceFragment[], extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "source-qa", name: "Синтетический источник QA", text: fragments.map((entry) => entry.text).join("\n"), fragments, ...extra });
const contract = (number = "QA-1", id = "contract-a", sourceId = "source-qa"): IntelligenceItem => ({ id, destination: "contracts", title: "Договор QA", sourceIds: [sourceId], selectedFields: ["number"], fields: { number } });
const proposal = (fields: IntelligenceItem["fields"] = {}, id = "proposal-a"): IntelligenceItem => ({ id, destination: "proposals", title: "КП QA", sourceIds: ["source-qa"], selectedFields: Object.keys(fields), fields });
const table = (count = 5, tableId = "table"): IntelligenceFragment[] => [
  { id: `${tableId}-row-1`, locator: "Таблица, строка 1", text: "№ п/п\tПериод исполнения\tЗаказчик\tПредмет и содержание договора\tСумма договора, рублей" },
  ...Array.from({ length: count }, (_, index) => ({ id: `${tableId}-row-${index + 2}`, locator: `Таблица, строка ${index + 2}`, text: `${index + 1}.\tмарт 2026 - май 2026\tТестовый заказчик ${index + 1}\tУслуга QA. Договор № QA-${index + 1}${index === 1 ? " (ALT-2)" : ""} от 03.02.2026.\t${index + 1} 000,00` })),
];
const advance = "Авансовый платеж — 30% в течение 7 календарных дней после подписания договора;";
const final = "Окончательный расчет — 70% в течение 9 календарных дней после приемки либо истечения срока мотивированного отказа.";
const paymentSource = () => source([fragment(1, "Коммерческое предложение QA"), fragment(2, "Условия оплаты:"), fragment(3, advance), fragment(4, final), fragment(5, "Срок действия предложения:"), fragment(6, "60 календарных дней после подписания письма.")]);
const dateSource = () => source([fragment(1, "Исх. № _____ от «03» февраля 2026")]);
const dateFact = (extra: Partial<IntelligenceDateFact> = {}): IntelligenceDateFact => ({ sourceId: "source-qa", sourceName: "Синтетический источник QA", fragmentId: "paragraph-1", locator: "Абзац 1", quote: "Исх. № _____ от «03» февраля 2026", iso: "2026-02-03", event: "proposal-date", ...extra });
const freeze = <T,>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

describe("literal contract-table completeness, without creating or guessing records", () => {
  it("signals each of four missing explicit rows when one card replaces a five-contract registry", () => {
    const sources = [source(table())], items = [contract()], before = structuredClone({ sources, items }); freeze(sources); freeze(items);
    const signals = collectLiteralCompleteness(items, sources);
    expect(signals).toHaveLength(4); expect(signals.every((entry) => entry.code === "missing-contract-card" && entry.itemId === "contract-a" && entry.field === undefined)).toBe(true);
    expect(signals.map((entry) => entry.evidence[0].fragmentId)).toEqual(["table-row-3", "table-row-4", "table-row-5", "table-row-6"]);
    expect(signals[0].message).toContain("QA-2 (ALT-2)");
    for (const signal of signals) expect(sources[0].fragments!.some((entry) => entry.text === signal.evidence[0].quote)).toBe(true);
    expect({ sources, items }).toEqual(before);
    expect(items[0].fields.startDate).toBeUndefined(); expect(items[0].fields.endDate).toBeUndefined();
  });

  it("accepts all five distinct selected contract numbers; title, evidence and deselected numbers cannot stand in for cards", () => {
    const sources = [source(table())];
    const items = [contract("QA-1"), contract("QA-2 (ALT-2)", "b"), contract("QA-3", "c"), contract("QA-4", "d"), contract("QA-5", "e")];
    expect(collectLiteralCompleteness(items, sources)).toEqual([]);
    const excluded = { ...items[4], title: "QA-5", selectedFields: [], evidence: [{ field: "number", sourceId: "source-qa", quote: sources[0].fragments![5].text }] };
    const signals = collectLiteralCompleteness([...items.slice(0, 4), excluded], sources);
    expect(signals).toHaveLength(5); expect(signals.every((entry) => entry.message.includes("QA-5"))).toBe(true);
  });

  it("deduplicates repeated contract references rather than counting rows or cards blindly", () => {
    const fragments = table(2); fragments[2].text = fragments[2].text.replace("QA-2 (ALT-2)", "QA-1");
    expect(collectLiteralCompleteness([contract()], [source(fragments)])).toEqual([]);
    expect(collectLiteralCompleteness([contract(), contract("QA-1", "duplicate")], [source(table())])).toHaveLength(8);
  });

  it("keeps repeated numbers with different full dates separate, requiring the selected matching date only for those numbers", () => {
    const fragments = table(2);
    fragments[2].text = fragments[2].text.replace("QA-2 (ALT-2)", "QA-1").replace("03.02.2026", "03.02.2025");
    const sources = [source(fragments)];
    const dated = (iso: string, id: string): IntelligenceItem => ({ ...contract("QA-1", id), fields: { number: "QA-1", date: iso }, selectedFields: ["number", "date"] });
    const signals = collectLiteralCompleteness([dated("2026-02-03", "a")], sources);
    expect(signals).toHaveLength(1); expect(signals[0].message).toContain("повторяется с разными полными датами");
    expect(signals[0].message).toContain("2025-02-03"); expect(signals[0].evidence[0].quote).toBe(fragments[2].text);
    expect(collectLiteralCompleteness([dated("2026-02-03", "a"), dated("2025-02-03", "b")], sources)).toEqual([]);
    expect(collectLiteralCompleteness([contract()], sources)).toHaveLength(2);
    expect(collectLiteralCompleteness([{ ...dated("2026-02-03", "a"), selectedFields: ["number"] }], sources)).toHaveLength(2);
    // A unique number does not suddenly require inventing/assigning its date.
    expect(collectLiteralCompleteness([contract()], [source(table(1))])).toEqual([]);
  });

  it("does not infer a contract registry from a prose reference list, filename or an unlabelled/foreign table", () => {
    expect(collectLiteralCompleteness([contract()], [source(table().slice(1))])).toEqual([]);
    expect(collectLiteralCompleteness([contract()], [source([fragment(1, table()[1].text), fragment(2, table()[2].text)])])).toEqual([]);
    const pieces = table(); pieces[0].text = "№\tНазвание\tСсылка\tПредмет\tЦена";
    expect(collectLiteralCompleteness([contract()], [source(pieces, { name: "Реестр 5 договоров.docx" })])).toEqual([]);
    expect(collectLiteralCompleteness([contract("QA-1", "foreign-card", "another-source")], [source(table())])).toEqual([]);
  });

  it("never carries a header across table IDs, intervening paragraphs, row gaps or a different source", () => {
    const explicit = table(2, "table-1"); explicit[2].id = "table-2-row-3";
    expect(collectLiteralCompleteness([contract()], [source(explicit)])).toEqual([]);
    const original = table(2);
    expect(collectLiteralCompleteness([contract()], [source([original[0], original[1], fragment(1, "Новая таблица"), original[2]])])).toEqual([]);
    expect(collectLiteralCompleteness([contract()], [source([original[0], original[2]])])).toEqual([]);
    expect(collectLiteralCompleteness([contract()], [source([original[0]], { id: "foreign" }), source(original.slice(1))])).toEqual([]);
  });

  it("uses only explicit selected fragments, not hidden or stale aggregate text", () => {
    const full = source(table());
    expect(collectLiteralCompleteness([contract()], [{ ...full, fragments: [] }])).toEqual([]);
    expect(collectLiteralCompleteness([contract()], [{ ...full, fragments: table().map((entry) => ({ ...entry, sheetState: "hidden" })) }])).toEqual([]);
    const included = { ...full, fragments: table().map((entry) => ({ ...entry, sheetState: "hidden" as const, includedByUser: true })) };
    expect(collectLiteralCompleteness([contract()], [included])).toHaveLength(4);
    expect(collectLiteralCompleteness([contract()], [full, { ...full, text: "other" }])).toEqual([]);
  });
});

describe("narrow proposal completeness", () => {
  it("signals a unique fresh explicit proposal date but never assigns or computes any field", () => {
    const item = proposal({ validUntil: "2026-04-04" }), before = structuredClone(item); freeze(item);
    const signals = collectLiteralCompleteness([item], [dateSource()], [dateFact()]);
    expect(signals).toHaveLength(1); expect(signals[0].code).toBe("missing-proposal-date"); expect(signals[0].field).toBeUndefined(); expect(signals[0].evidence[0].quote).toBe(dateFact().quote); expect(item).toEqual(before);
    expect(collectLiteralCompleteness([proposal({ documentDate: "2026-02-03" })], [dateSource()], [dateFact()])).toEqual([]);
    expect(collectLiteralCompleteness([{ ...proposal({ documentDate: "2026-02-03" }), selectedFields: [] }], [dateSource()], [dateFact()])[0].code).toBe("missing-proposal-date");
  });

  it("retains a separate fresh commercial-proposal heading proof and rejects stale, foreign or excluded supporting context", () => {
    const heading = fragment(2, "Коммерческое предложение"), sources = [source([...dateSource().fragments!, heading])];
    const proof = { sourceId: "source-qa", sourceName: sources[0].name, fragmentId: heading.id, locator: heading.locator, quote: heading.text };
    const fact = dateFact({ supportingEvidence: [proof] });
    const signals = collectLiteralCompleteness([proposal()], sources, [fact]);
    expect(signals).toHaveLength(1); expect(signals[0].evidence).toEqual([expect.objectContaining({ sourceId: fact.sourceId, fragmentId: fact.fragmentId, locator: fact.locator, quote: fact.quote }), proof]);
    expect(collectLiteralCompleteness([proposal()], sources, [dateFact({ supportingEvidence: [{ ...proof, sourceId: "foreign" }] })])).toEqual([]);
    expect(collectLiteralCompleteness([proposal()], sources, [dateFact({ supportingEvidence: [{ ...proof, quote: "Заголовок старой версии" }] })])).toEqual([]);
    expect(collectLiteralCompleteness([proposal()], [{ ...sources[0], fragments: [sources[0].fragments![0], { ...heading, sheetState: "hidden" }] }], [fact])).toEqual([]);
  });

  it.each([
    { event: "contract-date" as const }, { ambiguous: true }, { lowerBound: true }, { sourceId: "foreign" }, { sourceName: "Old snapshot" }, { fragmentId: "missing" }, { locator: "Абзац 99" }, { quote: "Дата из старой версии" }, { iso: "2026-02-30" },
  ])("ignores dates with a wrong event, uncertain scope or stale provenance: %j", (extra) => {
    expect(collectLiteralCompleteness([proposal()], [dateSource()], [dateFact(extra)])).toEqual([]);
  });

  it("does not choose between dates or between proposal cards, and does not resurrect an excluded fragment", () => {
    const second = fragment(2, "Дата КП: 04.02.2026");
    const sources = [source([...dateSource().fragments!, second])];
    expect(collectLiteralCompleteness([proposal()], sources, [dateFact(), dateFact({ iso: "2026-02-04", fragmentId: second.id, locator: second.locator, quote: second.text })])).toEqual([]);
    expect(collectLiteralCompleteness([proposal(), proposal({}, "other")], [dateSource()], [dateFact()])).toEqual([]);
    expect(collectLiteralCompleteness([proposal()], [{ ...dateSource(), fragments: [] }], [dateFact()])).toEqual([]);
  });

  it("checks every complete payment clause including the final-payment OR qualification", () => {
    const sources = [paymentSource()], item = proposal({ paymentTerms: advance }), before = structuredClone({ sources, item }); freeze(sources); freeze(item);
    const signals = collectLiteralCompleteness([item], sources);
    expect(signals).toHaveLength(1); expect(signals[0].code).toBe("missing-payment-clause"); expect(signals[0].field).toBeUndefined(); expect(signals[0].evidence[0].quote).toBe(final);
    expect(collectLiteralCompleteness([proposal({ paymentTerms: `${advance}\n${final}` })], sources)).toEqual([]);
    expect(collectLiteralCompleteness([proposal({ paymentTerms: `${advance}\nОкончательный расчет — 70% после приемки.` })], sources)).toHaveLength(1);
    expect(collectLiteralCompleteness([proposal({ internalNote: `${advance}\n${final}` })], sources)).toHaveLength(2);
    expect({ sources, item }).toEqual(before);
  });

  it("does not borrow a heading across sources, tables, sheets, hidden paragraphs or an unrelated following section", () => {
    const item = proposal();
    expect(collectLiteralCompleteness([item], [source([fragment(1, advance), fragment(2, final)])])).toEqual([]);
    expect(collectLiteralCompleteness([item], [source([fragment(1, "Условия оплаты:")], { id: "foreign" }), source([fragment(2, final)])])).toEqual([]);
    expect(collectLiteralCompleteness([item], [source([fragment(1, "Условия оплаты:"), fragment(2, "Сроки поставки:"), fragment(3, final)])])).toEqual([]);
    expect(collectLiteralCompleteness([item], [source([fragment(1, "Условия оплаты:"), fragment(2, final, { sheetId: "other-sheet" })])])).toEqual([]);
    expect(collectLiteralCompleteness([item], [source([fragment(1, "Условия оплаты:", { sheetState: "hidden" }), fragment(2, final)])])).toEqual([]);
    expect(collectLiteralCompleteness([item], [source([fragment(1, "Условия оплаты:"), { id: "table-row-1", locator: "Таблица, строка 1", text: final }])])).toEqual([]);
  });
});

describe("bounded completeness signals", () => {
  it("keeps the global signal cap and adds an explicit budget warning instead of claiming exhaustive completeness", () => {
    const signals = collectLiteralCompleteness([contract("unrelated")], [source(table(280))]);
    expect(signals).toHaveLength(LITERAL_COMPLETENESS_LIMITS.signals);
    expect(signals[signals.length - 1]?.code).toBe("literal-completeness-limit");
  });

  it.each([
    Array.from({ length: 5001 }, (_, index) => fragment(index + 1, "QA")),
    Array.from({ length: 120 }, (_, index) => fragment(index + 1, "а".repeat(18000))),
    [fragment(1, "QA".repeat(10001))],
  ].map((fragments) => ({ fragments })))("reports fragment/UTF-8/whole-fragment budgets without truncating quotes", ({ fragments }) => {
    const signals = collectLiteralCompleteness([proposal()], [source(fragments)]);
    expect(signals).toHaveLength(1); expect(signals[0].code).toBe("literal-completeness-limit"); expect(signals[0].evidence).toEqual([]);
  });

  it("does not emit procurement/staff noise, and never creates cards for an empty result", () => {
    expect(collectLiteralCompleteness([], [source(table())])).toEqual([]);
    expect(collectLiteralCompleteness([{ ...proposal(), destination: "staff" }], [paymentSource()])).toEqual([]);
  });
});
