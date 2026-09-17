import { describe, expect, it } from "vitest";
import { calendarDaysUntil, procurementDeadline, submissionPending } from "./deadlines";
import { procurementStatuses } from "./types";
import { emptyProcurement } from "./types";
import { procurementWarnings, daysUntil } from "./domain";

describe("submission deadline semantics", () => {
  const now = new Date(2026, 8, 17, 23, 59);
  it("compares local calendar days at midnight/month/year/leap boundaries", () => {
    expect(calendarDaysUntil("2026-09-17", now)).toBe(0);
    expect(calendarDaysUntil("2026-09-18", now)).toBe(1);
    expect(calendarDaysUntil("2026-09-16", now)).toBe(-1);
    expect(calendarDaysUntil("2027-01-01", new Date(2026, 11, 31, 23))).toBe(1);
    expect(calendarDaysUntil("2028-02-29", new Date(2028, 1, 28))).toBe(1);
    expect(calendarDaysUntil("2026-03-30", new Date(2026, 2, 29))).toBe(1);
  });
  it("does not turn empty, malformed, or impossible dates into tasks", () => {
    for (const value of ["", "bad", "2026-02-29", "2026-13-01", "2026-04-31", "2026-09-17T12:00:00Z"]) expect(calendarDaysUntil(value, now)).toBeNull();
  });
  it("only draft/preparation still require the original submission", () => {
    for (const status of procurementStatuses) {
      const result = procurementDeadline({ status, submissionDeadline: "2026-09-16" }, now);
      if (status === "Черновик" || status === "Подготовка") expect(result).toMatchObject({ pending: true, tone: "danger", label: "просрочено на 1 дн." });
      else expect(result).toMatchObject({ pending: false, tone: "neutral", label: "" });
      expect(submissionPending({ status })).toBe(["Черновик", "Подготовка"].includes(status));
    }
  });
  it("labels today and seven days but does not warn about day eight", () => {
    expect(procurementDeadline({ status: "Подготовка", submissionDeadline: "2026-09-17" }, now)).toMatchObject({ tone: "warning", label: "сегодня" });
    expect(procurementDeadline({ status: "Подготовка", submissionDeadline: "2026-09-24" }, now).tone).toBe("warning");
    expect(procurementDeadline({ status: "Подготовка", submissionDeadline: "2026-09-25" }, now).tone).toBe("neutral");
  });
  it("uses the same semantics inside a card and through the older date helper", () => {
    expect(daysUntil("2026-09-17", now)).toBe(0);
    const item = { ...emptyProcurement(), name: "Заявка", customer: "Заказчик", subject: "Работы", nmc: 100, submissionDeadline: "2026-09-16" };
    expect(procurementWarnings(item, now)).toContain("Срок подачи истёк, но закупка не отмечена как поданная или завершённая.");
    expect(procurementWarnings({ ...item, status: "Переторжка" }, now)).toEqual([]);
    expect(procurementWarnings({ ...item, submissionDeadline: "2026-09-17" }, now)).toEqual([]);
  });
});
