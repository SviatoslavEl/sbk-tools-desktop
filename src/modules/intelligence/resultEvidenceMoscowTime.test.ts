import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, extractIntelligenceDateFacts, getBlockingEvidenceFindings } from "./resultEvidence";
import { runResponsePreparation } from "./responsePreparationWorker";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const exact = "Окончание приема заявок: 18.11.2026 в 18:00 по московскому времени.";
const source = (text = exact): IntelligenceSource => ({ id: "qa-source", name: "Синтетическая закупка QA", text });
const card = (notes = exact): IntelligenceItem => ({ id: "qa-card", title: "Контрольная закупка QA", destination: "procurement", fields: { submissionDeadline: "2026-11-18", notes }, sourceIds: ["qa-source"], selectedFields: ["submissionDeadline", "notes"], evidence: [] });

describe("literal Russian time and Moscow timezone", () => {
  it("retains the exact event/date/time/zone facts and original provenance", () => {
    const facts = extractIntelligenceDateFacts([source()]);
    expect(facts.limited).toBe(false);
    expect(facts.facts).toEqual([expect.objectContaining({ iso: "2026-11-18", event: "submission-end", time: "18:00", timezone: "MSK", quote: exact })]);
  });

  it("keeps the actual native exact notes selected through the complete preparation/audit flow without ACK", () => {
    const raw = JSON.stringify({ items: [{ destination: "procurement", title: "Контрольная закупка QA", fields: card().fields, evidence: [], sourceIds: ["qa-source"] }] }), input = source(), before = structuredClone({ raw, input });
    const reply = runResponsePreparation({ revision: 1, raw, sources: [input], destinations: ["procurement"] });
    expect(reply.failed).toBeUndefined(); const item = reply.prepared!.items[0];
    expect(item.selectedFields).toContain("notes"); expect(item.fields.notes).toBe(exact);
    const report = auditIntelligenceResult([item], [input]);
    expect(report.fields.find((entry) => entry.field === "notes")?.status).toBe("confirmed");
    expect(getBlockingEvidenceFindings(report, item).filter((entry) => entry.field === "notes")).toEqual([]);
    expect({ raw, input }).toEqual(before);
  });

  it.each(["Окончание приема заявок: 18.11.2026 в 19:00 по московскому времени.", "Окончание приема заявок: 18.11.2026 в 18:00 UTC+4."])("still blocks a changed clock/zone assertion: %s", (notes) => {
    const item = card(notes), report = auditIntelligenceResult([item], [source()]);
    expect(report.fields.find((entry) => entry.field === "notes")?.status).toBe("conflict");
    expect(getBlockingEvidenceFindings(report, item).some((entry) => entry.field === "notes")).toBe(true);
  });

  it.each([
    "Поставка: не ранее 18.11.2026 в 18:00 по московскому времени.",
    "Дата публикации: 18.11.2026 в 18:00 по московскому времени.",
    "Окончание приема заявок: 18.11.2026 в 18:00 UTC+4.",
    "Окончание приема заявок: 18.11.2026 в 18:00 по местному времени.",
  ])("never reuses another event, a different zone or an unknown local zone: %s", (text) => {
    const item = card(), report = auditIntelligenceResult([item], [source(text)]);
    expect(report.fields.find((entry) => entry.field === "notes")?.status).not.toBe("confirmed");
    expect(getBlockingEvidenceFindings(report, item).some((entry) => entry.field === "notes")).toBe(true);
  });

  it("keeps conflicting explicit aliases ambiguous and never infers an absent timezone", () => {
    const ambiguous = "Окончание приема заявок: 18.11.2026 в 18:00 по московскому времени / UTC+4.";
    expect(extractIntelligenceDateFacts([source(ambiguous)]).facts[0]).toMatchObject({ time: "18:00", ambiguous: true });
    expect(extractIntelligenceDateFacts([source("Окончание приема заявок: 18.11.2026 в 18:00.")]).facts[0]).toMatchObject({ time: "18:00" });
    expect(extractIntelligenceDateFacts([source("Окончание приема заявок: 18.11.2026 в 18:00.")]).facts[0].timezone).toBeUndefined();
  });
});
