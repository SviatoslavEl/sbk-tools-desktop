import { describe, expect, it } from "vitest";
import { buildIntelligenceHandoff } from "./workbenchModel";
import { extractStaffCertificateFacts } from "./sourceStaffCertificates";
import { staffAssignments, emptyStaff } from "../staff/types";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource, IntelligenceStaffDocument } from "./workbenchTypes";

const owner = "Альфова Анна Алексеевна";
const header = "Контактное лицо\tСертификат\tДействителен\tДата сдачи\tНомер сертификата";
const row = (index: number, text: string): IntelligenceFragment => ({ id: `sheet-1-row-${index}`, locator: `Лист QA, A${index}:E${index}`, sheetId: "1", sheetState: "visible", text });
const source = (): IntelligenceSource => ({ id: "certificate-source-qa", name: "Реестр QA", text: "Не восстанавливать исключённое", fragments: [row(1, header), row(2, `${owner}\tСертификат QA\tДа\t29.02.2024\tQA-1`), row(3, `${owner}\tСертификат QA\tНет\t03.07.2025\tQA-2`)] });
function item(input: IntelligenceSource): IntelligenceItem {
  return { id: "card-qa", title: owner, destination: "staff", sourceIds: [input.id], fields: { fullName: owner, certificates: ["Сертификат QA", "Старый сертификат без метаданных"] }, selectedFields: ["fullName", "certificates"], staffDocuments: extractStaffCertificateFacts([input]).documents, evidence: [] };
}
function handoff(current: IntelligenceItem, sources: IntelligenceSource[]) {
  const result = buildIntelligenceHandoff(current, sources, "/synthetic/qa-workspace");
  if (result.destination !== "staff") throw new Error("Wrong receiving destination");
  return result.data;
}
const freeze = <T,>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

describe("fresh certificate metadata at the unsaved staff handoff", () => {
  it("retains two same-name certificates with their own numbers/exam/status and no duplicate name-only document", () => {
    const input = source(), current = item(input), before = structuredClone({ input, current }); freeze(input); freeze(current);
    expect(current.staffDocuments).toHaveLength(2);
    const data = handoff(current, [input]);
    expect(data.documents).toHaveLength(3);
    expect(data.documents[0]).toMatchObject({ category: "certificate", name: "Сертификат QA", seriesNumber: "QA-1", examDate: "2024-02-29", reportedValidity: "Да", issuedDate: "", expiresDate: "", unlimited: false });
    expect(data.documents[1]).toMatchObject({ category: "certificate", name: "Сертификат QA", seriesNumber: "QA-2", examDate: "2025-07-03", reportedValidity: "Нет", issuedDate: "", expiresDate: "", unlimited: false });
    expect(data.documents[2]).toMatchObject({ name: "Старый сертификат без метаданных", seriesNumber: "", examDate: "", reportedValidity: "" });
    expect(new Set(data.documents.map((document) => document.id)).size).toBe(3);
    expect({ input, current }).toEqual(before); expect(data.disclosureAllowed).toBe(false);
    expect(data).not.toHaveProperty("staffDocuments"); expect(data).not.toHaveProperty("reviewedFindingIds");
  });

  it.each(["id", "ownerFullName", "name", "seriesNumber", "examDate", "reportedValidity", "sourceId", "fragmentId", "headerFragmentId", "quote", "headerQuote", "extra-key", "duplicate-document"])("rejects stale/foreign %s instead of silently dropping the selected metadata", (field) => {
    const input = source(), current = item(input), candidate = current.staffDocuments![0];
    if (field === "duplicate-document") current.staffDocuments!.push(structuredClone(candidate));
    else if (field === "extra-key") (candidate as unknown as Record<string, unknown>).unlimited = true;
    else candidate[field as keyof IntelligenceStaffDocument] = "Changed QA" as never;
    expect(() => handoff(current, [input])).toThrow(/текущими выбранными материалами|владельцем карточки/u);
  });

  it.each(["excluded", "hidden", "veryHidden", "changed-row", "changed-header", "duplicate-source", "duplicate-fragment", "foreign-card", "owner-not-selected", "different-owner"])("does not reuse metadata after %s changes the current selected proof", (variant) => {
    const input = source(), current = item(input), sources = [input];
    if (variant === "excluded") { input.text = input.fragments!.map((fragment) => fragment.text).join("\n"); input.fragments = []; }
    if (variant === "hidden" || variant === "veryHidden") { input.fragments![1].sheetState = variant; input.fragments![1].includedByUser = true; }
    if (variant === "changed-row") input.fragments![1].text = input.fragments![1].text.replace("QA-1", "QA-99");
    if (variant === "changed-header") input.fragments![0].text = header.replace("Дата сдачи", "Дата выдачи");
    if (variant === "duplicate-source") sources.push(structuredClone(input));
    if (variant === "duplicate-fragment") input.fragments!.push(structuredClone(input.fragments![1]));
    if (variant === "foreign-card") current.sourceIds = ["foreign"];
    if (variant === "owner-not-selected") current.selectedFields = ["certificates"];
    if (variant === "different-owner") current.fields.fullName = "Бетов Борис Борисович";
    expect(() => handoff(current, sources)).toThrow(/Сведения о сертификатах|Источник карточки/u);
  });

  it("transfers only selected certificate names and allows a deliberately removed name to remain untransferred", () => {
    const input = source(), current = item(input); current.fields.certificates = ["Старый сертификат без метаданных"];
    expect(handoff(current, [input]).documents.map((document) => document.name)).toEqual(["Старый сертификат без метаданных"]);
    current.selectedFields = ["fullName"];
    expect(handoff(current, [input]).documents).toEqual([]);
  });

  it("rejects incomplete metadata instead of reducing two same-name numbered certificates to one", () => {
    const input = source(), current = item(input); current.staffDocuments!.pop();
    expect(() => handoff(current, [input])).toThrow(/Состав сертификатов изменился/u);
    delete current.staffDocuments;
    expect(handoff(current, [input]).documents).toHaveLength(2);
  });

  it("keeps legacy name-only certificates and education without inventing normalized metadata", () => {
    const input = source(), current = item(input); delete current.staffDocuments;
    current.fields.education = ["Диплом QA"]; current.selectedFields.push("education");
    const data = handoff(current, [input]);
    expect(data.documents).toHaveLength(3);
    expect(data.documents[0]).toMatchObject({ name: "Сертификат QA", seriesNumber: "", examDate: "", reportedValidity: "", issuedDate: "", unlimited: false });
    expect(data.documents[2]).toMatchObject({ category: "education", name: "Диплом QA" });
  });

  it("seeds an explicit unknown employment basis only for AI handoff and keeps selected genuine basis", () => {
    const input = source(), current = item(input); current.fields.basis = "Трудовой договор";
    const unknown = handoff(current, [input]); expect(unknown.basis).toBe("Не указано"); expect(staffAssignments(unknown)[0].engagementType).toBe("Не указано");
    current.fields.basis = "ГПХ"; current.selectedFields.push("basis");
    expect(handoff(current, [input]).basis).toBe("ГПХ"); expect(emptyStaff().basis).toBe("Трудовой договор");
  });
});
