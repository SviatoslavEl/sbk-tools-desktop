import { describe, expect, it } from "vitest";
import { calculate, recommendPrice, toGross, toNet } from "./engine";
import { initialCalculatorData } from "./types";

describe("calculator engine", () => {
  it("converts VAT amounts deterministically", () => {
    expect(toNet(122, 22, "with-vat")).toBeCloseTo(100, 8);
    expect(toGross(100, 22)).toBeCloseTo(122, 8);
  });

  it("reaches the requested margin with fixed expenses", () => {
    const result = calculate({ ...initialCalculatorData, targetValue: 20 });
    expect(result.margin).toBeCloseTo(20, 6);
    expect(result.expensesTotal).toBe(75_000);
    expect(result.profit).toBeGreaterThan(0);
  });

  it("solves expenses based on contract price without circular errors", () => {
    const data = {
      ...initialCalculatorData,
      expenses: [{
        ...initialCalculatorData.expenses[0],
        type: "percent" as const,
        percentBase: "contract-price" as const,
        value: 2,
      }],
    };
    const result = calculate(data);
    expect(result.margin).toBeCloseTo(20, 6);
    expect(result.expensesTotal).toBeCloseTo(result.priceNet * 0.02, 6);
  });

  it("marks a loss as danger", () => {
    const result = calculate({
      ...initialCalculatorData,
      mode: "price-to-margin",
      proposedPrice: 100_000,
      priceAmountType: "without-vat",
    });
    expect(result.profit).toBeLessThan(0);
    expect(result.status).toBe("danger");
  });

  it("recommends a competitive price without crossing the minimum margin", () => {
    const recommendation = recommendPrice({
      ...initialCalculatorData,
      competitors: [{ id: "one", name: "Конкурент", price: 2_000_000, vatRate: 22, amountType: "with-vat" }],
    });
    expect(recommendation).not.toBeNull();
    expect(recommendation!.priceGross).toBeLessThan(2_000_000);
    expect(recommendation!.margin).toBeGreaterThanOrEqual(initialCalculatorData.minMargin - 0.001);
  });
});
