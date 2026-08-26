import { describe, expect, it } from "vitest";
import { buildRebidSteps, complianceSummary, procurementWarnings, suggestedExperience, suggestedTeam } from "./domain";
import { emptyContract } from "../contracts/types";
import { emptyStaff } from "../staff/types";
import { emptyProcurement, emptyRequirement } from "./types";

describe("procurement domain", () => {
  it("builds a bounded rebid ladder and marks losses", () => {
    expect(buildRebidSteps(100, 80, 3, 10, "comfort").map((step) => step.price)).toEqual([100, 92, 92]);
    expect(buildRebidSteps(100, 120, 2, 10, "any-price")[0].loss).toBe(true);
  });

  it("suggests only relevant records that may be disclosed while leaving final choice to UI", () => {
    const item = { ...emptyProcurement(), subject: "Проектирование энергетических объектов", submissionDeadline: "2026-09-01" };
    const contracts = [
      { id: "allowed", payload: { ...emptyContract(), subject: "Проектирование энергетических объектов", disclosureAllowed: true } },
      { id: "private", payload: { ...emptyContract(), subject: "Проектирование энергетических объектов", disclosureAllowed: false } },
    ];
    const staff = [
      { id: "engineer", payload: { ...emptyStaff(), skills: ["проектирование", "энергетика"], disclosureAllowed: true, availableTo: "2026-12-31" } },
      { id: "busy", payload: { ...emptyStaff(), skills: ["проектирование"], disclosureAllowed: true, availableTo: "2026-08-01" } },
    ];
    expect(suggestedExperience(item, contracts)).toEqual(["allowed"]);
    expect(suggestedTeam(item, staff)).toEqual(["engineer"]);
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
