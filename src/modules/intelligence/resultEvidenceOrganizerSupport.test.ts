import { describe, expect, it } from "vitest";
import { auditIntelligenceResult } from "./resultEvidence";
import { completeSourceTextFields } from "./sourceTextCompletion";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const source = (): IntelligenceSource => ({ id: "source", name: "Синтетический запрос QA", text: "Не восстанавливать агрегат", fragments: [
  { id: "table-row-1", locator: "Таблица, строка 1", text: "Запрос\tАудит для нужд АО «ГСК «Контроль QA»" },
  { id: "table-row-2", locator: "Таблица, строка 2", text: "Организатор\tГСК КОНТРОЛЬ QA (АКЦИОНЕРНОЕ ОБЩЕСТВО «Группа компаний Контроль QA»)" },
] });
const card = (): IntelligenceItem => ({ id: "card", destination: "procurement", title: "Аудит QA", sourceIds: ["source"], fields: {}, selectedFields: [], evidence: [] });
const unsupported = (item: IntelligenceItem, input: IntelligenceSource[]) => auditIntelligenceResult([item], input).findings.filter((entry) => entry.field === "customer" && entry.code === "evidence-does-not-support-value");

describe("customer role support remains scoped to the current literal request/organizer pair", () => {
  it("accepts the supporting beneficiary row only alongside the complete organizer-value claim", () => {
    const input = source(), prepared = completeSourceTextFields([card()], [input]).items[0], before = structuredClone({ input, prepared });
    expect(prepared.evidence!.filter((entry) => entry.field === "customer")).toHaveLength(2);
    expect(unsupported(prepared, [input])).toEqual([]);
    expect(auditIntelligenceResult([prepared], [input]).fields.find((entry) => entry.field === "customer")?.status).toBe("confirmed");
    expect({ input, prepared }).toEqual(before);
  });
  it.each(["missing-value-proof", "foreign-source", "changed-request", "wrong-value", "uncited-source", "duplicate-source"])("does not excuse %s", (variant) => {
    const input = source(), prepared = completeSourceTextFields([card()], [input]).items[0];
    if (variant === "missing-value-proof") prepared.evidence = prepared.evidence!.filter((claim) => claim.field !== "customer" || claim.fragmentId !== "table-row-2");
    if (variant === "foreign-source") prepared.evidence!.find((claim) => claim.field === "customer" && claim.fragmentId === "table-row-2")!.sourceId = "foreign";
    if (variant === "changed-request") input.fragments![0].text = "Запрос\tАудит для нужд АО «Другой QA»";
    if (variant === "wrong-value") prepared.fields.customer = "АО «Другой QA»";
    if (variant === "uncited-source") prepared.sourceIds = [];
    const report = auditIntelligenceResult([prepared], variant === "duplicate-source" ? [input, structuredClone(input)] : [input]);
    expect(report.findings.some((entry) => entry.severity === "blocking" && entry.field === "customer")).toBe(true);
  });
});
