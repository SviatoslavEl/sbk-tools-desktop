import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const group = "Участник представляет один из вариантов:\n1. Копия паспорта.\n2. Выписка из ЕГРЮЛ.";
const source = (text: string, extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "source-a", name: "Группировка документов QA", text, ...extra });
const card = (requirements: string[]): IntelligenceItem => ({ id: "purchase-a", title: "Документы участника QA", destination: "procurement", fields: { requirements }, selectedFields: ["requirements"], sourceIds: ["source-a"] });
const status = (report: ReturnType<typeof auditIntelligenceResult>) => report.fields.find((entry) => entry.field === "requirements");

describe("same-fragment grouped requirement literals", () => {
  it("confirms the complete one-of quote as literal presence without changing its OR semantics", () => {
    const item = card([group]), input = source(group, { fragments: [{ id: "application", locator: "Абзац 1", text: group }] }), before = structuredClone({ item, input });
    const report = auditIntelligenceResult([item], [input]);
    expect(status(report)?.status).toBe("confirmed"); expect(status(report)?.evidence).toContainEqual({ sourceId: input.id, sourceName: input.name, fragmentId: "application", locator: "Абзац 1", quote: group });
    expect(report.findings.some((entry) => entry.code === "incomplete-grouped-condition")).toBe(false);
    expect({ item, input }).toEqual(before); expect(status(report)?.message).toContain("применимость");
  });

  it("also confirms a full nonresident scope heading and its documents", () => {
    const text = "Только для нерезидентов:\n1. Копия документа о регистрации.\n2. Копия документа о полномочиях представителя.";
    const report = auditIntelligenceResult([card([text])], [source(text)]);
    expect(status(report)?.status).toBe("confirmed"); expect(report.findings.some((entry) => entry.code === "incomplete-grouped-condition")).toBe(false);
  });

  it.each([group, "Только для нерезидентов:\n1. Копия документа о регистрации."])("does not greenlight children after dropping the explicit scope heading: %s", (text) => {
    const item = card(text.split("\n").slice(1)), report = auditIntelligenceResult([item], [source(text)]);
    expect(getBlockingEvidenceFindings(report, item).some((entry) => entry.code === "incomplete-grouped-condition")).toBe(true);
  });

  it("never constructs a literal group from adjacent fragments", () => {
    const item = card([group]), input = source(group, { fragments: [{ id: "heading", locator: "Абзац 1", text: group.split("\n")[0] }, { id: "children", locator: "Абзац 2", text: group.split("\n").slice(1).join("\n") }] });
    const report = auditIntelligenceResult([item], [input]);
    expect(status(report)?.status).not.toBe("confirmed"); expect(getBlockingEvidenceFindings(report, item).length).toBeGreaterThan(0);
  });

  it("does not confirm modified digits in an otherwise copied group", () => {
    const text = "Участник представляет один из вариантов:\n1. Сертификат OSCP — не менее 3 специалистов.\n2. Сертификат OSEP — не менее 2 специалистов.";
    const item = card([text.replace("3 специалистов", "1 специалиста")]), report = auditIntelligenceResult([item], [source(text)]);
    expect(status(report)?.status).not.toBe("confirmed"); expect(getBlockingEvidenceFindings(report, item).some((entry) => entry.code === "incomplete-grouped-condition")).toBe(true);
  });

  it("does not borrow an uncited group or restore discarded aggregate text", () => {
    const item = card([group]), hidden = source(group, { fragments: [] }), foreign = source(group, { id: "foreign" });
    const report = auditIntelligenceResult([item], [hidden, foreign]); expect(status(report)?.status).not.toBe("confirmed"); expect(status(report)?.evidence).toEqual([]);
  });

  it("does not apply procurement grouping to a staff card", () => {
    const item = { ...card(["1. Копия паспорта."]), destination: "staff" as const }, report = auditIntelligenceResult([item], [source(group)]);
    expect(report.findings.some((entry) => entry.code === "incomplete-grouped-condition")).toBe(false);
  });
});
