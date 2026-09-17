import type { StoredRecord } from "../../lib/storage";
import type { ContractData } from "../contracts/types";
import type { StaffData } from "../staff/types";
import type { ProcurementData } from "../procurement/types";
import { calendarDaysUntil, submissionPending } from "../procurement/deadlines";

export type DashboardTool = "procurement" | "calculator" | "scanner" | "contracts" | "staff";
export type TaskPeriod = "overdue" | "today" | "week";
export interface DashboardTask {
  id: string; tool: DashboardTool; recordId: string; title: string;
  action: string; date: string; days: number; responsible: string; period: TaskPeriod;
}
export const taskPeriods: Array<[TaskPeriod, string]> = [["overdue", "Просрочено"], ["today", "Сегодня"], ["week", "В ближайшие 7 дней"]];

export function buildTaskQueue(procurements: StoredRecord<ProcurementData>[], contracts: StoredRecord<ContractData>[], staff: StoredRecord<StaffData>[], now = new Date()): DashboardTask[] {
  const tasks: DashboardTask[] = [];
  const add = (task: Omit<DashboardTask, "days" | "period">) => {
    const days = calendarDaysUntil(task.date, now);
    if (days == null || days > 7) return;
    tasks.push({ ...task, days, period: days < 0 ? "overdue" : days === 0 ? "today" : "week" });
  };
  for (const record of procurements.filter((entry) => !entry.archived && submissionPending(entry.payload))) {
    const item = record.payload;
    add({ id: `submission:${record.id}`, tool: "procurement", recordId: record.id, title: item.name, action: "Проверить подачу заявки", date: item.submissionDeadline, responsible: item.responsible });
    for (const entry of item.checklist.filter((row) => !row.done)) add({ id: `checklist:${record.id}:${entry.id}`, tool: "procurement", recordId: record.id, title: item.name, action: entry.text || "Выполнить пункт чек-листа", date: entry.dueDate, responsible: entry.responsible || item.responsible });
    for (const entry of item.requirements.filter((row) => !["Подтверждено", "Неприменимо"].includes(row.status))) add({ id: `requirement:${record.id}:${entry.id}`, tool: "procurement", recordId: record.id, title: item.name, action: entry.text || "Подтвердить требование", date: entry.internalDeadline, responsible: entry.responsible || item.responsible });
  }
  for (const record of contracts.filter((entry) => !entry.archived)) {
    const item = record.payload;
    if (!["Полностью оплачено", "Не применяется"].includes(item.paymentStatus)) add({ id: `payment:${record.id}`, tool: "contracts", recordId: record.id, title: item.number || record.title, action: "Проверить оплату договора", date: item.paymentPlannedDate, responsible: item.responsible });
    if (!["Закрыт", "Выполнен", "Расторгнут"].includes(item.stage)) add({ id: `contract:${record.id}`, tool: "contracts", recordId: record.id, title: item.number || record.title, action: "Проверить завершение договора", date: item.endDate, responsible: item.responsible });
  }
  for (const record of staff.filter((entry) => !entry.archived && entry.payload.status !== "Сотрудничество завершено")) for (const document of record.payload.documents) {
    if (!document.unlimited) add({ id: `staff:${record.id}:${document.id}`, tool: "staff", recordId: record.id, title: record.payload.fullName, action: `Обновить документ: ${document.name || document.type}`, date: document.expiresDate, responsible: "" });
  }
  return tasks.sort((left, right) => left.days - right.days || left.title.localeCompare(right.title, "ru") || left.id.localeCompare(right.id));
}
