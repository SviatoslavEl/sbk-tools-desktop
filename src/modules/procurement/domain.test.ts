import { describe, expect, it } from "vitest";
import { applicationCompleteness, buildRebidSteps, calculateGoNoGo, cashFlowSummary, complianceSummary, confirmGoNoGo, detectContractRisks, markSignificantChange, procurementWarnings, replaceDocumentVersion, resourceConflicts, scenarioFinancials, suggestedExperience, suggestedTeam } from "./domain";
import { emptyContract } from "../contracts/types";
import { emptyStaff } from "../staff/types";
import { emptyProcurement, emptyRequirement, emptyScenario } from "./types";

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
    const question = { ...emptyRequirement(), text: "Опыт", status: "Требует уточнения" as const, question: "Какой период?" };
    expect(complianceSummary([gap, question])).toMatchObject({ confirmed: 0, total: 2, questions: ["Какой период?"] });
  });

  it("finds contradictory deadlines and partner shares", () => {
    const item = { ...emptyProcurement(), name: "Тест", customer: "Заказчик", subject: "Услуги", nmc: 1, questionDeadline: "2026-02-02", submissionDeadline: "2026-02-01", partners: [{ id: "1", name: "П", role: "", workShare: 101, responsibility: "" }] };
    expect(procurementWarnings(item, new Date("2026-01-01"))).toHaveLength(2);
  });

  it("reports an invalid scenario VAT rate without allowing it to reach rendering", () => {
    const item = emptyProcurement();
    item.name = "Тест";
    item.customer = "Заказчик";
    item.subject = "Услуги";
    item.nmc = 1;
    item.participationScenarios = [{ ...emptyScenario(), id: "vat", name: "Ошибка НДС", vatRate: 101 }];
    expect(procurementWarnings(item)).toContain("Ставка НДС сценария «Ошибка НДС» должна быть от 0 до 100%.");
    expect(() => scenarioFinancials(item.participationScenarios[0])).toThrow("Ставка НДС должна быть от 0 до 100%.");
  });

  it("does not allow a positive Go/No-Go decision while a blocking criterion fails", () => {
    const item = emptyProcurement();
    expect(calculateGoNoGo(item.goNoGoCriteria).decision).toBe("Решение не принято");
    const criteria = item.goNoGoCriteria.map((criterion) => ({ ...criterion, status: criterion.code === "licenses" ? "Не соответствует" as const : "Соответствует" as const }));
    expect(calculateGoNoGo(criteria)).toMatchObject({ decision: "Не участвовать", blockingFailure: true });
    const confirmed = confirmGoNoGo({ ...item, goNoGoCriteria: criteria }, "Не участвовать", "Иванов", "Нет лицензии", new Date("2026-08-26T10:00:00Z"));
    expect(confirmed.goNoGoDecision).toMatchObject({ author: "Иванов", inputRevision: 1, requiresReview: false });
    expect(markSignificantChange(confirmed).goNoGoDecision.requiresReview).toBe(true);
  });

  it("marks evidence stale after a document replacement", () => {
    const item = emptyProcurement();
    item.requirements = [{ ...emptyRequirement(), text: "Требование", evidenceLinks: [{ id: "e1", kind: "Документ", documentId: "doc", versionId: "v1", sourceSha256: "old", capturedAt: "2026-01-01", capturedBy: "Иванов", stale: false }] }];
    item.documentVersions = [{ documentId: "doc", versionId: "v1", fileName: "old.pdf", mimeType: "application/pdf", sizeBytes: 1, sha256: "old", source: "Заказчик", addedAt: "2026-01-01", extractionEngineVersion: "1", processingStatus: "Обработан", warnings: [], extractedText: "", fragments: [] }];
    const replaced = replaceDocumentVersion(item, { ...item.documentVersions[0], versionId: "v2", fileName: "new.pdf", sha256: "new" });
    expect(replaced.requirements[0].evidenceLinks[0].stale).toBe(true);
    expect(replaced.documentVersions[1].supersedesVersionId).toBe("v1");
  });

  it("calculates cash gap and participation economics deterministically", () => {
    const flow = cashFlowSummary([
      { id: "2", date: "2026-02-01", title: "Оплата", category: "Платёж заказчика", amount: 150, confirmed: true },
      { id: "1", date: "2026-01-01", title: "Подрядчик", category: "Подрядчик", amount: -100, confirmed: true },
    ]);
    expect(flow).toMatchObject({ maximumCashGap: 100, maximumCashGapDate: "2026-01-01", closingBalance: 50 });
    const finance = scenarioFinancials({ id: "s", name: "Самостоятельно", model: "Самостоятельно", customerPriceGross: 122, vatRate: 22, directCosts: 60, overheadCosts: 10, financingCosts: 5, partnerShare: 0, minimumPrice: 100, selected: true });
    expect(finance).toMatchObject({ priceNet: 100, outputVat: 22, fullCosts: 75, profit: 25, margin: 25, headroom: 22 });
  });

  it("detects resource conflicts, contractual rules and incomplete application", () => {
    expect(resourceConflicts([
      { id: "a", staffSnapshotId: "employee", title: "Проект 1", role: "Инженер", startDate: "2026-01-01", endDate: "2026-02-01", loadPercent: 60, availabilityConfirmed: true },
      { id: "b", staffSnapshotId: "employee", title: "Проект 2", role: "Инженер", startDate: "2026-01-15", endDate: "2026-03-01", loadPercent: 60, availabilityConfirmed: false },
    ])).toHaveLength(1);
    expect(detectContractRisks("Заказчик вправе изменить объём. Оплата через 120 календарных дней.").map((risk) => risk.ruleId)).toEqual(["unilateral-scope", "payment-delay"]);
    const item = emptyProcurement(); item.checklist = [{ id: "c", text: "КП", done: false, responsible: "", dueDate: "", mandatory: true, fileVersionId: "", validation: "", approvedBy: "" }];
    expect(applicationCompleteness(item)).toMatchObject({ ready: false, missing: ["КП"] });
  });
});
