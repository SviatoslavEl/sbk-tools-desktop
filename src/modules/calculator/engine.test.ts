import { describe, expect, it } from "vitest";
import {
  calculate,
  competitorComparablePrice,
  costBreakdown,
  recommendPrice,
  solveTarget,
  toGross,
  toNet,
} from "./engine";
import {
  CalculatorImportError,
  initialCalculatorData,
  migrateCalculatorData,
  type CalculatorData,
  type VatRate,
} from "./types";

const data = (patch: Partial<CalculatorData> = {}): CalculatorData => ({
  ...initialCalculatorData,
  expenses: [],
  subcontractors: [],
  competitors: [],
  ...patch,
});

const competitorNoVat = {
  id: "one", name: "Конкурент на УСН", price: 1_000_000, vatRate: 0 as const,
  amountType: "without-vat" as const, taxRegime: "no-vat" as const, adjustmentPercent: 0,
};

describe("calculator engine VAT model", () => {
  it("blocks a calculation with a negative direct cost instead of silently clamping it", () => {
    const result = calculate(data({ cost: -1 }));
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ field: "cost", blocking: true }));
  });

  it.each([0, 5, 7, 10, 11, 20, 22] satisfies VatRate[])(
    "round-trips VAT rate %s%%",
    (rate) => {
      const gross = toGross(100, rate);
      expect(toNet(gross, rate, "with-vat")).toBeCloseTo(100, 8);
    },
  );

  it("distinguishes deductible VAT from a real cost", () => {
    const deductible = costBreakdown(122, 22, "with-vat", "vat-payer", true);
    const nonDeductible = costBreakdown(122, 22, "with-vat", "vat-payer", false);
    expect(deductible.netAmount).toBeCloseTo(100, 8);
    expect(deductible.deductibleVat).toBeCloseTo(22, 8);
    expect(deductible.effectiveCost).toBeCloseTo(100, 8);
    expect(nonDeductible.effectiveCost).toBeCloseTo(122, 8);
  });

  it("accounts for a VAT subcontractor and a no-VAT subcontractor", () => {
    const result = calculate(data({
      mode: "price-to-margin",
      proposedPrice: 2_000,
      priceAmountType: "without-vat",
      cost: 0,
      subcontractors: [
        {
          id: "vat", name: "ОСНО", amount: 122, amountType: "with-vat", vatRate: 22,
          taxRegime: "vat-payer", inputVatDeductible: true, includeInTotalCost: true,
        },
        {
          id: "usn", name: "УСН", amount: 100, amountType: "without-vat", vatRate: 0,
          taxRegime: "no-vat", inputVatDeductible: false, includeInTotalCost: true,
        },
      ],
    }));
    expect(result.directCosts).toBeCloseTo(200, 8);
    expect(result.inputVatDeductible).toBeCloseTo(22, 8);
    expect(result.fullCosts).toBeCloseTo(200, 8);
  });

  it("includes a fixed expense with and without deductible VAT correctly", () => {
    const baseExpense = {
      id: "expense", name: "Логистика", category: "Прочее", type: "fixed" as const,
      value: 122, percentBase: "cost" as const, percentPriceBase: "net" as const,
      enabled: true, comment: "", amountType: "with-vat" as const, vatRate: 22 as const,
      taxRegime: "vat-payer" as const, includeInTotalCost: true,
    };
    const deductible = calculate(data({
      mode: "price-to-margin", proposedPrice: 1_000, priceAmountType: "without-vat", cost: 0,
      expenses: [{ ...baseExpense, inputVatDeductible: true }],
    }));
    const nonDeductible = calculate(data({
      mode: "price-to-margin", proposedPrice: 1_000, priceAmountType: "without-vat", cost: 0,
      expenses: [{ ...baseExpense, inputVatDeductible: false }],
    }));
    expect(deductible.additionalCosts).toBeCloseTo(100, 8);
    expect(nonDeductible.additionalCosts).toBeCloseTo(122, 8);
  });
});

describe("target solver", () => {
  it("reaches the requested margin with fixed expenses", () => {
    const result = calculate(data({
      expenses: [
        { ...initialCalculatorData.expenses[0], value: 45_000 },
        { ...initialCalculatorData.expenses[1], value: 30_000 },
      ],
      targetValue: 20,
    }));
    expect(result.valid).toBe(true);
    expect(result.margin).toBeCloseTo(20, 5);
    expect(result.additionalCosts).toBe(75_000);
  });

  it("solves a percentage expense based on contract price", () => {
    const result = calculate(data({
      expenses: [{
        ...initialCalculatorData.expenses[0],
        type: "percent",
        percentBase: "contract-price",
        percentPriceBase: "net",
        value: 2,
      }],
      targetValue: 20,
    }));
    expect(result.valid).toBe(true);
    expect(result.margin).toBeCloseTo(20, 5);
    expect(result.additionalCosts).toBeCloseTo(result.priceNet * 0.02, 6);
  });

  it("returns a structured error for a mathematically unreachable margin", () => {
    const solution = solveTarget(data({
      targetType: "margin",
      targetValue: 20,
      expenses: [{
        ...initialCalculatorData.expenses[0],
        name: "Комиссия площадки",
        type: "percent",
        percentBase: "contract-price",
        percentPriceBase: "net",
        value: 90,
      }],
    }));
    expect(solution.ok).toBe(false);
    if (!solution.ok) {
      expect(solution.issue.code).toBe("unreachable-target");
      expect(solution.issue.limitingCost).toContain("Комиссия площадки");
    }
    const result = calculate(data({
      targetType: "margin",
      targetValue: 20,
      expenses: [{
        ...initialCalculatorData.expenses[0],
        type: "percent",
        percentBase: "contract-price",
        percentPriceBase: "net",
        value: 90,
      }],
    }));
    expect(result.valid).toBe(false);
    expect(result.priceGross).toBe(0);
  });

  it("supports markup above 100 percent", () => {
    const result = calculate(data({ targetType: "markup", targetValue: 150 }));
    expect(result.valid).toBe(true);
    expect(result.markup).toBeCloseTo(150, 5);
  });

  it("calculates a negative target instead of silently clamping it", () => {
    const result = calculate(data({ targetType: "margin", targetValue: -20 }));
    expect(result.valid).toBe(true);
    expect(result.margin).toBeCloseTo(-20, 5);
    expect(result.profit).toBeLessThan(0);
  });

  it("blocks inconsistent warning thresholds", () => {
    const result = calculate(data({ minMargin: 15, warningMargin: 10 }));
    expect(result.valid).toBe(false);
    expect(result.issues[0].code).toBe("invalid-thresholds");
  });
});

describe("competitor recommendation", () => {
  it("keeps a no-VAT competitor at the actual one-million gross offer", () => {
    expect(competitorComparablePrice(competitorNoVat, "gross")).toBe(1_000_000);
    const recommendation = recommendPrice(data({
      priceVatRate: 22,
      comparisonBasis: "gross",
      competitors: [competitorNoVat],
    }));
    expect(recommendation).not.toBeNull();
    expect(recommendation!.lowestCompetitor).toBe(1_000_000);
    expect(recommendation!.basisLabel).toContain("полная цена");
  });

  it("keeps gross and net comparison bases explicit", () => {
    const competitor = {
      ...competitorNoVat,
      price: 1_220_000,
      vatRate: 22 as const,
      amountType: "with-vat" as const,
      taxRegime: "vat-payer" as const,
    };
    expect(competitorComparablePrice(competitor, "gross")).toBe(1_220_000);
    expect(competitorComparablePrice(competitor, "net")).toBeCloseTo(1_000_000, 8);
  });
});

describe("financing and compatibility", () => {
  it("includes a 1.3 percent monthly financing commission in full costs", () => {
    const withoutFinancing = calculate(data({
      mode: "price-to-margin", proposedPrice: 1_000_000, priceAmountType: "without-vat", cost: 0,
    }));
    const withFinancing = calculate(data({
      mode: "price-to-margin", proposedPrice: 1_000_000, priceAmountType: "without-vat", cost: 0,
      priceVatRate: 0,
      financingEnabled: true,
      paymentDelayDays: 30,
      annualFinancingRate: 1.3,
      financingRatePeriod: "monthly",
    }));
    expect(withoutFinancing.financingCost).toBe(0);
    expect(withFinancing.financingCost).toBeCloseTo(13_000, 8);
    expect(withFinancing.profit).toBeCloseTo(987_000, 8);
  });

  it("calculates own work, subcontracting and partner scenarios separately", () => {
    const own = calculate(data({ mode: "price-to-margin", proposedPrice: 1_000, priceAmountType: "without-vat", priceVatRate: 0, cost: 400 }));
    const subcontractor = calculate(data({ mode: "price-to-margin", proposedPrice: 1_000, priceAmountType: "without-vat", priceVatRate: 0, cost: 0, subcontractors: [{ id: "s", name: "Подрядчик", amount: 500, amountType: "without-vat", vatRate: 0, taxRegime: "no-vat", inputVatDeductible: false, includeInTotalCost: true }] }));
    const partner = calculate(data({ mode: "price-to-margin", proposedPrice: 1_000, priceAmountType: "without-vat", priceVatRate: 0, cost: 0, hasAgent: true, agentType: "percent", agentValue: 20 }));
    expect(own.profit).toBe(600);
    expect(subcontractor.profit).toBe(500);
    expect(partner.profit).toBe(800);
  });

  it("uses staged payments and validates their total share", () => {
    const staged = calculate(data({ mode: "price-to-margin", proposedPrice: 1_000, priceAmountType: "without-vat", priceVatRate: 0, cost: 0, financingEnabled: true, annualFinancingRate: 12, paymentStages: [{ id: "1", name: "Аванс", sharePercent: 50, delayDays: 0, plannedDate: "2026-01-01" }, { id: "2", name: "Финал", sharePercent: 50, delayDays: 365, plannedDate: "2027-01-01" }] }));
    expect(staged.financingCost).toBeCloseTo(60, 8);
    expect(calculate(data({ paymentStages: [{ id: "1", name: "Не всё", sharePercent: 80, delayDays: 0, plannedDate: "" }] })).valid).toBe(false);
  });

  it("converts an offline currency component at the user supplied rate", () => {
    const result = calculate(data({ mode: "price-to-margin", proposedPrice: 2_000, priceAmountType: "without-vat", priceVatRate: 0, cost: 0, currencyComponentEnabled: true, foreignCurrency: "USD", foreignAmount: 10, exchangeRate: 90 }));
    expect(result.currencyCost).toBe(900);
    expect(result.profit).toBe(1_100);
  });

  it("migrates a version 1.0.1 calculation without dropping arrays", () => {
    const migrated = migrateCalculatorData({
      name: "Старый расчёт",
      cost: 500_000,
      costVatRate: 0,
      costAmountType: "without-vat",
      expenses: [{ id: "e", name: "Доставка", category: "Логистика", type: "fixed", value: 10_000, percentBase: "cost", enabled: true, comment: "" }],
      subcontractors: [],
      competitors: [competitorNoVat],
      paymentRiskEnabled: true,
      paymentRiskPercent: 1.3,
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.expenses).toHaveLength(1);
    expect(migrated.competitors).toHaveLength(1);
    expect(migrated.financingEnabled).toBe(true);
    expect(calculate(migrated).valid).toBe(true);
  });

  it("rejects malformed arrays and unknown enum values in imported files", () => {
    expect(() => migrateCalculatorData({ expenses: null, competitors: "broken" }, true))
      .toThrow(CalculatorImportError);
    expect(() => migrateCalculatorData({ expenses: [], competitors: [], subcontractors: [], mode: "mystery" }, true))
      .toThrow(/неизвестное значение/);
  });
});
