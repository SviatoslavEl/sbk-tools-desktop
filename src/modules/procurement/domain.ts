import type { ProcurementData, ProcurementRequirement } from "./types";
import type { ContractData } from "../contracts/types";
import type { StaffData } from "../staff/types";

export type RebidPreset = "comfort" | "working-minimum" | "any-price";
export interface RebidStep { number: number; price: number; reduction: number; profit: number; margin: number; headroom: number; loss: boolean; }

export function buildRebidSteps(nmc: number, cost: number, count: number, reductionPercent: number, preset: RebidPreset): RebidStep[] {
  if (!Number.isFinite(nmc) || !Number.isFinite(cost) || nmc <= 0 || cost < 0) throw new Error("Укажите корректные НМЦ и себестоимость.");
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("Количество шагов должно быть от 1 до 20.");
  if (!Number.isFinite(reductionPercent) || reductionPercent <= 0 || reductionPercent > 50) throw new Error("Снижение должно быть больше 0 и не более 50%. ");
  const floorMultiplier = preset === "comfort" ? 1.15 : preset === "working-minimum" ? 1.03 : 0;
  return Array.from({ length: count }, (_, index) => {
    const raw = nmc * (1 - reductionPercent / 100 * index);
    const price = preset === "any-price" ? Math.max(0, raw) : Math.max(cost * floorMultiplier, raw);
    const profit = price - cost;
    return { number: index + 1, price, reduction: nmc - price, profit, margin: price ? profit / price * 100 : 0, headroom: price - cost, loss: profit < 0 };
  });
}

export function complianceSummary(requirements: ProcurementRequirement[]) {
  const gaps = requirements.filter((item) => ["Не подтверждено", "Частично", "Истекает"].includes(item.status));
  const questions = requirements.filter((item) => item.status === "Вопрос" || item.question.trim()).map((item) => item.question.trim() || item.text);
  return { confirmed: requirements.filter((item) => item.status === "Подтверждено").length, total: requirements.length, gaps, questions };
}

export function procurementWarnings(item: ProcurementData, now = new Date()) {
  const warnings: string[] = [];
  if (!item.name.trim() || !item.customer.trim() || !item.subject.trim()) warnings.push("Не заполнены название, заказчик или предмет закупки.");
  if (item.nmc <= 0) warnings.push("НМЦ должна быть больше нуля.");
  if (item.questionDeadline && item.submissionDeadline && item.questionDeadline > item.submissionDeadline) warnings.push("Срок вопросов позже срока подачи заявки.");
  const share = item.partners.reduce((sum, partner) => sum + partner.workShare, 0);
  if (share > 100) warnings.push(`Суммарная доля партнёров ${share}% превышает 100%.`);
  const due = item.submissionDeadline ? new Date(`${item.submissionDeadline}T23:59:59`) : null;
  if (due && due < now && !["Подана", "Победа", "Проигрыш", "Отменена"].includes(item.status)) warnings.push("Срок подачи истёк, но закупка не отмечена как поданная или завершённая.");
  return warnings;
}

export function daysUntil(value: string, now = new Date()) {
  if (!value) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.ceil((new Date(`${value}T23:59:59`).getTime() - today) / 86_400_000);
}

const significantWords = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((word) => word.length >= 4));
const relevance = (need: Set<string>, values: string[]) => {
  const candidate = significantWords(values.join(" "));
  return [...need].filter((word) => candidate.has(word)).length;
};

export function suggestedExperience(item: ProcurementData, records: Array<{ id: string; payload: ContractData }>): string[] {
  const need = significantWords([item.subject, ...item.requirements.map((row) => row.text)].join(" "));
  return records
    .filter((record) => record.payload.disclosureAllowed)
    .map((record) => ({ id: record.id, score: relevance(need, [record.payload.subject, record.payload.industry, record.payload.serviceType, record.payload.workScope, ...(record.payload.standards || [])]) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map((entry) => entry.id);
}

export function suggestedTeam(item: ProcurementData, records: Array<{ id: string; payload: StaffData }>): string[] {
  const need = significantWords([item.subject, ...item.requirements.map((row) => row.text)].join(" "));
  return records
    .filter((record) => record.payload.disclosureAllowed)
    .filter((record) => !item.submissionDeadline || !record.payload.availableFrom || record.payload.availableFrom <= item.submissionDeadline)
    .filter((record) => !item.submissionDeadline || !record.payload.availableTo || record.payload.availableTo >= item.submissionDeadline)
    .map((record) => ({ id: record.id, score: relevance(need, [record.payload.role, record.payload.grade, record.payload.qualification, record.payload.experienceNotes, ...(record.payload.skills || [])]) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map((entry) => entry.id);
}
