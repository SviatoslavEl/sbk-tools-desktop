import { describe, expect, it, vi } from "vitest";
import { runEvidenceAudit, type EvidenceAuditRequest } from "./evidenceAuditWorker";
import type { IntelligenceItem } from "./workbenchTypes";

const card: IntelligenceItem = { id: "card", title: "Закупка QA", destination: "procurement", sourceIds: ["source"], selectedFields: ["name"], fields: { name: "Закупка QA" } };
const request = (revision = 17): EvidenceAuditRequest => ({ revision, items: [card], sources: [{ id: "source", name: "Источник QA", text: "Закупка QA" }] });

describe("local evidence worker replies", () => {
  it("does not replace the host window message handler when imported by the UI", async () => {
    const handler = vi.fn(), host = { onmessage: handler, postMessage: vi.fn() };
    vi.stubGlobal("self", host); vi.stubGlobal("document", {}); vi.resetModules();
    try { await import("./evidenceAuditWorker"); expect(host.onmessage).toBe(handler); expect(host.postMessage).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); }
  });
  it("returns the requested revision and an evidence report without touching external boundaries", () => {
    const reply = runEvidenceAudit(request());
    expect(reply.revision).toBe(17); expect(reply.failed).toBeUndefined(); expect(reply.report?.fields[0].status).toBe("confirmed");
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])("fails closed for invalid revision %s", (revision) => {
    expect(runEvidenceAudit(request(revision))).toEqual({ revision, failed: true });
  });
  it("rejects oversized item/source envelopes and malformed runtime data", () => {
    expect(runEvidenceAudit({ ...request(), items: Array(101).fill(card) }).failed).toBe(true);
    expect(runEvidenceAudit({ ...request(), sources: Array(101).fill(request().sources[0]) }).failed).toBe(true);
    const malformed = { ...request(), sources: [{ id: "source", name: "Источник", fragments: [{ locator: "bad", text: null }] }] } as unknown as EvidenceAuditRequest;
    expect(runEvidenceAudit(malformed)).toEqual({ revision: 17, failed: true });
  });
  it("returns an explicit blocking audit limit rather than silently asserting completeness", () => {
    const reply = runEvidenceAudit({ ...request(), sources: [{ id: "source", name: "Большой QA", text: Array.from({ length: 5001 }, (_, index) => `Строка ${index}`).join("\n") }] });
    expect(reply.failed).toBeUndefined(); expect(reply.report?.findings.some((finding) => finding.code === "audit-limit" && finding.severity === "blocking")).toBe(true);
  });
});
