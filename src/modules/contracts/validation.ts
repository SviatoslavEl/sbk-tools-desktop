import type { ContractData } from "./types";

export interface ContractCheck {
  code: string;
  severity: "warning" | "error";
  message: string;
}

export function contractChecks(item: ContractData): ContractCheck[] {
  const checks: ContractCheck[] = [];
  if (item.startDate && item.endDate && item.endDate < item.startDate) checks.push({ code: "date-order", severity: "error", message: "Дата окончания раньше даты начала." });
  if (item.paidAmount > item.amount) checks.push({ code: "overpayment", severity: "warning", message: `Переплата: ${(item.paidAmount - item.amount).toLocaleString("ru-RU")} ₽.` });
  if (item.paymentStatus === "Полностью оплачено" && item.paidAmount <= 0) checks.push({ code: "paid-zero", severity: "error", message: "Указана полная оплата, но оплаченная сумма равна нулю." });
  if (item.paymentStatus === "Просрочено" && !item.paymentPlannedDate) checks.push({ code: "overdue-no-date", severity: "error", message: "Для просроченной оплаты не указана плановая дата." });
  if (item.paymentStatus === "Не выставлено" && item.paymentActualDate) checks.push({ code: "actual-not-issued", severity: "error", message: "Указана фактическая оплата при статусе «Не выставлено»." });
  if (item.actsStatus === "Подписаны полностью" && item.stage === "Подготовка") checks.push({ code: "acts-preparation", severity: "error", message: "Акты полностью подписаны, хотя договор ещё на стадии подготовки." });
  return checks;
}

export function contractBalance(item: ContractData) {
  return { outstanding: Math.max(0, item.amount - item.paidAmount), overpayment: Math.max(0, item.paidAmount - item.amount) };
}
