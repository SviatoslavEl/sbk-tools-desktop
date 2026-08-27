import type { StaffData } from "../staff/types";
import type { StoredRecord } from "../../lib/storage";
import type { TenderAssignment, TenderComplexity, TenderScheduleData } from "./types";

const DAY = 86_400_000;
export const complexityPoints: Record<TenderComplexity, number> = { "Низкая": 1, "Средняя": 2, "Высокая": 3, "Экспертная": 4 };
export const complexityHours: Record<TenderComplexity, number> = { "Низкая": 24, "Средняя": 48, "Высокая": 80, "Экспертная": 120 };
const minimumExperience: Record<TenderComplexity, number> = { "Низкая": 0, "Средняя": 2, "Высокая": 4, "Экспертная": 7 };

function atUtc(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const value = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(value) ? value : null;
}

export function datesBetween(start: string, end: string): string[] {
  const from = atUtc(start); const to = atUtc(end);
  if (from == null || to == null || from > to) return [];
  const result: string[] = [];
  for (let value = from; value <= to; value += DAY) {
    const day = new Date(value).getUTCDay();
    if (day !== 0 && day !== 6) result.push(new Date(value).toISOString().slice(0, 10));
  }
  return result;
}

export function daysTo(date: string, now = new Date()): number | null {
  const target = atUtc(date);
  if (target == null) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.ceil((target - today) / DAY);
}

export function qualificationScore(staff: StaffData, schedule: TenderScheduleData): number {
  if (staff.status !== "Работает") return 0;
  const wanted = (schedule.requiredSkills || []).map((value) => value.trim().toLowerCase()).filter(Boolean);
  const available = [...(staff.skills || []), staff.qualification || "", staff.role || "", staff.grade || ""].join(" ").toLowerCase();
  const skillScore = wanted.length ? wanted.filter((skill) => available.includes(skill)).length / wanted.length * 55 : 40;
  const requiredYears = minimumExperience[schedule.complexity];
  const experienceScore = requiredYears === 0 ? 30 : Math.min(30, (staff.experienceYears || 0) / requiredYears * 30);
  const disclosureScore = staff.disclosureAllowed ? 10 : 0;
  const qualificationBonus = staff.qualification?.trim() ? 5 : 0;
  return Math.round(Math.min(100, skillScore + experienceScore + disclosureScore + qualificationBonus));
}

export interface StaffLoad {
  staffId: string;
  plannedHours: number;
  capacityHours: number;
  loadPercent: number;
  conflicts: string[];
}

export function staffLoad(staffId: string, schedules: TenderScheduleData[], rangeStart: string, rangeEnd: string): StaffLoad {
  const rangeDays = new Set(datesBetween(rangeStart, rangeEnd));
  const perDay = new Map<string, number>();
  let plannedHours = 0;
  for (const schedule of schedules) for (const assignment of schedule.assignments.filter((item) => item.staffId === staffId)) {
    const days = datesBetween(assignment.startDate, assignment.endDate).filter((date) => rangeDays.has(date));
    const allDays = Math.max(1, datesBetween(assignment.startDate, assignment.endDate).length);
    const dailyHours = assignment.plannedHours / allDays;
    for (const date of days) perDay.set(date, (perDay.get(date) || 0) + dailyHours);
    plannedHours += dailyHours * days.length;
  }
  const conflicts = [...perDay.entries()].filter(([, hours]) => hours > 8.01).map(([date, hours]) => `${date}: ${hours.toFixed(1)} ч.`);
  const capacityHours = rangeDays.size * 8;
  return { staffId, plannedHours, capacityHours, loadPercent: capacityHours ? plannedHours / capacityHours * 100 : 0, conflicts };
}

export interface StaffRecommendation { staffId: string; score: number; qualification: number; load: number; reason: string; }

export function recommendStaff(
  staff: StoredRecord<StaffData>[], schedules: TenderScheduleData[], schedule: TenderScheduleData,
): StaffRecommendation[] {
  const start = schedule.preparationStart;
  const end = schedule.internalDeadline || schedule.submissionDeadline;
  return staff.map((record) => {
    const qualification = qualificationScore(record.payload, schedule);
    const load = staffLoad(record.id, schedules, start, end).loadPercent;
    const availabilityPenalty = (record.payload.availableFrom && start < record.payload.availableFrom) || (record.payload.availableTo && end > record.payload.availableTo) ? 35 : 0;
    const score = Math.max(0, Math.round(qualification * .7 + Math.max(0, 100 - load) * .3 - availabilityPenalty));
    const reason = `${qualification}% соответствие квалификации · ${Math.round(load)}% текущая загрузка${availabilityPenalty ? " · вне периода доступности" : ""}`;
    return { staffId: record.id, score, qualification, load, reason };
  }).filter((row) => row.qualification > 0).sort((a, b) => b.score - a.score || a.load - b.load);
}

export function scheduleRisks(schedule: TenderScheduleData, allSchedules: TenderScheduleData[], now = new Date()): string[] {
  const risks: string[] = [];
  const days = daysTo(schedule.internalDeadline || schedule.submissionDeadline, now);
  if (days != null && days < 0 && !["Готова", "Подана"].includes(schedule.status)) risks.push("Внутренний срок просрочен");
  else if (days != null && days <= 3 && !["Готова", "Подана"].includes(schedule.status)) risks.push(`До внутреннего срока ${days} дн.`);
  if (!schedule.assignments.some((item) => item.role === "Руководитель заявки" || item.role === "Менеджер")) risks.push("Не назначен менеджер");
  const planned = schedule.assignments.reduce((sum, item) => sum + item.plannedHours, 0);
  if (planned < schedule.estimatedHours) risks.push(`Не распределено ${Math.max(0, schedule.estimatedHours - planned)} ч.`);
  for (const assignment of schedule.assignments) {
    const load = staffLoad(assignment.staffId, allSchedules, assignment.startDate, assignment.endDate);
    if (load.conflicts.length) risks.push(`Перегрузка сотрудника: ${load.conflicts[0]}`);
  }
  return [...new Set(risks)];
}

export function assignmentHoursPerDay(assignment: TenderAssignment): number {
  return assignment.plannedHours / Math.max(1, datesBetween(assignment.startDate, assignment.endDate).length);
}
