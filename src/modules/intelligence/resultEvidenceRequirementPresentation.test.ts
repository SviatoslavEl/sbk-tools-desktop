import { describe, expect, it } from "vitest";
import { auditIntelligenceResult } from "./resultEvidence";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";
const body = "Количество оборудования\tУчастник должен поставить 10 серверов\tДокумент о соответствии";
const source = (rows: string[]): IntelligenceSource => ({ id: "source", name: "Таблица QA", text: "Не использовать агрегат", fragments: rows.map((text, index) => ({ id: `table-row-${index + 1}`, locator: `Таблица, строка ${index + 1}`, text })) });
const card = (requirements: string[]): IntelligenceItem => ({ id: "item", title: "Поставка QA", destination: "procurement", fields: { requirements }, selectedFields: ["requirements"], sourceIds: ["source"], evidence: [] });
const missing = (requirements: string[], rows: string[]) => auditIntelligenceResult([card(requirements)], [source(rows)]).findings.filter((finding) => /^missing-(?:document|quantity)$/u.test(finding.code));
describe("coverage shares exact full-body table presentation equivalence", () => {
  it("does not demand the omitted presentation ordinal when the whole body is present", () => { expect(missing([body], [`1\t${body}`])).toEqual([]); });
  it.each([body.replace("10", "9"), body.split("\t").slice(0, 2).join("\t"), "Количество оборудования"])("does not approve changed numbers, omitted proof or a heading: %s", (value) => { expect(missing([value], [`1\t${body}`]).length).toBeGreaterThan(0); });
  it("does not merge two different explicit component identifiers through one bare body", () => { expect(missing([body], [`1.1\t${body}`, `1.2\t${body}`]).length).toBeGreaterThan(0); });
  it("does not strip a choice or applicability heading to claim full coverage", () => { expect(missing([body], [`1\tТолько для нерезидентов: ${body}`]).length).toBeGreaterThan(0); });
});
