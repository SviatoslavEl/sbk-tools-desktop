import { describe, expect, it } from "vitest";
import { buildRebidSteps, complianceSummary, procurementWarnings } from "./domain";
import { emptyProcurement, emptyRequirement } from "./types";

describe("procurement domain", () => {
  it("builds a bounded rebid ladder and marks losses", () => {
    expect(buildRebidSteps(100, 80, 3, 10, "comfort").map((step) => step.price)).toEqual([100, 92, 92]);
    expect(buildRebidSteps(100, 120, 2, 10, "any-price")[0].loss).toBe(true);
  });

  it("collects compliance gaps and questions", () => {
    const gap = { ...emptyRequirement(), text: "Лицензия" };
    const question = { ...emptyRequirement(), text: "Опыт", status: "Вопрос" as const, question: "Какой период?" };
    expect(complianceSummary([gap, question])).toMatchObject({ confirmed: 0, total: 2, questions: ["Какой период?"] });
  });

  it("finds contradictory deadlines and partner shares", () => {
    const item = { ...emptyProcurement(), name: "Тест", customer: "Заказчик", subject: "Услуги", nmc: 1, questionDeadline: "2026-02-02", submissionDeadline: "2026-02-01", partners: [{ id: "1", name: "П", role: "", workShare: 101, responsibility: "" }] };
    expect(procurementWarnings(item, new Date("2026-01-01"))).toHaveLength(2);
  });
});
