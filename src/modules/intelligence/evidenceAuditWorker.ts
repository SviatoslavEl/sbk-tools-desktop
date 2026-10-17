import { auditIntelligenceResult, type IntelligenceEvidenceReport } from "./resultEvidence";
import { evaluateTaskCompletion, type TaskCompletionReport } from "./taskCompletion";
import type { IntelligenceDestination, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

export interface EvidenceAuditRequest { revision: number; items: IntelligenceItem[]; sources: IntelligenceSource[]; destinations?: IntelligenceDestination[]; preparationLimited?: boolean; }
export interface EvidenceAuditReply { revision: number; report?: IntelligenceEvidenceReport; completion?: TaskCompletionReport; failed?: boolean; }

// Runs in a local, same-origin worker. No network, filesystem, persistence or logs.
export function runEvidenceAudit(request: EvidenceAuditRequest): EvidenceAuditReply {
  try {
    if (!Number.isSafeInteger(request.revision) || !Array.isArray(request.items) || request.items.length > 100
      || !Array.isArray(request.sources) || request.sources.length > 100) throw new Error("Invalid audit request");
    if (request.preparationLimited !== undefined && typeof request.preparationLimited !== "boolean") throw new Error("Invalid preparation limit flag");
    const completion = request.destinations ? evaluateTaskCompletion(request.items, request.sources, { destinations: request.destinations }) : undefined;
    if (completion && request.preparationLimited) {
      completion.limited = true; completion.status = "not-assessed";
      const id = `preparation-limit-${completion.snapshotKey}`;
      completion.issues.push({ id, code: "assessment-unavailable", severity: "not-assessed", itemIds: request.items.map((item) => item.id), message: "Автоматическая подготовка источников достигла предела. Результат сохранён, но полнота не установлена. Разделите материалы и повторите подготовку.", evidence: [] });
      for (const item of completion.items) { item.status = "not-assessed"; item.canTransferPrepared = false; item.canOpenIncompleteDraft = false; item.issueIds.push(id); }
      for (const destination of completion.destinations) destination.status = "not-assessed";
    }
    return { revision: request.revision, report: auditIntelligenceResult(request.items, request.sources), ...(completion ? { completion } : {}) };
  } catch { return { revision: request.revision, failed: true }; }
}

if (typeof self !== "undefined" && typeof document === "undefined" && typeof self.postMessage === "function") {
  const worker = self as unknown as { onmessage: ((event: MessageEvent<EvidenceAuditRequest>) => void) | null; postMessage: (message: EvidenceAuditReply) => void };
  worker.onmessage = (event) => worker.postMessage(runEvidenceAudit(event.data));
}
