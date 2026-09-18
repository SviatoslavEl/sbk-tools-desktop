import { describe, expect, it } from "vitest";
import { applicationCompleteness, cashFlowSummary, confirmGoNoGo, procurementWarnings, resourceConflicts } from "./domain";
import { emptyChecklist, emptyProcurement, emptyRequirement, emptyResourceAllocation, normalizeProcurement, withResultFinancials } from "./types";
describe("procurement audit regressions", () => {
  it("recalculates persisted result from price and cost, not saved derivatives", () => {
    const item = emptyProcurement();
    const first = withResultFinancials({ ...item.resultDetails, finalPrice:1_000_000, actualCosts:700_000 });
    expect(first.actualProfit).toBe(300_000);
    const changed = withResultFinancials({ ...first, finalPrice:1_200_000 });
    expect(changed.actualProfit).toBe(500_000);
    expect(changed.actualMargin).toBeCloseTo(41.6666667);
    const loaded = normalizeProcurement({ ...item, resultDetails:{...first, finalPrice:1_200_000} });
    expect(loaded.resultDetails.actualProfit).toBe(500_000);
    expect(withResultFinancials({...first, finalPrice:0}).actualMargin).toBe(0);
  });
  it("does not call a blank or unassessed application ready", () => {
    expect(applicationCompleteness(emptyProcurement())).toMatchObject({ready:false, unassessed:true});
    const base = emptyProcurement();
    const item = confirmGoNoGo({ ...base, name:"Закупка", customer:"Заказчик", subject:"Услуги", nmc:100, submissionDeadline:"2026-10-01", goNoGoCriteria:base.goNoGoCriteria.map((criterion) => ({...criterion,status:"Соответствует"})), requirements:[{...emptyRequirement(),text:"Квалификация",status:"Подтверждено"}], checklist:[{...emptyChecklist(),text:"Необязательное приложение",mandatory:false}] }, "Участвовать", "Иванов", "Проверено");
    expect(applicationCompleteness(item).ready).toBe(true);
    expect(applicationCompleteness({...item, requirements:[{...item.requirements[0],status:"Не подтверждено"}]}).ready).toBe(false);
    expect(applicationCompleteness({...item,goNoGoDecision:{...item.goNoGoDecision,requiresReview:true}}).ready).toBe(false);
    expect(applicationCompleteness({...item,checklist:[{...item.checklist[0],done:true,fileVersionId:"missing"}]}).invalidFiles).toHaveLength(1);
  });
  it("counts simultaneous group allocations rather than only pairs", () => {
    const entries = ["a","b","c"].map((id) => ({...emptyResourceAllocation(),id,staffSnapshotId:"employee",title:"Иванов",startDate:"2026-10-01",endDate:"2026-10-31",loadPercent:40}));
    expect(resourceConflicts(entries)).toHaveLength(1);
    expect(resourceConflicts(entries)[0].reason).toContain("120%");
    expect(resourceConflicts(entries.map((entry,index) => ({...entry,startDate:`2026-10-0${index*2+1}`,endDate:`2026-10-0${index*2+2}`})))).toHaveLength(0);
  });
  it("calculates same-day cash gap independently of event identifiers/order", () => {
    const credit = {id:"a",date:"2026-10-01",title:"Платёж",category:"Платёж заказчика" as const,amount:100,confirmed:true};
    const debit = {...credit,id:"z",amount:-90};
    expect(cashFlowSummary([debit,credit]).maximumCashGap).toBe(0);
    expect(cashFlowSummary([{...credit,id:"z"},{...debit,id:"a"}])).toMatchObject({maximumCashGap:0,closingBalance:10});
    expect(cashFlowSummary([{...debit,date:""}])).toMatchObject({undatedEvents:1,closingBalance:0});
  });
  it("rejects invalid costs and reversed resource dates at save boundary", () => {
    const base = emptyProcurement();
    expect(procurementWarnings({...base,resultDetails:{...base.resultDetails,actualCosts:-1}}).some((warning) => warning.startsWith("Некорректно"))).toBe(true);
    expect(procurementWarnings({...base,resourcePlan:[{...emptyResourceAllocation(),startDate:"2026-10-02",endDate:"2026-10-01"}]}).some((warning) => warning.includes("ресурсный план"))).toBe(true);
  });
});
