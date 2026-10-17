import { describe, expect, it } from "vitest";
import { completeSourcePositions } from "./sourcePositionCompletion";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";
const components = (count: number, label: string) => Array.from({ length: count }, (_, index) => `- Компонент ${label} ${index + 1} — ${index + 1} шт;`).join("\n");
const block = (sku: string, label: string, count: number) => `SKU: ${sku}\nСервер ${label} в составе:\n${components(count, label)}`;
const source = (text = `${block("QA-100_A", "Альфа", 19)}\n${block("QA-200_B", "Бета", 13)}`): IntelligenceSource => ({ id: "sku-source", name: "Синтетические составы QA", text, fragments: [{ id: "page-1", locator: "Страница 1", text }] });
const card = (fields: IntelligenceItem["fields"] = {}, extra: Partial<IntelligenceItem> = {}): IntelligenceItem => ({ id: "sku-card", destination: "proposals", title: "Поставка QA", sourceIds: ["sku-source"], fields, selectedFields: Object.keys(fields), evidence: [], ...extra });

describe("automatic source-backed SKU completion never uses array order", () => {
  it("restores all 19/13 components by exact SKU even when model positions are reversed", () => {
    const input = source(), item = card({ lines: ["QA-200_B", "QA-100_A"], lineDescriptions: ["", ""] }), before = structuredClone({ input, item });
    const result = completeSourcePositions([item], [input]), prepared = result.items[0];
    expect(prepared.fields.lines).toEqual(["QA-200_B", "QA-100_A"]);
    expect((prepared.fields.lineDescriptions as string[]).map((entry) => entry.split("\n").filter((line) => line.startsWith("- ")).length)).toEqual([13, 19]);
    expect((prepared.fields.lineDescriptions as string[])[0]).toContain("Сервер Бета"); expect((prepared.fields.lineDescriptions as string[])[1]).toContain("Сервер Альфа");
    expect(result.changes.every((change) => change.requiresReview)).toBe(true); expect(result.changes.find((change) => change.field === "lineDescriptions")?.previousValue).toEqual(["", ""]);
    expect(getBlockingEvidenceFindings(auditIntelligenceResult(result.items, [input]), prepared)).toEqual([]); expect({ input, item }).toEqual(before);
  });
  it("creates missing source-proven SKU slots, not extra cards or shortened descriptions", () => {
    const result = completeSourcePositions([card({ title: "Поставка оборудования" })], [source()]);
    expect(result.items).toHaveLength(1); expect(result.items[0].fields.lines).toEqual(["QA-100_A", "QA-200_B"]); expect(result.items[0].fields.title).toBe("Поставка оборудования");
    expect(result.items[0].selectedFields).toEqual(["title", "lines", "lineDescriptions"]);
  });
  it("is idempotent and does not multiply claims or review receipts", () => {
    const input = source(), first = completeSourcePositions([card()], [input]), second = completeSourcePositions(first.items, [input]); expect(second.items).toEqual(first.items); expect(second.changes).toEqual([]);
  });
  it("keeps detached same-name compositions under manual mapping instead of order-pairing", () => {
    const text = `Артикул\n1 QA-100_A шт2\n2 QA-200_B шт2\nУсловия оплаты:100%\nСервер QA в составе:\n${components(19, "А")}\nСервер QA в составе:\n${components(13, "Б")}`;
    expect(completeSourcePositions([card({ lines: ["QA-100_A", "QA-200_B"], lineDescriptions: ["", ""] })], [source(text)]).changes).toEqual([]);
  });
  it.each(["duplicate-slots", "merged-slot", "invalid-format", "orphan-description"])("keeps the whole card unchanged for %s", (kind) => {
    const fields = kind === "duplicate-slots" ? { lines: ["QA-100_A", "QA-100_A"], lineDescriptions: ["", ""] } : kind === "merged-slot" ? { lines: ["QA-100_A QA-200_B"], lineDescriptions: [""] } : kind === "invalid-format" ? { lines: "Некорректный список" } : { lines: [], lineDescriptions: ["Без позиции"] };
    const item = card(fields as IntelligenceItem["fields"]), result = completeSourcePositions([item], [source()]); expect(result.items).toEqual([item]); expect(result.changes).toEqual([]); expect(result.skipped.length).toBeGreaterThan(0);
  });
  it.each(["multiple-cards", "multiple-lots", "hidden", "stale-source"])("does not infer ownership from %s", (kind) => {
    const input = source(), item = card(), items = [item];
    if (kind === "multiple-cards") items.push(card({}, { id: "second" }));
    if (kind === "multiple-lots") input.fragments![0].text = `Лот 1: Серверы\nЛот 2: Сети\n${input.text}`;
    if (kind === "hidden") { input.fragments![0].sheetState = "hidden"; input.fragments![0].includedByUser = true; }
    if (kind === "stale-source") item.sourceIds = ["old-uuid"];
    const result = completeSourcePositions(items, [input]); expect(result.items).toEqual(items); expect(result.changes).toEqual([]);
  });
  it("rolls back without partial compositions when inventory is too large", () => {
    const input = source(Array.from({ length: 101 }, (_, index) => block(`QA-${index}`, "QA", 1)).join("\n")), item = card(), result = completeSourcePositions([item], [input]); expect(result.items).toEqual([item]); expect(result.changes).toEqual([]); expect(result.limited).toBe(true);
  });
  it("does not manufacture a card for an empty model result", () => { expect(completeSourcePositions([], [source()]).items).toEqual([]); });
});
