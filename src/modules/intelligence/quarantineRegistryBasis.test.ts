import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import { quarantineConflictingFields } from "./quarantineConflictingFields";
import { extractStaffCertificateFacts } from "./sourceStaffCertificates";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const person = "Бетов Борис Борисович", other = "Гаммов Григорий Григорьевич";
const header = "Контактное лицо\tСертификат\tДействителен\tДата сдачи\tНомер сертификата";
const row = (number: number, text: string, extra: Partial<IntelligenceFragment> = {}): IntelligenceFragment => ({ id: `sheet-1-row-${number}`, locator: `Лист QA, A${number}:E${number}`, sheetId: "1", sheetState: "visible", text, ...extra });
const input = (): IntelligenceSource => ({ id: "registry", name: "Синтетический реестр QA", text: "Не восстанавливать удалённый агрегат", fragments: [row(1, header), row(2, `${person}\tПлатформа QA\tДа\t01.03.2025\tQA-1`)] });
const card = (extra: Partial<IntelligenceItem> = {}): IntelligenceItem => ({ id: "staff-qa", title: "Специалист QA", destination: "staff", fields: { fullName: person, basis: "Трудовой договор" }, selectedFields: ["fullName", "basis"], sourceIds: ["registry"], evidence: [], ...extra });

describe("M02 unsupported employment basis in an explicit certificate registry", () => {
  it("deselects only an unverified basis with fresh selected identity, preserving raw values/claims and giving an honest review notice", () => {
    const source = input(), item = card(), before = structuredClone({ item, source });
    const audit = auditIntelligenceResult([item], [source]);
    expect(audit.fields.find((entry) => entry.field === "fullName")?.status).toBe("confirmed");
    expect(audit.fields.find((entry) => entry.field === "basis")?.status).toBe("unverified");
    const result = quarantineConflictingFields([item], [source]);
    expect(result.items[0].selectedFields).toEqual(["fullName"]); expect(result.items[0].fields).toBe(item.fields); expect(result.items[0].evidence).toBe(item.evidence);
    expect(result.changes).toEqual([expect.objectContaining({ itemId: item.id, field: "basis", kind: "quarantined", previousValue: "Трудовой договор", requiresReview: true, sourceId: source.id, fragmentId: "sheet-1-row-2", quote: source.fragments![1].text })]);
    expect(result.skipped).toEqual([expect.objectContaining({ itemId: item.id, field: "basis", reason: "staff-basis-unverified", requiresReview: true, message: expect.stringContaining("не подтверждено") })]);
    expect(result.skipped[0].message).toContain("не подтверждает трудовые отношения");
    expect(result.items[0]).not.toHaveProperty("reviewedFindingIds"); expect({ item, source }).toEqual(before);
    expect(quarantineConflictingFields(result.items, [source]).changes).toEqual([]);
  });

  it("keeps the original basis visibly unverified and blocking after explicit manual reselection", () => {
    const source = input(), result = quarantineConflictingFields([card()], [source]), item = { ...result.items[0], selectedFields: ["fullName", "basis"] };
    const audit = auditIntelligenceResult([item], [source]);
    expect(audit.fields.find((entry) => entry.field === "basis")?.status).toBe("unverified");
    expect(getBlockingEvidenceFindings(audit, item).some((entry) => entry.field === "basis")).toBe(true);
    expect(item.fields.basis).toBe("Трудовой договор");
  });

  it("does not change basisOther/basisNumber or the general policy for unrelated unverified staff fields", () => {
    const item = card({ fields: { fullName: person, basis: "Трудовой договор", basisOther: "Неизвестное дополнение QA", basisNumber: "UNKNOWN-2026", certificates: ["Неизвестный сертификат"], phone: "+7 900 888 1122", experienceNotes: "Неизвестный проект QA" }, selectedFields: ["fullName", "basis", "basisOther", "basisNumber", "certificates", "phone", "experienceNotes"] });
    const result = quarantineConflictingFields([item], [input()]);
    expect(result.items[0].selectedFields).toEqual(item.selectedFields.filter((field) => field !== "basis"));
    expect(result.changes.map((change) => change.field)).toEqual(["basis"]); expect(result.items[0].fields).toBe(item.fields);
  });

  it.each(["ГПХ", "ИП", "Трудовой договор"])("retains a genuinely owned explicit %s basis", (basis) => {
    const source = input(); source.fragments!.unshift({ id: "person-basis", locator: "Основание", text: `ФИО: ${person}\nОснование сотрудничества: ${basis}` });
    const item = card({ fields: { fullName: person, basis } }), result = quarantineConflictingFields([item], [source]);
    expect(auditIntelligenceResult([item], [source]).fields.find((field) => field.field === "basis")?.status).toBe("confirmed");
    expect(result.items).toEqual([item]); expect(result.changes).toEqual([]); expect(result.skipped).toEqual([]);
  });

  it("keeps the original literal-conflict path rather than labelling a foreign actual basis as merely absent", () => {
    const source = input(); source.fragments!.push({ id: "foreign-basis", locator: "Другая карточка", text: `ФИО: ${other}\nОснование сотрудничества: Трудовой договор` });
    const item = card(), result = quarantineConflictingFields([item], [source]);
    expect(auditIntelligenceResult([item], [source]).fields.find((field) => field.field === "basis")?.status).toBe("conflict");
    expect(result.items[0].selectedFields).not.toContain("basis"); expect(result.changes[0].fragmentId).toBe("foreign-basis");
    expect(result.skipped.some((skip) => skip.reason === "staff-basis-unverified")).toBe(false);
  });

  it.each(["missing-header", "hidden-header", "hidden-row", "excluded", "aggregate-only", "wrong-owner", "owner-not-selected", "unknown-identity", "uncited", "metadata-only"])("does not use %s as fresh registry identity", (variant) => {
    const source = input(), item = card();
    if (variant === "metadata-only") { item.staffDocuments = extractStaffCertificateFacts([source]).documents; source.fragments = [{ id: "name", locator: "ФИО", text: person }]; }
    if (variant === "missing-header") source.fragments!.shift();
    if (variant === "hidden-header") { source.fragments![0].sheetState = "hidden"; source.fragments![0].includedByUser = true; }
    if (variant === "hidden-row") { source.fragments![1].sheetState = "hidden"; source.fragments![1].includedByUser = true; }
    if (variant === "excluded") { source.text = source.fragments!.map((fragment) => fragment.text).join("\n"); source.fragments = []; }
    if (variant === "aggregate-only") { source.text = source.fragments!.map((fragment) => fragment.text).join("\n"); delete source.fragments; }
    if (variant === "wrong-owner") { source.fragments![1].text = source.fragments![1].text.replace(person, other); source.fragments!.push({ id: "name", locator: "ФИО", text: person }); }
    if (variant === "owner-not-selected") item.selectedFields = ["basis"];
    if (variant === "unknown-identity") item.fields.fullName = "Несуществующий Человек QA";
    if (variant === "uncited") item.sourceIds = ["other-source"];
    const before = structuredClone({ source, item }), result = quarantineConflictingFields([item], [source]);
    expect(result.items).toEqual([item]); expect(result.changes).toEqual([]); expect(result.skipped.some((skip) => skip.reason === "staff-basis-unverified")).toBe(false);
    expect({ source, item }).toEqual(before);
  });

  it.each(["Не указано", "Неизвестно", ""])("does not apply this unverified-only rule to the placeholder/empty basis %s", (basis) => {
    const item = card({ fields: { fullName: person, basis } });
    expect(quarantineConflictingFields([item], [input()]).changes).toEqual([]);
  });

  it("retains incomplete-source warnings without treating a visible identity row as complete extraction", () => {
    const source = input(); source.warnings = ["Не все листы прочитаны"]; source.coverage = { complete: false, requiresOcr: false };
    const before = structuredClone(source), result = quarantineConflictingFields([card()], [source]);
    expect(result.items[0].selectedFields).toEqual(["fullName"]); expect(source).toEqual(before);
    expect(auditIntelligenceResult(result.items, [source]).findings.some((finding) => finding.code === "incomplete-source-coverage" && finding.severity === "blocking")).toBe(true);
  });

  it("rolls back the whole helper, including earlier literal conflicts, when fresh registry extraction reaches its limit", () => {
    const source = input(); source.fragments = [source.fragments![0], ...Array.from({ length: 101 }, (_, index) => row(index + 2, `${person}\tQA-${index}\tДа\t01.03.2025\tN-${index}`))];
    const staff = card(), procurement: IntelligenceItem = { id: "other-card", destination: "procurement", title: "QA", fields: { licenses: ["Декларация соответствия."] }, selectedFields: ["licenses"], sourceIds: ["other-source"] };
    const otherSource: IntelligenceSource = { id: "other-source", name: "QA", text: "Декларация соответствия." }, items = [procurement, staff], sources = [source, otherSource], before = structuredClone({ items, sources });
    const result = quarantineConflictingFields(items, sources);
    expect(result.items).toEqual(items); expect(result.changes).toEqual([]); expect(result.limited).toBe(true);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: "quarantine-registry-limit", requiresReview: true })]);
    expect({ items, sources }).toEqual(before);
  });
});
