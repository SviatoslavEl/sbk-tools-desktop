import { describe, expect, it } from "vitest";
import { runResponsePreparation, validResponsePreparationReply } from "./responsePreparationWorker";
import type { IntelligenceSource } from "./workbenchTypes";
const source: IntelligenceSource = { id: "qa-source", name: "Таблица опыта QA", text: "", fragments: [
  { id: "table-row-1", locator: "Таблица, строка 1", text: "№ п/п\tЗаказчик\tПредмет договора\tСумма договора" },
  ...Array.from({ length: 5 }, (_, index) => ({ id: `table-row-${index + 2}`, locator: `Таблица, строка ${index + 2}`, text: `${index + 1}.\tКлиент ${index + 1}\tАудит QA. Договор № QA-${index + 1}/26 от 18.02.2026.\t180 000,00` })),
] };
describe("atomic prepared response source-first integration", () => {
  it("creates proven unsaved row candidates even when the model omits all contracts, not on unrelated or hidden sources", () => {
    const request = { revision: 1, raw: '{"items":[]}', sources: [source], destinations: ["contracts"] };
    const prepared = runResponsePreparation(request); expect(prepared.prepared!.items).toHaveLength(5); expect(validResponsePreparationReply(prepared, 1)).toBe(true);
    expect(runResponsePreparation({ ...request, destinations: ["proposals"] })).toEqual({ revision: 1, empty: true });
    expect(runResponsePreparation({ ...request, sources: [{ ...source, fragments: [] }] })).toEqual({ revision: 1, empty: true });
    expect(runResponsePreparation({ ...request, sources: [{ ...source, fragments: source.fragments!.map((fragment) => ({ ...fragment, sheetState: "hidden" })) }] })).toEqual({ revision: 1, empty: true });
    expect(request.raw).toBe('{"items":[]}');
  });
  it("preserves raw, creates missing five-table-row candidates and validates the extended receipt protocol", () => {
    const request = { revision: 1, raw: JSON.stringify({ items: [{ destination: "contracts", title: "Опыт QA", fields: { number: "QA-1/26" }, sourceIds: [source.id] }] }), sources: [source], destinations: ["contracts"] }, before = structuredClone(request);
    const reply = runResponsePreparation(request); expect(reply.failed).toBeUndefined(); expect(validResponsePreparationReply(reply, 1)).toBe(true);
    expect(reply.prepared!.items).toHaveLength(5); expect(reply.prepared!.items.every((item) => item.fields.amount === 180000 && item.fields.date === "2026-02-18")).toBe(true);
    expect(reply.prepared!.sourcePreparation!.changes.filter((entry) => entry.kind === "created")).toHaveLength(4); expect(request).toEqual(before);
    for (const mutate of [
      (value: NonNullable<typeof reply.prepared>) => { value.sourcePreparation!.changes[0].itemId = "foreign"; },
      (value: NonNullable<typeof reply.prepared>) => { value.sourcePreparation!.changes[0].field = "writeDatabase"; },
      (value: NonNullable<typeof reply.prepared>) => { value.sourcePreparation!.changes[0].requiresReview = false as true; },
      (value: NonNullable<typeof reply.prepared>) => { Object.assign(value.sourcePreparation!.changes[0], { sourceId: "foreign" }); },
    ]) { const value = structuredClone(reply.prepared!); mutate(value); expect(validResponsePreparationReply({ revision: 1, prepared: value }, 1)).toBe(false); }
  });
  it("collapses exact duplicate model requirements before all-or-nothing source supplementation", () => {
    const requirements = Array.from({ length: 100 }, () => "Нужен аудит QA"), text = "Количество серверов: 10 шт.";
    const reply = runResponsePreparation({ revision: 1, raw: JSON.stringify({ items: [{ destination: "procurement", title: "QA", fields: { requirements }, sourceIds: [source.id] }] }), sources: [{ ...source, text, fragments: [{ id: "paragraph-1", locator: "Абзац 1", text }] }], destinations: ["procurement"] });
    expect(reply.failed).toBeUndefined(); expect(reply.prepared!.items[0].fields.requirements).toEqual(["Нужен аудит QA", text]);
    expect(reply.prepared!.sourcePreparation!.changes[0].kind).toBe("deduplicated"); expect(validResponsePreparationReply(reply, 1)).toBe(true);
  });
});
