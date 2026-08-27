import type { ContractData } from "./types";

export interface ContractSelectionCriteria {
  procurementTitle: string;
  legalEntity: string;
  keywords: string;
  minAmount: number;
  maxAmount?: number;
  amountBasis?: "full" | "ourShare";
  industry?: string;
  serviceType?: string;
  contractRole?: string;
  stage?: ContractData["stage"] | "";
  endDateFrom?: string;
  endDateTo?: string;
  reviewOnly?: boolean;
  completedOnly: boolean;
  disclosureOnly: boolean;
}

export interface ContractMatch { score: number; reasons: string[] }

const genericProcurementStems = [
  "оказан", "услуг", "выполнен", "работ", "закуп", "договор", "постав", "провед", "организац", "согласн",
];

function isGenericProcurementWord(word: string): boolean {
  return genericProcurementStems.some((stem) => word.startsWith(stem));
}

export function matchContract(contract: ContractData, criteria: ContractSelectionCriteria): ContractMatch {
  const reasons: string[] = [];
  let score = 0;
  const searchable = [contract.subject, contract.workScope, contract.industry, contract.serviceType, ...(contract.standards || [])].join(" ").toLowerCase();
  const words = `${criteria.procurementTitle} ${criteria.keywords}`.toLowerCase().split(/[^a-zа-яё0-9-]+/i)
    .filter((word) => word.length >= 3 && !isGenericProcurementWord(word));
  const matched = [...new Set(words.filter((word) => searchable.includes(word)))];
  if (words.length && !matched.length) return { score: 0, reasons: [] };
  if (matched.length) { score += Math.min(60, matched.length * 12); reasons.push(`Совпадают: ${matched.join(", ")}`); }
  if (criteria.legalEntity && contract.performingLegalEntity === criteria.legalEntity) { score += 15; reasons.push("Подходящее юрлицо"); }
  if (contract.stage === "Выполнен") { score += 10; reasons.push("Договор выполнен"); }
  if (contract.reviewAvailable) { score += 5; reasons.push("Есть отзыв"); }
  if (contract.disclosureAllowed) { score += 10; reasons.push("Разрешено раскрытие"); }
  const amount = criteria.amountBasis === "ourShare" ? contract.ourShareAmount : contract.amount;
  if (amount >= criteria.minAmount) { score += 5; reasons.push(criteria.amountBasis === "ourShare" ? "Подходит стоимость нашей части" : "Подходит полная стоимость"); }
  if (criteria.legalEntity && contract.performingLegalEntity !== criteria.legalEntity) score = 0;
  if (criteria.industry && contract.industry !== criteria.industry) score = 0;
  if (criteria.serviceType && contract.serviceType !== criteria.serviceType) score = 0;
  if (criteria.contractRole && contract.contractRole !== criteria.contractRole) score = 0;
  if (criteria.stage && contract.stage !== criteria.stage) score = 0;
  if (criteria.completedOnly && contract.stage !== "Выполнен") score = 0;
  if (criteria.reviewOnly && !contract.reviewAvailable) score = 0;
  if (criteria.disclosureOnly && !contract.disclosureAllowed) score = 0;
  if (amount < criteria.minAmount) score = 0;
  if (criteria.maxAmount && amount > criteria.maxAmount) score = 0;
  if (criteria.endDateFrom && (!contract.endDate || contract.endDate < criteria.endDateFrom)) score = 0;
  if (criteria.endDateTo && (!contract.endDate || contract.endDate > criteria.endDateTo)) score = 0;
  return { score: Math.min(100, score), reasons };
}
