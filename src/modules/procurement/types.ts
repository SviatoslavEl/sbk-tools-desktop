export const procurementStatuses = ["Черновик", "Подготовка", "Подана", "Переторжка", "Победа", "Проигрыш", "Отменена"] as const;
export const evidenceKinds = ["Компания", "Партнёр", "Опыт", "Сотрудник", "Лицензия", "Документ"] as const;
export const complianceStatuses = ["Подтверждено", "Частично подтверждено", "Не подтверждено", "Требует уточнения", "Истечёт до подачи", "Истечёт до завершения работ", "Неприменимо"] as const;
export const goNoGoStatuses = ["Соответствует", "При условии", "Не соответствует", "Не оценено"] as const;
export const decisionStatuses = ["Участвовать", "Участвовать при выполнении условий", "Не участвовать", "Решение не принято"] as const;

export interface SnapshotLink { id: string; sourceModule: "calculator" | "contract-experience" | "staff"; sourceId: string; title: string; capturedAt: string; snapshot: Record<string, unknown>; }
export interface EvidenceReference { id: string; kind: typeof evidenceKinds[number]; documentId?: string; versionId?: string; sourceSha256?: string; locator?: string; excerpt?: string; sourceEntityId?: string; sourceSnapshot?: Record<string, unknown>; capturedAt: string; capturedBy: string; stale: boolean; }
export interface RequirementHistoryEntry { id: string; changedAt: string; changedBy: string; fromStatus: typeof complianceStatuses[number]; toStatus: typeof complianceStatuses[number]; comment: string; }
export interface ProcurementRequirement { id: string; category: string; text: string; mandatory: boolean; evidenceKind: typeof evidenceKinds[number]; evidence: string; status: typeof complianceStatuses[number]; statusBasis: string; source: string; responsible: string; internalDeadline: string; expiresDate: string; question: string; comments: string; evidenceLinks: EvidenceReference[]; history: RequirementHistoryEntry[]; }

export interface DocumentTextFragment { id: string; locator: string; text: string; page?: number; section?: string; sheet?: string; cellRange?: string; }
export interface ProcurementDocumentVersion { documentId: string; versionId: string; fileName: string; mimeType: string; sizeBytes: number; sha256: string; source: string; relativePath?: string; addedAt: string; extractionEngineVersion: string; processingStatus: "Ожидает обработки" | "Обработан" | "С предупреждениями" | "Ошибка"; warnings: string[]; extractedText: string; fragments: DocumentTextFragment[]; supersedesVersionId?: string; }
export interface GoNoGoCriterion { id: string; code: string; title: string; weight: number; status: typeof goNoGoStatuses[number]; comment: string; source: string; blocking: boolean; }
export interface GoNoGoDecision { calculated: typeof decisionStatuses[number]; confirmed: typeof decisionStatuses[number]; author: string; decidedAt: string; comment: string; inputRevision: number; requiresReview: boolean; }
export interface ProcurementPartner { id: string; name: string; role: string; workShare: number; responsibility: string; }
export interface ChecklistItem { id: string; text: string; done: boolean; responsible: string; dueDate: string; mandatory: boolean; fileVersionId: string; validation: string; approvedBy: string; }
export interface PriceRound { id: string; createdAt: string; ourPrice: number; competitorPrice: number; note: string; attachmentRequiresUpdate: boolean; }
export interface CustomerQuestion { id: string; category: string; text: string; basis: string; status: "Черновик" | "Согласован" | "Отправлен" | "Получен ответ"; publicText: string; }
export interface ContractRisk { id: string; category: string; severity: "Низкий" | "Средний" | "Высокий" | "Критический"; ruleId: string; match: string; explanation: string; action: string; publicComment: string; accepted: boolean; }
export interface ResourceAllocation { id: string; staffSnapshotId: string; title: string; role: string; startDate: string; endDate: string; loadPercent: number; availabilityConfirmed: boolean; }

export type ParticipationModel = "Самостоятельно" | "Через партнёра" | "Субподряд" | "Консорциум" | "Агентская модель";
export interface ParticipationScenario { id: string; name: string; model: ParticipationModel; customerPriceGross: number; vatRate: number; directCosts: number; overheadCosts: number; financingCosts: number; partnerShare: number; minimumPrice: number; selected: boolean; }
export interface CashFlowEvent { id: string; date: string; title: string; category: "Аванс" | "Платёж заказчика" | "Подрядчик" | "Налог" | "Гарантия" | "Факторинг" | "Прочее"; amount: number; confirmed: boolean; }
export interface ProcedureResult { outcome: "Не завершена" | "Победа" | "Проигрыш" | "Отмена" | "Отказ от участия"; initialPrice: number; finalPrice: number; bestKnownPrice: number; reason: string; actualCosts: number; actualProfit: number; actualMargin: number; scopeChange: string; delaysAndIssues: string; forecastDifference: string; lessons: string; confirmed: boolean; }

export interface ProcurementData {
  schemaVersion: 2; revision: number; name: string; customer: string; subject: string; nmc: number; platform: string; publishedDate: string; questionDeadline: string; submissionDeadline: string; executionStartDate: string; executionEndDate: string; responsible: string; status: typeof procurementStatuses[number];
  requirements: ProcurementRequirement[]; calculations: SnapshotLink[]; experience: SnapshotLink[]; team: SnapshotLink[]; licenses: string[]; documents: string[]; documentVersions: ProcurementDocumentVersion[]; partners: ProcurementPartner[]; checklist: ChecklistItem[]; priceHistory: PriceRound[];
  goNoGoCriteria: GoNoGoCriterion[]; goNoGoDecision: GoNoGoDecision; questions: CustomerQuestion[]; contractRisks: ContractRisk[]; resourcePlan: ResourceAllocation[]; participationScenarios: ParticipationScenario[]; cashFlow: CashFlowEvent[]; resultDetails: ProcedureResult; result: string; notes: string;
}

const id = () => crypto.randomUUID();
export const emptyRequirement = (): ProcurementRequirement => ({ id: id(), category: "Квалификация", text: "", mandatory: true, evidenceKind: "Документ", evidence: "", status: "Не подтверждено", statusBasis: "", source: "", responsible: "", internalDeadline: "", expiresDate: "", question: "", comments: "", evidenceLinks: [], history: [] });
export const emptyChecklist = (): ChecklistItem => ({ id: id(), text: "", done: false, responsible: "", dueDate: "", mandatory: true, fileVersionId: "", validation: "", approvedBy: "" });
export const emptyPartner = (): ProcurementPartner => ({ id: id(), name: "", role: "", workShare: 0, responsibility: "" });
export const emptyPriceRound = (): PriceRound => ({ id: id(), createdAt: new Date().toISOString(), ourPrice: 0, competitorPrice: 0, note: "", attachmentRequiresUpdate: false });
export const emptyQuestion = (): CustomerQuestion => ({ id: id(), category: "Объём", text: "", basis: "", status: "Черновик", publicText: "" });
export const emptyCashFlowEvent = (): CashFlowEvent => ({ id: id(), date: "", title: "", category: "Прочее", amount: 0, confirmed: false });
export const emptyResourceAllocation = (): ResourceAllocation => ({ id: id(), staffSnapshotId: "", title: "", role: "", startDate: "", endDate: "", loadPercent: 100, availabilityConfirmed: false });
export const emptyScenario = (): ParticipationScenario => ({ id: id(), name: "Основной", model: "Самостоятельно", customerPriceGross: 0, vatRate: 22, directCosts: 0, overheadCosts: 0, financingCosts: 0, partnerShare: 0, minimumPrice: 0, selected: false });

export const defaultGoNoGoCriteria = (): GoNoGoCriterion[] => [
  ["licenses", "Лицензии и сертификаты", true], ["experience", "Релевантный опыт", false], ["team", "Доступность команды", false], ["cooperation", "Субподряд, ГПХ и консорциум", false], ["schedule", "Сроки выполнения", true], ["security", "Обеспечения и гарантии", false], ["cash-gap", "Оплата и кассовый разрыв", true], ["minimum-price", "Минимальная цена", true], ["contract", "Договорные риски", false], ["requirements", "Обязательные требования", true],
].map(([code, title, blocking]) => ({ id: id(), code: String(code), title: String(title), weight: 10, status: "Не оценено", comment: "", source: "", blocking: Boolean(blocking) }));

const emptyDecision = (): GoNoGoDecision => ({ calculated: "Решение не принято", confirmed: "Решение не принято", author: "", decidedAt: "", comment: "", inputRevision: 0, requiresReview: false });
const emptyResult = (): ProcedureResult => ({ outcome: "Не завершена", initialPrice: 0, finalPrice: 0, bestKnownPrice: 0, reason: "", actualCosts: 0, actualProfit: 0, actualMargin: 0, scopeChange: "", delaysAndIssues: "", forecastDifference: "", lessons: "", confirmed: false });
export const emptyProcurement = (): ProcurementData => ({ schemaVersion: 2, revision: 1, name: "", customer: "", subject: "", nmc: 0, platform: "", publishedDate: "", questionDeadline: "", submissionDeadline: "", executionStartDate: "", executionEndDate: "", responsible: "", status: "Черновик", requirements: [], calculations: [], experience: [], team: [], licenses: [], documents: [], documentVersions: [], partners: [], checklist: [], priceHistory: [], goNoGoCriteria: defaultGoNoGoCriteria(), goNoGoDecision: emptyDecision(), questions: [], contractRisks: [], resourcePlan: [], participationScenarios: [], cashFlow: [], resultDetails: emptyResult(), result: "", notes: "" });

export function normalizeProcurement(value: Partial<ProcurementData> & Record<string, unknown>): ProcurementData {
  const base = emptyProcurement();
  const legacyRequirements = Array.isArray(value.requirements) ? value.requirements : [];
  return {
    ...base, ...value, schemaVersion: 2,
    revision: Number.isInteger(value.revision) && Number(value.revision) > 0 ? Number(value.revision) : 1,
    requirements: legacyRequirements.map((entry) => ({ ...emptyRequirement(), ...(entry as Partial<ProcurementRequirement>), status: (entry as { status?: string }).status === "Частично" ? "Частично подтверждено" : (entry as Partial<ProcurementRequirement>).status || "Не подтверждено" })),
    checklist: (value.checklist || []).map((entry) => ({ ...emptyChecklist(), ...entry })), priceHistory: (value.priceHistory || []).map((entry) => ({ ...emptyPriceRound(), ...entry })),
    goNoGoCriteria: value.goNoGoCriteria?.length ? value.goNoGoCriteria : defaultGoNoGoCriteria(), goNoGoDecision: { ...emptyDecision(), ...(value.goNoGoDecision || {}) }, resultDetails: { ...emptyResult(), ...(value.resultDetails || {}) },
    documentVersions: value.documentVersions || [], questions: value.questions || [], contractRisks: value.contractRisks || [], resourcePlan: value.resourcePlan || [], participationScenarios: value.participationScenarios || [], cashFlow: value.cashFlow || [],
  } as ProcurementData;
}
