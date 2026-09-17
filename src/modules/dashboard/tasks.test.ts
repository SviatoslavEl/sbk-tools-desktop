import { describe, expect, it } from "vitest";
import { emptyContract } from "../contracts/types";
import { emptyStaff, emptyStaffDocument } from "../staff/types";
import { emptyChecklist, emptyProcurement, emptyRequirement, procurementStatuses } from "../procurement/types";
import type { StoredRecord } from "../../lib/storage";
import { buildTaskQueue } from "./tasks";

const record = <T,>(id: string, payload: T, archived = false): StoredRecord<T> => ({ id, title: id, payload, archived, createdAt: "2026-09-17T00:00:00Z", updatedAt: "2026-09-17T00:00:00Z" });
const now = new Date(2026, 8, 17, 23);

describe("actionable dashboard queue", () => {
  it("orders overdue, today and next seven days, retaining exact record targets", () => {
    const rows = ["2026-09-25", "2026-09-24", "2026-09-17", "2026-09-15", "2026-09-16", ""].map((date, index) => record(`p${index}`, { ...emptyProcurement(), name: `Закупка ${index}`, responsible: "Иванов", submissionDeadline: date }));
    expect(buildTaskQueue(rows, [], [], now).map(({ recordId, period, days }) => ({ recordId, period, days }))).toEqual([
      { recordId: "p3", period: "overdue", days: -2 }, { recordId: "p4", period: "overdue", days: -1 }, { recordId: "p2", period: "today", days: 0 }, { recordId: "p1", period: "week", days: 7 },
    ]);
    expect(buildTaskQueue(rows, [], [], now)[0]).toMatchObject({ tool: "procurement", responsible: "Иванов" });
  });
  it("does not revive completed/submitted/rebid/archived procurements", () => {
    const rows = procurementStatuses.map((status) => record(status, { ...emptyProcurement(), status, submissionDeadline: "2026-01-01", checklist: [{ ...emptyChecklist(), dueDate: "2026-01-01" }] }));
    rows.push(record("archived", { ...emptyProcurement(), submissionDeadline: "2026-01-01" }, true));
    expect(new Set(buildTaskQueue(rows, [], [], now).map((task) => task.recordId))).toEqual(new Set(["Черновик", "Подготовка"]));
  });
  it("includes unresolved checklist/requirement deadlines with their responsible people", () => {
    const payload = { ...emptyProcurement(), name: "Заявка", responsible: "Общий", checklist: [
      { ...emptyChecklist(), id: "open", text: "Подписать", dueDate: "2026-09-17", responsible: "Петров" },
      { ...emptyChecklist(), id: "done", done: true, dueDate: "2026-09-01" },
    ], requirements: [
      { ...emptyRequirement(), id: "open", text: "Допуск", internalDeadline: "2026-09-16" },
      { ...emptyRequirement(), id: "na", internalDeadline: "2026-09-16", status: "Неприменимо" as const },
      { ...emptyRequirement(), id: "done", internalDeadline: "2026-09-16", status: "Подтверждено" as const },
    ] };
    expect(buildTaskQueue([record("p", payload)], [], [], now).map((task) => [task.action, task.responsible])).toEqual([["Допуск", "Общий"], ["Подписать", "Петров"]]);
  });
  it("links payments and expiring staff documents, skipping settled/closed/ended records", () => {
    const contract = { ...emptyContract(), number: "Д-1", responsible: "Сидоров", paymentPlannedDate: "2026-09-16", endDate: "2026-09-16" };
    const employee = { ...emptyStaff(), fullName: "Иванов", documents: [{ ...emptyStaffDocument(), id: "cert", name: "Сертификат", expiresDate: "2026-09-17" }, { ...emptyStaffDocument(), unlimited: true, expiresDate: "2026-01-01" }] };
    const queue = buildTaskQueue([], [record("c", contract), record("paid", { ...contract, stage: "Закрыт", paymentStatus: "Полностью оплачено" }), record("archived", contract, true)], [record("s", employee), record("ended", { ...employee, status: "Сотрудничество завершено" })], now);
    expect(queue.map((task) => [task.tool, task.recordId])).toEqual([["contracts", "c"], ["contracts", "c"], ["staff", "s"]]);
    expect(queue[0].responsible).toBe("Сидоров");
  });
});
