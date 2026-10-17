import { describe, expect, it } from "vitest";
import { completeProposalPublicTerms, extractProposalPublicTerms, proveProposalPublicTerms, PROPOSAL_PUBLIC_TERMS_LIMITS } from "./proposalPublicTerms";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const scope = "Дополнительные работы за рамками согласованного периметра проекта могут быть предметом отдельного согласования;";
const schedule = "Календарные сроки и состав проектной команды уточняются на этапе запуска проекта с учетом доступности участников.";
const validity = "90 календарных дней с даты исходящего письма.";
const expected = ["Оговорки:", scope, schedule, "Срок действия предложения:", validity].join("\n");
const paragraph = (number: number, text: string): IntelligenceFragment => ({ id: `paragraph-${number}`, locator: `Абзац ${number}`, text });
const source = (): IntelligenceSource => ({ id: "source", name: "Синтетическое предложение QA", text: "Не восстанавливать удалённые фрагменты из агрегата", fragments: [paragraph(1, "Коммерческое предложение"), paragraph(2, "Аудит системы QA"), paragraph(3, "Вступление"), paragraph(4, "Оговорки:"), paragraph(5, scope), paragraph(6, schedule), paragraph(7, "Срок действия предложения:"), paragraph(8, validity), paragraph(13, "С уважением,")] });
const card = (fields: IntelligenceItem["fields"] = {}): IntelligenceItem => ({ id: "card", destination: "proposals", title: "Аудит системы QA", sourceIds: ["source"], fields, selectedFields: Object.keys(fields), evidence: [] });
const freeze = <T,>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

describe("bounded literal public proposal clauses", () => {
  it("preserves all public clauses and actual heading/paragraph claims without changing private text, raw dates or inputs", () => {
    const input = source(), item = card({ internalNote: "PRIVATE QA" }), before = structuredClone({ input, item }); freeze(input); freeze(item);
    const result = completeProposalPublicTerms([item], [input]), current = result.items[0];
    expect(current.fields.deliveryTerms).toBe(expected); expect(current.fields.internalNote).toBe("PRIVATE QA"); expect(current.fields.validUntil).toBeUndefined();
    expect(current.selectedFields).toContain("deliveryTerms"); expect(current.evidence).toHaveLength(6);
    expect(current.evidence!.every((claim) => claim.field === "deliveryTerms" && input.fragments!.some((fragment) => fragment.id === claim.fragmentId && fragment.text === claim.quote))).toBe(true);
    expect(result.changes).toHaveLength(1); expect(result.changes[0]).toMatchObject({ field: "deliveryTerms", requiresReview: true });
    expect(result.changes[0]).not.toHaveProperty("role"); expect(proveProposalPublicTerms(current, [current], [input])).toBeDefined();
    expect({ input, item }).toEqual(before); expect(current).not.toHaveProperty("reviewedFindings");
  });
  it("is idempotent and recovers missing claims for an already complete literal value without duplicating text", () => {
    const input = source(), item = card({ deliveryTerms: expected });
    const first = completeProposalPublicTerms([item], [input]); expect(first.items[0].fields.deliveryTerms).toBe(expected); expect(first.items[0].evidence).toHaveLength(6);
    const second = completeProposalPublicTerms(first.items, [input]); expect(second.items).toEqual(first.items); expect(second.changes).toEqual([]);
  });
  it("keeps a meaningful unproven prefix and does not grant a whole-field proof", () => {
    const input = source(), item = card({ deliveryTerms: "Срок поставки — 1 день без согласования." });
    const result = completeProposalPublicTerms([item], [input]); expect(result.items[0].fields.deliveryTerms).toBe(`${item.fields.deliveryTerms}\n${expected}`);
    expect(proveProposalPublicTerms(result.items[0], result.items, [input])).toBeUndefined();
  });
  it.each([scope, `${scope}\n${schedule}`, `${scope}\n${schedule}\n${validity}`, `${schedule}\n${validity}`])("canonicalizes only a whole ordered literal clause sequence: %s", (previous) => {
    const input = source(), result = completeProposalPublicTerms([card({ deliveryTerms: previous })], [input]);
    expect(result.items[0].fields.deliveryTerms).toBe(expected);
    expect(String(result.items[0].fields.deliveryTerms).split(scope)).toHaveLength(2);
    expect(proveProposalPublicTerms(result.items[0], result.items, [input])).toBeDefined();
    expect(result.changes[0].previousValue).toBe(previous);
  });
  it.each([`${schedule}\n${scope}`, scope.slice(0, -12), scope.replace("периметра", "объема"), validity.replace("90", "89"), `${scope}\nПостороннее условие.`])("preserves a nonliteral, incomplete or wrongly ordered old value: %s", (previous) => {
    const input = source(), result = completeProposalPublicTerms([card({ deliveryTerms: previous })], [input]);
    expect(String(result.items[0].fields.deliveryTerms).startsWith(previous)).toBe(true);
    expect(proveProposalPublicTerms(result.items[0], result.items, [input])).toBeUndefined();
    expect(result.changes[0].previousValue).toBe(previous);
  });
  it("deduplicates only the complete literal text across whitespace wrapping", () => {
    const input = source(); input.fragments![4].text = scope.replace("периметра проекта", "периметра\nпроекта");
    const first = completeProposalPublicTerms([card()], [input]), second = completeProposalPublicTerms(first.items, [input]);
    expect(second.items).toEqual(first.items); expect(second.changes).toEqual([]);
  });
  it.each(["Контакты:", "Реквизиты:", "Заключение:"])("accepts the explicit adjacent closing heading %s without copying its content", (closing) => {
    const input = source(); input.fragments![8] = paragraph(9, closing); input.fragments!.push(paragraph(10, "PRIVATE CONTACT"));
    const result = completeProposalPublicTerms([card()], [input]); expect(result.items[0].fields.deliveryTerms).toBe(expected); expect(String(result.items[0].fields.deliveryTerms)).not.toContain("PRIVATE CONTACT");
  });
  it.each(["unknown", "incomplete", "complete"])("rejects an open selected prefix at EOF with %s coverage", (coverage) => {
    const input = source(); input.fragments!.pop(); if (coverage !== "unknown") input.coverage = { complete: coverage === "complete", requiresOcr: coverage === "incomplete" };
    expect(extractProposalPublicTerms([input]).sections).toEqual([]); expect(completeProposalPublicTerms([card()], [input]).changes).toEqual([]);
  });
  it.each(["hidden", "veryHidden", "gap", "sheet", "table", "locator-mismatch", "duplicate-fragment", "duplicate-heading", "dated-second-proposal", "dated-contract", "missing-heading", "other-document", "unknown-terminator", "closing-gap"])("does not infer complete owned public sections across %s", (variant) => {
    const input = source(), target = input.fragments![4];
    if (variant === "hidden" || variant === "veryHidden") { target.sheetState = variant; target.includedByUser = true; }
    if (variant === "gap") { target.id = "paragraph-20"; target.locator = "Абзац 20"; }
    if (variant === "sheet") target.sheetId = "other";
    if (variant === "table") target.id = "table-row-5";
    if (variant === "locator-mismatch") target.locator = "Абзац 99";
    if (variant === "duplicate-fragment") input.fragments!.push(structuredClone(target));
    if (variant === "duplicate-heading") input.fragments!.push(paragraph(14, "Коммерческое предложение"));
    if (variant === "dated-second-proposal") input.fragments![1].text = "Коммерческое предложение № 2 от 01.01.2030";
    if (variant === "dated-contract") input.fragments![1].text = "Договор № 14 от 01.01.2030";
    if (variant === "missing-heading") input.fragments![0].text = "Простой запрос QA";
    if (variant === "other-document") input.fragments!.splice(3, 0, paragraph(3, "Договор"));
    if (variant === "unknown-terminator") input.fragments![8] = paragraph(9, "Непонятный раздел:");
    if (variant === "closing-gap") input.fragments![8] = paragraph(13, "Контакты:");
    expect(extractProposalPublicTerms([input]).sections).toEqual([]);
    expect(completeProposalPublicTerms([card()], [input]).items[0].fields.deliveryTerms).toBeUndefined();
  });
  it("does not restore excluded aggregate paragraphs or create new cards", () => {
    const input = source(); input.text = input.fragments!.map((fragment) => fragment.text).join("\n"); input.fragments = [];
    expect(completeProposalPublicTerms([card()], [input]).changes).toEqual([]); expect(completeProposalPublicTerms([], [source()]).items).toEqual([]);
  });
  it.each(["two-cards", "two-sources", "foreign-source", "other-destination"])("does not distribute public terms through %s", (variant) => {
    const input = source(), item = card(), items = [item], sources = [input];
    if (variant === "two-cards") items.push({ ...card(), id: "other" });
    if (variant === "two-sources") { sources.push({ ...source(), id: "other" }); item.sourceIds.push("other"); }
    if (variant === "foreign-source") item.sourceIds = ["stale"];
    if (variant === "other-destination") item.destination = "procurement";
    expect(completeProposalPublicTerms(items, sources).items).toEqual(items);
  });
  it.each(["sources", "items", "duplicate-source", "duplicate-item", "fragments", "bytes", "fragment", "quote", "evidence", "field", "section-clauses"])("fails atomically for the %s bound", (variant) => {
    const input = source(), item = card(), sources = [input], items = [item];
    if (variant === "sources") sources.push(...Array.from({ length: 100 }, (_, index) => ({ ...source(), id: `other-${index}` })));
    if (variant === "items") items.push(...Array.from({ length: 100 }, (_, index) => ({ ...card(), id: `other-${index}` })));
    if (variant === "duplicate-source") sources.push(source());
    if (variant === "duplicate-item") items.push(card());
    if (variant === "fragments") input.fragments = Array.from({ length: PROPOSAL_PUBLIC_TERMS_LIMITS.fragments + 1 }, (_, index) => paragraph(index + 1, "QA"));
    if (variant === "bytes") input.fragments = Array.from({ length: 110 }, (_, index) => paragraph(index + 1, "я".repeat(10_000)));
    if (variant === "fragment") input.fragments![1].text = "X".repeat(PROPOSAL_PUBLIC_TERMS_LIMITS.fragment + 1);
    if (variant === "quote") input.fragments![4].text = `${scope} ${"X".repeat(PROPOSAL_PUBLIC_TERMS_LIMITS.quote)}`;
    if (variant === "evidence") item.evidence = Array.from({ length: 500 }, (_, index) => ({ field: "internalNote", sourceId: "source", quote: `QA ${index}` }));
    if (variant === "field") item.fields.deliveryTerms = "X".repeat(PROPOSAL_PUBLIC_TERMS_LIMITS.field);
    if (variant === "section-clauses") input.fragments = [paragraph(1, "Коммерческое предложение"), paragraph(2, "Оговорки:"), ...Array.from({ length: 7 }, (_, index) => paragraph(index + 3, scope)), paragraph(10, "С уважением,")];
    const before = structuredClone({ items, sources }), result = completeProposalPublicTerms(items, sources);
    expect(result.items).toEqual(items); expect(result.changes).toEqual([]); expect(result.limited).toBe(true); expect(result.skipped.length).toBeGreaterThan(0); expect({ items, sources }).toEqual(before);
  });
});
