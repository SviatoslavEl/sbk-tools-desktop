import type { ContractData } from "./types";

export interface ContractSelectionCriteria {
  procurementTitle: string;
  legalEntity: string;
  keywords: string;
  minAmount: number;
  completedOnly: boolean;
  disclosureOnly: boolean;
}

export interface ContractMatch { score: number; reasons: string[] }

export function matchContract(contract: ContractData, criteria: ContractSelectionCriteria): ContractMatch {
  const reasons: string[] = [];
  let score = 0;
  const searchable = [contract.subject, contract.workScope, contract.industry, contract.serviceType, ...(contract.standards || [])].join(" ").toLowerCase();
  const words = `${criteria.procurementTitle} ${criteria.keywords}`.toLowerCase().split(/[^a-zа-яё0-9-]+/i).filter((word) => word.length >= 3);
  const matched = [...new Set(words.filter((word) => searchable.includes(word)))];
  if (matched.length) { score += Math.min(60, matched.length * 12); reasons.push(`Совпадают: ${matched.join(", ")}`); }
  if (criteria.legalEntity && contract.performingLegalEntity === criteria.legalEntity) { score += 15; reasons.push("Подходящее юрлицо"); }
  if (contract.stage === "Выполнен") { score += 10; reasons.push("Договор выполнен"); }
  if (contract.reviewAvailable) { score += 5; reasons.push("Есть отзыв"); }
  if (contract.disclosureAllowed) { score += 10; reasons.push("Разрешено раскрытие"); }
  if (contract.amount >= criteria.minAmount) { score += 5; reasons.push("Подходит по стоимости"); }
  if (criteria.legalEntity && contract.performingLegalEntity !== criteria.legalEntity) score = 0;
  if (criteria.completedOnly && contract.stage !== "Выполнен") score = 0;
  if (criteria.disclosureOnly && !contract.disclosureAllowed) score = 0;
  if (contract.amount < criteria.minAmount) score = 0;
  return { score: Math.min(100, score), reasons };
}
