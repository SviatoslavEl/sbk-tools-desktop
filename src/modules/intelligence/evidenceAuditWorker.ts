import { auditIntelligenceResult, type IntelligenceEvidenceReport } from "./resultEvidence";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

export interface EvidenceAuditRequest { revision: number; items: IntelligenceItem[]; sources: IntelligenceSource[]; }
export interface EvidenceAuditReply { revision: number; report?: IntelligenceEvidenceReport; failed?: boolean; }

// Runs in a local, same-origin worker. No network, filesystem, persistence or logs.
export function runEvidenceAudit(request: EvidenceAuditRequest): EvidenceAuditReply {
  try {
    if (!Number.isSafeInteger(request.revision) || !Array.isArray(request.items) || request.items.length > 100
      || !Array.isArray(request.sources) || request.sources.length > 100) throw new Error("Invalid audit request");
    return { revision: request.revision, report: auditIntelligenceResult(request.items, request.sources) };
  } catch { return { revision: request.revision, failed: true }; }
}

if (typeof self !== "undefined" && typeof document === "undefined" && typeof self.postMessage === "function") {
  const worker = self as unknown as { onmessage: ((event: MessageEvent<EvidenceAuditRequest>) => void) | null; postMessage: (message: EvidenceAuditReply) => void };
  worker.onmessage = (event) => worker.postMessage(runEvidenceAudit(event.data));
}
