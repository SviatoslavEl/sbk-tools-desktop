import { describe, expect, it } from "vitest";
import type { StoredRecord } from "../../lib/storage";
import { emptyStaff, type StaffData } from "../staff/types";
import { datesBetween, qualificationScore, recommendStaff, staffLoad } from "./domain";
import { emptyTenderSchedule, type TenderScheduleData } from "./types";
import { suggestedInternalDeadline } from "./TenderCalendar";

const staffRecord = (id: string, patch: Partial<StaffData>): StoredRecord<StaffData> => ({ id, title: id, payload: { ...emptyStaff(), fullName: id, role: "Менеджер", status: "Работает", ...patch }, archived: false, createdAt: "", updatedAt: "" });

describe("tender calendar planning", () => {
  it("keeps a minimal same-day tender date sequence valid", () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(suggestedInternalDeadline("", today)).toBe(today);
  });

  it("counts only business days", () => expect(datesBetween("2026-08-28", "2026-09-01")).toEqual(["2026-08-28", "2026-08-31", "2026-09-01"]));

  it("ranks matching experienced staff above an overloaded novice", () => {
    const schedule = { ...emptyTenderSchedule(), preparationStart: "2026-09-01", internalDeadline: "2026-09-05", complexity: "Высокая" as const, requiredSkills: ["44-ФЗ", "сметы"] };
    const expert = staffRecord("expert", { skills: ["44-ФЗ", "сметы"], experienceYears: 8, qualification: "Ведущий", disclosureAllowed: true });
    const novice = staffRecord("novice", { skills: ["44-ФЗ"], experienceYears: 1 });
    expect(qualificationScore(expert.payload, schedule)).toBeGreaterThan(qualificationScore(novice.payload, schedule));
    expect(recommendStaff([novice, expert], [], schedule)[0].staffId).toBe("expert");
  });

  it("supports a legacy staff record without a skills array", () => {
    const schedule = { ...emptyTenderSchedule(), preparationStart: "2026-09-01", internalDeadline: "2026-09-05" };
    const legacy = staffRecord("legacy", { qualification: "Менеджер", experienceYears: 3 });
    delete (legacy.payload as Partial<StaffData>).skills;
    expect(() => recommendStaff([legacy], [], schedule)).not.toThrow();
  });

  it("detects daily overload across tenders", () => {
    const base = { ...emptyTenderSchedule(), preparationStart: "2026-09-01", internalDeadline: "2026-09-02" };
    const assignment = (hours: number) => ({ id: crypto.randomUUID(), staffId: "manager", role: "Менеджер" as const, startDate: "2026-09-01", endDate: "2026-09-02", plannedHours: hours, comment: "" });
    const schedules: TenderScheduleData[] = [{ ...base, assignments: [assignment(12)] }, { ...base, assignments: [assignment(8)] }];
    const load = staffLoad("manager", schedules, "2026-09-01", "2026-09-02");
    expect(load.plannedHours).toBe(20);
    expect(load.loadPercent).toBe(125);
    expect(load.conflicts).toHaveLength(2);
  });
});
