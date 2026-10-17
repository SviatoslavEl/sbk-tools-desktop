import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const source = (text: string): IntelligenceSource => ({ id: "source-a", name: "Синтетическое КП QA", text });
const card = (lines: string[], descriptions = lines): IntelligenceItem => ({ id: "proposal-a", title: "Аудит процессов QA", destination: "proposals", fields: { lines, lineDescriptions: descriptions }, selectedFields: ["lines", "lineDescriptions"], sourceIds: ["source-a"] });
const findings = (item: IntelligenceItem, input: IntelligenceSource) => auditIntelligenceResult([item], [input]).findings.filter((entry) => entry.code === "financial-summary-position");

describe("financial summaries are not commercial proposal service positions", () => {
  it("requires a decision for the header/net/VAT/gross positions without rewriting them", () => {
    const lines = ["Показатель\tЗначение", "Стоимость услуг без НДС", "НДС 22%", "Стоимость услуг с НДС"], item = card(lines), input = source(lines.join("\n")), before = structuredClone({ item, input });
    const report = auditIntelligenceResult([item], [input]), issue = report.findings.find((entry) => entry.code === "financial-summary-position");
    expect(issue).toMatchObject({ field: "lines", severity: "blocking" }); expect(issue?.message).toContain("редактор");
    expect(issue?.evidence.length).toBeGreaterThan(0); expect(getBlockingEvidenceFindings(report, item)).toContainEqual(issue);
    expect({ item, input }).toEqual(before);
  });

  it.each(["Итого без НДС", "Всего с НДС", "НДС", "НДС 20 %", "Показатель / Значение", "Итоговая стоимость"])("flags an exact financial-only label: %s", (label) => {
    expect(findings(card([label]), source(label))).toHaveLength(1);
  });

  it.each(["Услуги по расчёту НДС", "Консультация по НДС", "Аудит ИТ-архитектуры", "Показатель качества услуги"])("does not mistake a meaningful service name for a financial total: %s", (label) => {
    const description = "Сервис включает подготовку отчёта. Стоимость с НДС 22% указана в итогах.";
    expect(findings(card([label], [description]), source(`${label}\n${description}`))).toEqual([]);
  });

  it("does not audit lines excluded from transfer or another destination", () => {
    const item = card(["НДС 22%"]); item.selectedFields = ["lineDescriptions"];
    expect(findings(item, source("НДС 22%"))).toEqual([]);
    expect(findings({ ...card(["НДС 22%"]), destination: "procurement" }, source("НДС 22%"))).toEqual([]);
  });

  it("keeps provenance scoped and invalidates an ACK after editing a label", () => {
    const item = card(["Итого без НДС"]), input = source("Итого без НДС"), report = auditIntelligenceResult([item], [input]), issue = report.findings.find((entry) => entry.code === "financial-summary-position")!;
    expect(issue).toBeDefined(); expect(issue.evidence.every((entry) => entry.sourceId === "source-a" && input.text.includes(entry.quote))).toBe(true);
    expect(getBlockingEvidenceFindings(report, item, [issue.id]).some((entry) => entry.code === issue.code)).toBe(false);
    const changed = card(["Всего с НДС"]), next = auditIntelligenceResult([changed], [source("Всего с НДС")]);
    expect(getBlockingEvidenceFindings(next, changed, [issue.id]).some((entry) => entry.code === issue.code)).toBe(true);
  });
});
