import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const primary = "QA-18/26", full = `${primary} (8100-2026-00037)`;
const row = (number: number, text: string): IntelligenceFragment => ({ id: `table-row-${number}`, locator: `Таблица, строка ${number}`, text });
const table = (): IntelligenceFragment[] => [row(1, "№ п/п\tПериод исполнения\tЗаказчик\tПредмет договора\tСумма договора"),
  ...[full, "QA-19/26", "QA-20/26", "QA-21/26", "QA-22/26"].map((number, index) => row(index + 2, `${index + 1}.\tфевраль 2026\tЗаказчик QA\tУслуга QA. Договор № ${number} от 18.02.2026.\t100 000,00`)),
];
const source = (fragments = table(), extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "contract-source", name: "Синтетический реестр QA", text: "Агрегат не заменяет выбранные фрагменты", fragments, ...extra });
const card = (number: string, quote?: string): IntelligenceItem => ({ id: "contract-card", title: "Контроль номера QA", destination: "contracts", fields: { number }, selectedFields: ["number"], sourceIds: ["contract-source"], evidence: quote ? [{ field: "number", sourceId: "contract-source", fragmentId: "table-row-2", quote }] : [] });
const numberState = (report: ReturnType<typeof auditIntelligenceResult>) => report.fields.find((field) => field.field === "number");
const numberBlockers = (report: ReturnType<typeof auditIntelligenceResult>, item: IntelligenceItem) => getBlockingEvidenceFindings(report, item).filter((finding) => finding.field === "number");

describe("R03 complete contextual compound contract-number audit", () => {
  it.each([full, primary])("confirms the exact contextual %s but preserves all four genuinely missing contracts", (number) => {
    const input = source(), quote = input.fragments![1].text, item = card(number, quote), before = structuredClone({ input, item });
    const report = auditIntelligenceResult([item], [input]);
    expect(numberState(report)?.status).toBe("confirmed"); expect(numberBlockers(report, item)).toEqual([]);
    expect(report.findings.filter((finding) => finding.code === "missing-contract-card")).toHaveLength(4);
    expect(numberState(report)?.evidence.some((proof) => proof.fragmentId === "table-row-2" && proof.quote === quote)).toBe(true);
    expect({ input, item }).toEqual(before);
  });

  it.each(["QA-18/26 (8100-2026-00038)", "QA-18", "8100-2026-00037", "QA-18/26 (8100-2026-00037)-X"])("does not certify a wrong registry, prefix or identifier substituted for the number: %s", (number) => {
    const input = source(), item = card(number, input.fragments![1].text), report = auditIntelligenceResult([item], [input]);
    expect(numberState(report)?.status).not.toBe("confirmed"); expect(numberBlockers(report, item).length).toBeGreaterThan(0);
  });

  it.each(["Доверенность", "Приложение", "Федеральный закон", "Спецификация"])("does not take a %s identifier from a nearby contract reference", (kind) => {
    const text = `${kind} № ${full}. Договор поставки № ____.`, item = card(full, text), report = auditIntelligenceResult([item], [source([row(2, text)])]);
    expect(numberState(report)?.status).not.toBe("confirmed"); expect(numberBlockers(report, item).length).toBeGreaterThan(0);
  });

  it.each(["доверенность", "приложение", "федеральный закон", "спецификация"])("does not borrow a %s number through the contract-label gap", (kind) => {
    const text = `Договор оказания услуг, ${kind} № ${full}.`, item = card(full, text), report = auditIntelligenceResult([item], [source([row(2, text)])]);
    expect(numberState(report)?.status).not.toBe("confirmed"); expect(numberBlockers(report, item).length).toBeGreaterThan(0);
  });

  it.each(["____", "QA___", "Договор", "TBD", "QA (___)"])("does not certify an unfilled number: %s", (number) => {
    const text = `Договор № ${number}`, item = card(number, text), report = auditIntelligenceResult([item], [source([row(2, text)])]);
    expect(numberState(report)?.status).not.toBe("confirmed"); expect(numberBlockers(report, item).length).toBeGreaterThan(0);
  });

  it.each(["ИТ/А", "ABC", "б/н"])("retains an explicit real non-digit identifier: %s", (number) => {
    const text = `Договор № ${number} от 18.02.2026.`, item = card(number, text), report = auditIntelligenceResult([item], [source([row(2, text)])]);
    expect(numberState(report)?.status).toBe("confirmed"); expect(numberBlockers(report, item)).toEqual([]);
  });

  it.each(["X", "-X", "/2", "_v2", ".X", "(2)", " (редакция 3)"])("does not confirm a truncated compound prefix before continuation %s", (suffix) => {
    const number = "QA-18/26 (261)", text = `Договор № ${number}${suffix} от 18.02.2026.`, item = card(number, text), report = auditIntelligenceResult([item], [source([row(2, text)])]);
    expect(numberState(report)?.status).not.toBe("confirmed"); expect(numberBlockers(report, item).length).toBeGreaterThan(0);
  });

  it.each([full, primary])("does not index a registry full/primary alias when the actual compound continues: %s", (number) => {
    const text = `Договор № ${full}-X от 18.02.2026.`, item = card(number, text), report = auditIntelligenceResult([item], [source([row(2, text)])]);
    expect(numberState(report)?.status).not.toBe("confirmed"); expect(numberBlockers(report, item).length).toBeGreaterThan(0);
  });

  it("does not reconstruct one full number across separate source rows", () => {
    const text = `Договор № ${primary}\n(8100-2026-00037) от 18.02.2026.`, item = card(full, text), report = auditIntelligenceResult([item], [source([row(2, text)])]);
    expect(numberState(report)?.status).not.toBe("confirmed"); expect(numberBlockers(report, item).length).toBeGreaterThan(0);
  });

  it("does not borrow an exact full number from unselected/uncited fragments or stale evidence UUIDs", () => {
    const original = source(), empty = { ...original, fragments: [] }, item = card(full, original.fragments![1].text);
    item.evidence![0].sourceId = "stale-source";
    const report = auditIntelligenceResult([item], [empty, source(undefined, { id: "uncited" })]);
    expect(numberState(report)?.status).not.toBe("confirmed"); expect(numberBlockers(report, item).length).toBeGreaterThan(0);
    expect(report.findings.some((finding) => finding.code === "evidence-source-not-cited")).toBe(true);
  });

  it("keeps repeated primary/date completeness separate from literal identifier presence", () => {
    const input = source([table()[0], row(2, `1.\tфевраль 2026\tЗаказчик QA\tДоговор № ${full} от 18.02.2026.\t100 000,00`), row(3, `2.\tфевраль 2025\tЗаказчик QA\tДоговор № ${primary} (8100-2025-00012) от 18.02.2025.\t90 000,00`)]);
    const item = card(primary, input.fragments![1].text), report = auditIntelligenceResult([item], [input]);
    expect(numberState(report)?.status).toBe("confirmed");
    expect(report.findings.filter((finding) => finding.code === "missing-contract-card")).toHaveLength(2);
    const dated = { ...item, fields: { number: primary, date: "2026-02-18" }, selectedFields: ["number", "date"] };
    const withDate = auditIntelligenceResult([dated], [input]);
    expect(withDate.findings.filter((finding) => finding.code === "missing-contract-card")).toHaveLength(1);
    expect(withDate.findings.find((finding) => finding.code === "missing-contract-card")?.evidence[0].fragmentId).toBe("table-row-3");
  });

  it("does not satisfy distinct same-primary/same-date registry rows through one short number", () => {
    const input = source([table()[0], row(2, `1.\tфевраль 2026\tЗаказчик QA\tДоговор № ${full} от 18.02.2026.\t100 000,00`), row(3, `2.\tфевраль 2026\tЗаказчик QA\tДоговор № ${primary} (8100-2026-00038) от 18.02.2026.\t90 000,00`)]);
    const item = { ...card(primary), fields: { number: primary, date: "2026-02-18" }, selectedFields: ["number", "date"] }, report = auditIntelligenceResult([item], [input]);
    expect(report.findings.filter((finding) => finding.code === "missing-contract-card")).toHaveLength(2);
  });
});
