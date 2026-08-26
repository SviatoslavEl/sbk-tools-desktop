export const procurementStatuses = ["Черновик", "Подготовка", "Подана", "Переторжка", "Победа", "Проигрыш", "Отменена"] as const;
export const evidenceKinds = ["Компания", "Партнёр", "Опыт", "Сотрудник", "Лицензия", "Документ"] as const;
export const complianceStatuses = ["Подтверждено", "Частично", "Не подтверждено", "Вопрос", "Истекает"] as const;

export interface SnapshotLink { id: string; sourceModule: "calculator" | "contract-experience" | "staff"; sourceId: string; title: string; capturedAt: string; snapshot: Record<string, unknown>; }
export interface ProcurementRequirement { id: string; text: string; evidenceKind: typeof evidenceKinds[number]; evidence: string; status: typeof complianceStatuses[number]; expiresDate: string; question: string; }
export interface ProcurementPartner { id: string; name: string; role: string; workShare: number; responsibility: string; }
export interface ChecklistItem { id: string; text: string; done: boolean; responsible: string; dueDate: string; }
export interface PriceRound { id: string; createdAt: string; ourPrice: number; competitorPrice: number; note: string; }

export interface ProcurementData {
  schemaVersion: 1;
  name: string;
  customer: string;
  subject: string;
  nmc: number;
  platform: string;
  publishedDate: string;
  questionDeadline: string;
  submissionDeadline: string;
  status: typeof procurementStatuses[number];
  requirements: ProcurementRequirement[];
  calculations: SnapshotLink[];
  experience: SnapshotLink[];
  team: SnapshotLink[];
  licenses: string[];
  documents: string[];
  partners: ProcurementPartner[];
  checklist: ChecklistItem[];
  priceHistory: PriceRound[];
  result: string;
  notes: string;
}

export const emptyRequirement = (): ProcurementRequirement => ({ id: crypto.randomUUID(), text: "", evidenceKind: "Документ", evidence: "", status: "Не подтверждено", expiresDate: "", question: "" });
export const emptyChecklist = (): ChecklistItem => ({ id: crypto.randomUUID(), text: "", done: false, responsible: "", dueDate: "" });
export const emptyPartner = (): ProcurementPartner => ({ id: crypto.randomUUID(), name: "", role: "", workShare: 0, responsibility: "" });
export const emptyPriceRound = (): PriceRound => ({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), ourPrice: 0, competitorPrice: 0, note: "" });
export const emptyProcurement = (): ProcurementData => ({ schemaVersion: 1, name: "", customer: "", subject: "", nmc: 0, platform: "", publishedDate: "", questionDeadline: "", submissionDeadline: "", status: "Черновик", requirements: [], calculations: [], experience: [], team: [], licenses: [], documents: [], partners: [], checklist: [], priceHistory: [], result: "", notes: "" });
