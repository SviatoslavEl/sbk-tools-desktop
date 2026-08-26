import { describe, expect, it } from "vitest";
import { emptyContract } from "./types";
import { contractBalance, contractChecks } from "./validation";

describe("contract validation", () => {
  it("reports every contradictory state independently", () => {
    const item = { ...emptyContract(), startDate: "2026-05-02", endDate: "2026-05-01", amount: 100, paidAmount: 120, paymentStatus: "Полностью оплачено" as const, actsStatus: "Подписаны полностью" as const };
    expect(contractChecks(item).map((check) => check.code)).toEqual(["date-order", "overpayment", "acts-preparation"]);
    expect(contractBalance(item)).toEqual({ outstanding: 0, overpayment: 20 });
  });

  it("detects missing payment facts", () => {
    expect(contractChecks({ ...emptyContract(), paymentStatus: "Просрочено" })).toContainEqual(expect.objectContaining({ code: "overdue-no-date" }));
    expect(contractChecks({ ...emptyContract(), paymentStatus: "Не выставлено", paymentActualDate: "2026-01-01" })).toContainEqual(expect.objectContaining({ code: "actual-not-issued" }));
  });
});
