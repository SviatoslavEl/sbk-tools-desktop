import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, extractIntelligenceDateFacts, type IntelligenceDateEvent } from "./resultEvidence";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const source = (text: string, extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "dates-qa", name: "Синтетические даты QA", text, ...extra });
const only = (text: string) => extractIntelligenceDateFacts([source(text)]).facts;

describe("source-only date facts", () => {
  it.each<[IntelligenceDateEvent, string]>([
    ["submission-start", "Начало подачи заявок: 03.08.2039"],
    ["submission-end", "Срок подачи заявок: 03.08.2039, 11:45 MSK"],
    ["question-deadline", "Срок вопросов: 03.08.2039"],
    ["publication", "Дата публикации: 03.08.2039"],
    ["revision", "Редакция извещения от 03.08.2039, 11:45"],
    ["consideration", "Дата рассмотрения заявок: 03.08.2039"],
    ["results", "Подведение итогов: 03.08.2039"],
    ["execution-start", "Начало выполнения работ: 03.08.2039"],
    ["execution-end", "Окончание выполнения работ: 03.08.2039"],
    ["contract-date", "Договор № ИТ-QA от 03.08.2039"],
    ["proposal-date", "Коммерческое предложение от 03.08.2039"],
    ["valid-until", "Действует до: 03.08.2039"],
  ])("retains the explicit %s event without assigning it to a card", (event, text) => {
    const input = source("Discarded aggregate", { fragments: [{ id: "qa-date", locator: "Абзац QA", text }] });
    const snapshot = JSON.stringify(input);
    const result = extractIntelligenceDateFacts([input]);
    expect(result).toMatchObject({ limited: false, facts: [{ event, iso: "2039-08-03", sourceId: input.id, sourceName: input.name, fragmentId: "qa-date", locator: "Абзац QA", quote: text }] });
    expect(result.facts).toHaveLength(1);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
  it("returns no universal date fact for unknown labels, statutes, durations or placeholders", () => {
    expect(only("Дата: 03.08.2039\nФедеральный закон от 03.08.2039\nПоставка: в течение 30 дней\nСрок подачи: __.__.____")).toEqual([]);
  });
  it.each(["Срок подачи: 31.02.2039 11:45", "Срок подачи: 2039-13-03 11:45", "Срок подачи: 03.08.2039 24:00", "Срок подачи: 03.08.2039 11:60", "Срок подачи: 29.02.2039"])("does not emit an invalid calendar/clock as a known event: %s", (text) => {
    expect(only(text)).toEqual([]);
  });
  it("accepts a real leap day without inventing another event", () => {
    expect(only("Срок подачи: 29.02.2036, 00:00:00 UTC")[0]).toMatchObject({ iso: "2036-02-29", event: "submission-end", time: "00:00:00", timezone: "UTC" });
  });
  it.each(["MSK", "МСК", "UTC+03:00"])("preserves a global %s rule after a revision prefix and its literal quote", (zone) => {
    const declaration = `Редакция извещения от 01.08.2039,09:30, время в документе указано в часовом поясе${zone}.`;
    const result = only(`${declaration}\nСрок подачи: 03.08.2039,11:45.`);
    const fact = result.find((entry) => entry.event === "submission-end");
    expect(fact).toMatchObject({ timezone: "MSK", time: "11:45", supportingEvidence: [{ quote: declaration }] });
    expect(fact?.ambiguous).toBeUndefined();
    expect(fact?.quote).toBe("Срок подачи: 03.08.2039,11:45.");
  });
  it.each(["Дата публикации: 01.08.2039 09:30 MSK", "Время публикации в документе указано в часовом поясеMSK.", "Редакция от 01.08.2039 09:30 MSK"])("does not borrow a timezone from another event: %s", (prefix) => {
    const fact = only(`${prefix}\nСрок подачи: 03.08.2039, 11:45`).find((entry) => entry.event === "submission-end");
    expect(fact?.timezone).toBeUndefined();
    expect(fact?.supportingEvidence).toBeUndefined();
  });
  it("keeps source-wide rules within their own source, not another selected document", () => {
    const result = extractIntelligenceDateFacts([source("Время в документе указано в MSK."), source("Срок подачи: 03.08.2039 11:45", { id: "second", name: "Другой синтетический документ" })]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({ sourceId: "second", iso: "2039-08-03" });
    expect(result.facts[0].timezone).toBeUndefined();
  });
  it.each(["Срок подачи: 03.08.2039 11:45 MSK (UTC)", "Время в документе указано в MSK и UTC.\nСрок подачи: 03.08.2039 11:45"])("exposes conflicting zones as ambiguous without choosing a zone: %s", (text) => {
    const fact = only(text).find((entry) => entry.event === "submission-end");
    expect(fact?.ambiguous).toBe(true);
    expect(fact?.timezone).toBeUndefined();
  });
  it("retains lower delivery bounds as bounds, not a promised start", () => {
    const facts = only("Поставка не может быть осуществлена ранее 03.08.2039.\nОкончание поставки: 15.08.2039");
    expect(facts.find((entry) => entry.iso === "2039-08-03")).toMatchObject({ event: "execution-start", lowerBound: true });
    expect(facts.find((entry) => entry.iso === "2039-08-15")?.lowerBound).toBeUndefined();
  });
  it("does not let the next sentence relabel a results date as a delivery start", () => {
    const facts = only("Подведение итогов: не ранее 03.08.2039. Поставка в течение 30 дней после договора.");
    expect(facts).toHaveLength(1);
    expect(facts[0].event).toBe("results");
  });
  it("keeps wrapped event labels and generic proposal-date headings inside a fragment", () => {
    const fragments = [{ id: "label", locator: "Страница 1", text: "Срок подачи заявок:" }, { id: "date", locator: "Страница 2", text: "03.08.2039 11:45 MSK" }];
    expect(extractIntelligenceDateFacts([source("Срок подачи: 03.08.2039 11:45 MSK", { fragments })]).facts).toEqual([]);
    expect(only("Срок подачи заявок:\n03.08.2039 11:45 MSK")[0]?.event).toBe("submission-end");
    const proposal = [{ id: "heading", locator: "Страница 1", text: "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ" }, { id: "date", locator: "Страница 2", text: "Дата: 03.08.2039" }];
    expect(extractIntelligenceDateFacts([source("unused", { fragments: proposal })]).facts).toEqual([]);
    expect(only("КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ\nДата: 03.08.2039")[0]?.event).toBe("proposal-date");
  });
  it("does not reintroduce discarded aggregate text or hidden history without opt-in", () => {
    const old = { id: "old", locator: "История QA", text: "Срок подачи: 03.08.2039", sheetState: "hidden" as const };
    const input = source(old.text, { fragments: [old, { id: "new", locator: "Текущий лист QA", text: "Срок подачи не указан" }] });
    expect(extractIntelligenceDateFacts([input]).facts).toEqual([]);
    expect(extractIntelligenceDateFacts([source(old.text, { fragments: [] })]).facts).toEqual([]);
    expect(extractIntelligenceDateFacts([source("unused", { fragments: [{ ...old, includedByUser: true }] })]).facts[0]).toMatchObject({ fragmentId: "old", event: "submission-end" });
  });
  it("marks multi-lot submission association for review and includes literal lot headings", () => {
    const text = "Лот 1: Поставка оборудования QA\nСрок подачи: 03.08.2039, 11:45 MSK\nЛот 2: Проверка системы QA\nСрок подачи: 04.08.2039, 15:30 MSK";
    const result = extractIntelligenceDateFacts([source(text)]);
    expect(result.facts).toHaveLength(2);
    for (const fact of result.facts) {
      expect(fact.ambiguous).toBe(true);
      expect(fact.supportingEvidence?.map((entry) => entry.quote)).toEqual(["Лот 1: Поставка оборудования QA", "Лот 2: Проверка системы QA"]);
    }
    expect(only(text.split("\n").slice(0, 2).join("\n"))[0].ambiguous).toBeUndefined();
  });
  it("does not change an existing audit or any source/card data", () => {
    const input = source("Срок подачи: 03.08.2039 11:45 MSK");
    const item: IntelligenceItem = { id: "qa", title: "Сроки QA", destination: "procurement", sourceIds: [input.id], fields: { submissionDeadline: "2039-08-03", notes: "Подача 11:45 MSK" }, selectedFields: ["submissionDeadline", "notes"] };
    const snapshot = JSON.stringify({ input, item });
    const before = auditIntelligenceResult([item], [input]);
    extractIntelligenceDateFacts([input]);
    expect(auditIntelligenceResult([item], [input])).toEqual(before);
    expect(JSON.stringify({ input, item })).toBe(snapshot);
  });
  it("reports the existing 1000-date budget instead of claiming unlimited extraction", () => {
    const result = extractIntelligenceDateFacts([source(Array.from({ length: 1001 }, () => "Срок подачи: 03.08.2039").join("\n"))]);
    expect(result.limited).toBe(true);
    expect(result.facts).toHaveLength(1000);
  });
  it("reports the existing row/character budgets even if later dated text is not visited", () => {
    const rows = extractIntelligenceDateFacts([source([...Array.from({ length: 5000 }, () => "Строка QA"), "Срок подачи: 03.08.2039"].join("\n"))]);
    expect(rows).toEqual({ limited: true, facts: [] });
    const longRow = extractIntelligenceDateFacts([source(`${"x".repeat(20001)}\nСрок подачи: 03.08.2039`)]);
    expect(longRow).toEqual({ limited: true, facts: [] });
    const total = extractIntelligenceDateFacts([source(`${"x".repeat(2 * 1024 * 1024 + 1)}\nСрок подачи: 03.08.2039`)]);
    expect(total).toEqual({ limited: true, facts: [] });
  });
});
