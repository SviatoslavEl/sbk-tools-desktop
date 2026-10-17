import { describe, expect, it } from "vitest";
import { autoCompleteCertificateDocuments, completeIntelligenceConditions } from "./automaticConditions";
import { buildIntelligenceHandoff, parseIntelligenceResult } from "./workbenchModel";
import type { IntelligenceDestination, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const source = (text: string, id = "source-a"): IntelligenceSource => ({ id, name: "Синтетический источник", text, fragments: [{ id: "page-1", locator: "Страница 1", text }] });
const card = (id = "card-a", destination: IntelligenceDestination = "procurement", fields: IntelligenceItem["fields"] = {}): IntelligenceItem => ({ id, destination, title: "QA", fields, selectedFields: Object.keys(fields), sourceIds: ["source-a"], evidence: [] });
const freeze = <T,>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };
const cert = "1. Сертификат OSCP — не менее 5 специалистов.";
const document = "2. Копия доверенности, если заявку подписывает представитель.";

describe("automatic literal certificate/document supplementation", () => {
  it("preserves all five certificate and application document clauses from the packaged Mac reproduction", () => {
    const input = source("Синтетическая закупка Mac QA.\nСертификаты специалистов:\n1. Сертификат OSCP — не менее 5 специалистов.\n2. Сертификат OSEP — не менее 2 специалистов.\nДокументы в составе заявки:\n1. Копия действующей лицензии ФСТЭК.\n2. Копия доверенности, если заявку подписывает представитель.\n3. Декларация соответствия требованиям участника.");
    const raw = '{"items":[{"destination":"procurement","title":"Синтетическая закупка Mac QA","fields":{"name":"Синтетическая закупка Mac QA","requirements":[]}}]}';
    const parsed = parseIntelligenceResult(raw, [input.id], { editableFields: true, destinations: ["procurement"] });
    const result = completeIntelligenceConditions(parsed, [input]);
    const clauses = ["1. Сертификат OSCP — не менее 5 специалистов.", "2. Сертификат OSEP — не менее 2 специалистов.", "1. Копия действующей лицензии ФСТЭК.", "2. Копия доверенности, если заявку подписывает представитель.", "3. Декларация соответствия требованиям участника."];
    expect(result.items[0].fields.requirements).toEqual(clauses);
    expect(result.changes).toHaveLength(5);
    expect(result.changes.filter((entry) => entry.category === "certificate")).toHaveLength(2);
    expect(result.changes.filter((entry) => entry.category === "document")).toHaveLength(3);
    expect(result.skipped).toEqual([]); expect(result.limited).toBe(false);
    expect(result.items[0].evidence?.map((entry) => entry.quote)).toEqual(clauses);
    expect(parsed[0].fields.requirements).toEqual([]);
  });

  it("adds nine certificates and eight documents completely without changing raw input, other fields or review state", () => {
    const certificates = ["OSCP", "OSEP", "BSCP", "OSWE", "OSWP", "KLCP", "eJPT", "CompTIA PenTest+", "HTB CPTS"].map((label, index) => `${index + 1}. Сертификат ${label} — не менее ${index + 1} специалистов.`);
    const documents = Array.from({ length: 8 }, (_, index) => `${index + 10}. Копия документа заявки ${index + 1}, если это применимо.`);
    const input = source([...certificates, ...documents].join("\n")), item = card("card-a", "procurement", { name: "QA", nmc: 0, notes: "Не менять", submissionDeadline: "2039-08-01" });
    const before = structuredClone({ input, item }); freeze(input); freeze(item);
    const result = completeIntelligenceConditions([item], [input]);
    expect(result.items[0].fields.requirements).toEqual([...certificates, ...documents]);
    expect(result.changes).toHaveLength(17); expect(result.changes.filter((change) => change.category === "certificate")).toHaveLength(9); expect(result.changes.filter((change) => change.category === "document")).toHaveLength(8);
    expect(result.changes.every((change) => change.kind === "added" && change.requiresReview && change.field === "requirements" && change.itemId === item.id)).toBe(true);
    expect(result.skipped).toEqual([]); expect(result.limited).toBe(false);
    expect(result.items[0].selectedFields).toContain("requirements"); expect(result.items[0].fields).toMatchObject(item.fields);
    for (const claim of result.items[0].evidence || []) expect(input.text).toContain(claim.quote);
    expect(result.items[0]).not.toHaveProperty("reviewedFindings"); expect(result.items[0]).not.toHaveProperty("documents");
    expect({ input, item }).toEqual(before);
    const handoff = buildIntelligenceHandoff(result.items[0], [input], "/synthetic/workspace");
    if (handoff.destination !== "procurement") throw new Error("Unexpected handoff");
    expect(handoff.data.requirements.every((requirement) => !requirement.mandatory)).toBe(true);
    expect(autoCompleteCertificateDocuments).toBe(completeIntelligenceConditions);
  });

  it("preserves shortened or wrong model points and adds complete literal facts instead of silently fixing them", () => {
    const input = source(cert), item = card("card-a", "procurement", { requirements: ["Нужен сертификат", "Сертификат OSCP — не менее 2 специалистов."] });
    const result = completeIntelligenceConditions([item], [input]);
    expect(result.items[0].fields.requirements).toEqual([...item.fields.requirements as string[], cert]);
    expect(result.changes[0].kind).toBe("added");
  });

  it("deduplicates presentation only and adds literal evidence even for present model conditions", () => {
    const input = source("o\tСертификат OSCP — не менее 5;"), item = card("card-a", "procurement", { requirements: ["Сертификат OSCP — не менее 5"] });
    const first = completeIntelligenceConditions([item], [input]);
    expect(first.items[0].fields.requirements).toEqual(item.fields.requirements); expect(first.changes[0].kind).toBe("present"); expect(first.items[0].evidence?.[0].quote).toBe(input.text);
    const second = completeIntelligenceConditions(first.items, [input]); expect(second.items).toEqual(first.items); expect(second.items[0].evidence).toHaveLength(1); expect(second.changes[0].kind).toBe("present");
    const distinct = completeIntelligenceConditions([card("card-a", "procurement", { requirements: ["Сертификат OSCP — не менее 2;"] })], [input]);
    expect(distinct.items[0].fields.requirements).toHaveLength(2);
  });

  it("keeps conditional alternatives and a standalone document/registry/declaration exemption whole", () => {
    const exemption = "3. Документы могут не включаться участником, если сведения содержатся в открытом реестре и представлена декларация.";
    const input = source(`${cert}\n${document}\n${exemption}`), result = completeIntelligenceConditions([card()], [input]);
    expect(result.items[0].fields.requirements).toEqual([cert, document, exemption]);
    expect(result.changes.find((change) => change.quote === exemption)).toMatchObject({ category: "exception", requiresReview: true });
    const bare = source(`${cert}\n2. Если применимо, это допускается.`), skipped = completeIntelligenceConditions([card()], [bare]);
    expect(skipped.items[0].fields.requirements).toEqual([cert]); expect(skipped.skipped.some((entry) => entry.reason === "untransferred-exception" && entry.quote?.includes("Если применимо"))).toBe(true);
  });

  it("never autogenerates a card and never changes other destinations or personal certificate documents", () => {
    const input = source(cert);
    expect(completeIntelligenceConditions([], [input])).toEqual({ items: [], changes: [], skipped: [], limited: false });
    for (const destination of ["staff", "contracts", "counterparties", "proposals"] as const) {
      const item = card("other", destination, destination === "staff" ? { certificates: ["Личный сертификат"] } : {});
      const result = completeIntelligenceConditions([item], [input]); expect(result.items).toEqual([item]); expect(result.changes).toEqual([]); expect(result.skipped).toEqual([]);
    }
  });

  it("does not distribute a shared source across two cards or across explicitly different lots", () => {
    const input = source(cert), items = [card("first"), card("second")], before = structuredClone(items);
    const duplicate = completeIntelligenceConditions(items, [input]); expect(duplicate.items).toEqual(before); expect(duplicate.changes).toEqual([]); expect(duplicate.skipped[0]).toMatchObject({ reason: "multiple-cards", itemIds: ["first", "second"] });
    for (const text of [`Лот 1: Сервер\n${cert}\nЛот 2: Аудит`, `Лоты №1 и №2\n${cert}`, `Лот А. Сервер\n${cert}\nЛот Б. Аудит`, `Лоты № 1–3\n${cert}`, `Лот A-1: Сервер\n${cert}\nЛот A-2: Аудит`]) {
      const result = completeIntelligenceConditions([card()], [source(text)]); expect(result.items[0].fields.requirements).toBeUndefined(); expect(result.skipped.some((entry) => entry.reason === "multiple-lots")).toBe(true);
    }
    expect(completeIntelligenceConditions([card()], [source(`Лот A-1: Сервер\n${cert}`)]).changes).toHaveLength(1);
  });

  it("uses only freshly extracted owned visible fragments, not stale facts, foreign or discarded aggregate text", () => {
    const foreign = source(cert, "foreign"), result = completeIntelligenceConditions([card()], [foreign]); expect(result.items[0].fields.requirements).toBeUndefined(); expect(result.skipped[0].reason).toBe("unowned-source");
    const input = source(cert); input.fragments![0].sheetState = "hidden";
    expect(completeIntelligenceConditions([card()], [input]).changes).toEqual([]);
    input.fragments = []; expect(completeIntelligenceConditions([card()], [input]).changes).toEqual([]);
    input.fragments = [{ id: "page-1", locator: "Страница 1", text: "1. Сертификат OSCP — не менее 7 специалистов." }];
    expect(completeIntelligenceConditions([card()], [input]).items[0].fields.requirements).toEqual([input.fragments[0].text]);
    input.fragments[0].sheetState = "veryHidden"; input.fragments[0].includedByUser = true;
    expect(completeIntelligenceConditions([card()], [input]).changes).toHaveLength(1);
  });

  it("rejects duplicate source identifiers and malformed old fields without partial writes", () => {
    const input = source(cert), duplicates = completeIntelligenceConditions([card()], [input, { ...input }]); expect(duplicates.changes).toEqual([]); expect(duplicates.skipped.some((entry) => entry.reason === "invalid-source")).toBe(true);
    for (const value of ["bad", "OSCP 5", "null value", true, [""], [123], ["x".repeat(2001)]]) {
      const item = card("card-a", "procurement", { requirements: value as unknown as string[] }), before = structuredClone(item);
      const result = completeIntelligenceConditions([item], [input]); expect(result.items).toEqual([before]); expect(result.changes).toEqual([]); expect(result.skipped[0].reason).toBe("invalid-requirements");
    }
  });

  it.each([
    { value: "null", kept: [] }, { value: " UNDEFINED ", kept: [] }, { value: "n/a", kept: [] },
    { value: ["null"], kept: [] }, { value: ["undefined", "N/A"], kept: [] },
    { value: ["null", "Осмысленный прежний пункт"], kept: ["Осмысленный прежний пункт"] },
  ])("replaces only exact absence placeholders with complete sourced facts: $value", ({ value, kept }) => {
    const input = source(cert), item = card("card-a", "procurement", { requirements: value }); const before = structuredClone(item);
    const result = completeIntelligenceConditions([item], [input]);
    expect(result.items[0].fields.requirements).toEqual([...kept, cert]); expect(result.changes[0].kind).toBe("added"); expect(result.changes[0].quote).toBe(cert); expect(result.changes[0].requiresReview).toBe(true);
    expect(result.skipped).toEqual([]); expect(item).toEqual(before);
  });

  it("rolls back all automatic additions for an overflowing card, not just the last condition", () => {
    const input = source(`${cert}\n${document}`), item = card("card-a", "procurement", { requirements: Array.from({ length: 99 }, (_, index) => `Прежнее условие ${index}`) });
    const result = completeIntelligenceConditions([item], [input]); expect(result.items).toEqual([item]); expect(result.changes).toEqual([]); expect(result.limited).toBe(true); expect(result.skipped).toHaveLength(2); expect(result.skipped.every((entry) => entry.reason === "requirements-limit")).toBe(true);
    const long = completeIntelligenceConditions([card()], [source(`1. Сертификат OSCP требуется: ${"x".repeat(2001)}`)]);
    expect(long.items[0].fields.requirements).toBeUndefined(); expect(long.skipped[0].reason).toBe("condition-too-long"); expect(long.limited).toBe(true);
  });

  it("respects the 500-evidence boundary without dropping old proof or adding a partial card", () => {
    const item = card(); item.evidence = Array.from({ length: 500 }, (_, index) => ({ field: "notes", sourceId: "source-a", quote: `Прежняя цитата ${index}` }));
    const result = completeIntelligenceConditions([item], [source(cert)]); expect(result.items).toEqual([item]); expect(result.changes).toEqual([]); expect(result.skipped[0].reason).toBe("evidence-limit"); expect(result.limited).toBe(true);
  });

  it("signals limited inventories explicitly and never presents the found prefix as complete", () => {
    const inputs = Array.from({ length: 65 }, (_, index) => source(cert, `source-${index}`)); const item = card(); item.sourceIds = inputs.map((input) => input.id);
    const result = completeIntelligenceConditions([item], inputs); expect(result.items).toEqual([item]); expect(result.changes).toEqual([]); expect(result.skipped.some((entry) => entry.reason === "inventory-limit")).toBe(true); expect(result.limited).toBe(true);
  });

  it("allows a different eligible card to complete when one card's requirements are invalid", () => {
    const first = card("bad", "procurement", { requirements: "invalid" }), second = card("good"); second.sourceIds = ["source-b"];
    const result = completeIntelligenceConditions([first, second], [source(cert), source(document, "source-b")]);
    expect(result.items[0]).toEqual(first); expect(result.items[1].fields.requirements).toEqual([document]); expect(result.changes).toHaveLength(1); expect(result.changes[0].itemId).toBe("good"); expect(result.skipped[0].itemId).toBe("bad");
  });
});
