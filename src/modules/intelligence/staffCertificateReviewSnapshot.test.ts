import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

describe("certificate metadata participates in manual review identity", () => {
  it("does not reuse a review decision after source-row metadata changes while names stay the same", () => {
    const sources: IntelligenceSource[] = [{ id: "source", name: "QA", text: "ФИО: Иванов Иван Иванович\nСертификаты: Платформа", coverage: { complete: false, requiresOcr: false } }];
    const item: IntelligenceItem = { id: "staff", title: "Иванов Иван Иванович", destination: "staff", fields: { fullName: "Иванов Иван Иванович", certificates: ["Платформа"] }, sourceIds: ["source"], selectedFields: ["fullName", "certificates"], staffDocuments: [{ id: "doc", ownerFullName: "Иванов Иван Иванович", category: "certificate", name: "Платформа", seriesNumber: "QA-1", examDate: "2025-01-01", reportedValidity: "Да", sourceId: "source", fragmentId: "row-2", headerFragmentId: "row-1", quote: "Строка QA", headerQuote: "Заголовок QA" }] };
    const before = auditIntelligenceResult([item], sources), reviewed = getBlockingEvidenceFindings(before, item).map((entry) => entry.id);
    expect(reviewed.length).toBeGreaterThan(0);
    expect(getBlockingEvidenceFindings(before, item, reviewed)).toEqual([]);
    const changed = structuredClone(item); changed.staffDocuments![0].seriesNumber = "QA-2";
    const after = auditIntelligenceResult([changed], sources);
    expect(getBlockingEvidenceFindings(after, changed, reviewed).length).toBeGreaterThan(0);
    expect(item.staffDocuments![0].seriesNumber).toBe("QA-1");
  });
});
