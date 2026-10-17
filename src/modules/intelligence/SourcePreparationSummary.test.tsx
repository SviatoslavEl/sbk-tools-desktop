import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { SourcePreparationSummary } from "./SourcePreparationSummary";
import type { SourcePreparationReceipt } from "./responsePreparationWorker";
import type { IntelligenceItem } from "./workbenchTypes";
const item: IntelligenceItem = { id: "qa-card", destination: "contracts", title: "Договор QA", fields: { number: "QA-18" }, selectedFields: ["number"], sourceIds: ["qa-source"] };
const receipt = (): SourcePreparationReceipt => ({ changes: [{ itemId: item.id, field: "amount", kind: "replaced", previousValue: 0, value: 180000, sourceId: "qa-source", sourceName: "Опыт QA.docx", fragmentId: "table-row-2", locator: "Таблица, строка 2", quote: "1\tКлиент QA\tДоговор № QA-18\t180 000,00", requiresReview: true }], skipped: [], limited: false });
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("") : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "";
const render = (value: SourcePreparationReceipt | null, items = [item]) => SourcePreparationSummary({ receipt: value, items });
describe("visible source-first preparation history", () => {
  it("shows exact source proof and full displaced value without claiming completeness or writing records", () => {
    const value = receipt(), before = structuredClone(value), output = text(render(value));
    expect(output).toContain("Уточнено по источнику · Сумма договора, ₽"); expect(output).toContain("Опыт QA.docx · Таблица, строка 2");
    expect(output).toContain(value.changes[0].kind === "replaced" ? value.changes[0].quote : "");
    expect(output).toContain("Было в ответе модели0"); expect(output).toContain("После подготовки180000");
    expect(output).toContain("не подтверждение правильности или полноты"); expect(output).toContain("не сохранены в базе"); expect(value).toEqual(before);
  });
  it("keeps the quarantine warning visible and retains the excluded wrong value in history", () => {
    const value = receipt(); value.changes[0] = { ...value.changes[0], kind: "quarantined", previousValue: "Чужой номер", value: undefined } as typeof value.changes[0];
    const output = text(render(value)); expect(output).toContain("исключены из передачи: 1"); expect(output).toContain("Чужой номер"); expect(output).toContain("без отметок");
  });
  it("counts deduped requirements separately and never pretends it is a source quote", () => {
    const value: SourcePreparationReceipt = { changes: [{ itemId: item.id, field: "requirements", kind: "deduplicated", previousValue: ["A", "A", "A"], value: ["A"], requiresReview: true }], skipped: [], limited: false };
    const output = text(render(value, [{ ...item, destination: "procurement", fields: { requirements: ["A"] } }]));
    expect(output).toContain("Свёрнуто повторов требований: 2"); expect(output).toContain("Свёрнуты точные повторы"); expect(output).not.toContain("undefined");
  });
  it("hides removed-card history but retains genuine global skips and limit warning", () => {
    expect(render(receipt(), [{ ...item, id: "other" }])).toBeNull(); expect(render(null)).toBeNull(); expect(render(receipt(), [])).toBeNull();
    const value = receipt(); value.skipped.push({ reason: "limit", message: "Неоднозначная сумма", requiresReview: true }); value.limited = true;
    const output = text(render(value, [{ ...item, id: "other" }])); expect(output).toContain("Неоднозначная сумма"); expect(output).not.toContain("Опыт QA.docx"); expect(output).toContain("Полнота результата не подтверждена");
  });
});
