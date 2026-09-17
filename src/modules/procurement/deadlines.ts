import type { ProcurementData } from "./types";

// Use calendar dates, not elapsed 24-hour periods: UTC offsets and DST must not
// move a task into yesterday/tomorrow. The displayed deadline is date-only.
export function calendarDaysUntil(value: string, now = new Date()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return Math.round((date.getTime() - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
}

export function submissionPending(item: Pick<ProcurementData, "status">) {
  return item.status === "Черновик" || item.status === "Подготовка";
}

export function procurementDeadline(item: Pick<ProcurementData, "status" | "submissionDeadline">, now = new Date()) {
  const days = calendarDaysUntil(item.submissionDeadline, now);
  const pending = submissionPending(item);
  const label = !pending || days == null ? "" : days < 0 ? `просрочено на ${Math.abs(days)} дн.` : days === 0 ? "сегодня" : `через ${days} дн.`;
  const tone = pending && days != null && days < 0 ? "danger" : pending && days != null && days <= 7 ? "warning" : "neutral";
  return { days, pending, label, tone };
}
