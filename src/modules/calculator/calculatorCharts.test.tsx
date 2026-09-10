import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CalculatorCharts } from "./Calculator";
import { calculate, priceScenarios } from "./engine";
import { initialCalculatorData, type CalculatorData } from "./types";

const data = (patch: Partial<CalculatorData> = {}): CalculatorData => ({
  ...initialCalculatorData,
  cost: 2_500_000,
  mode: "margin-to-price",
  targetType: "margin",
  targetValue: 20,
  expenses: [],
  subcontractors: [],
  competitors: [],
  ...patch,
});

function renderCharts(input: CalculatorData, active: "structure" | "scenario" | "competitors" = "structure", valid?: boolean) {
  const result = calculate(input);
  return renderToStaticMarkup(<CalculatorCharts data={input} result={result} valid={valid} scenarios={priceScenarios(input)} active={active} onActive={vi.fn()} />);
}

describe("calculator chart validation state", () => {
  it.each(["structure", "scenario", "competitors"] as const)("replaces the %s chart with a clear explanation for an impossible 100%% margin", (active) => {
    const input = data({ targetValue: 100 });
    const result = calculate(input);
    expect(result.valid).toBe(false);
    const html = renderCharts(input, active);
    expect(html).toContain('role="status"');
    expect(html).toContain("Исправьте исходные данные");
    expect(html).toContain("Графики и пояснения появятся после корректного расчёта цены");
    expect(html).not.toContain("Из каждых 100");
    expect(html).not.toContain("При текущей цене прибыль составляет");
    expect(html).not.toContain("Наше предложение");
    expect(html).not.toMatch(/class="stacked-bar"|class="line-chart"|class="competitor-chart"|NaN|Infinity/);
  });

  it("also hides a previous valid chart while a numeric field contains invalid uncommitted text", () => {
    const input = data();
    expect(calculate(input).valid).toBe(true);
    const html = renderCharts(input, "structure", false);
    expect(html).toContain("Исправьте исходные данные");
    expect(html).toContain("Проверьте неверно заполненные числовые поля");
    expect(html).not.toContain("Из каждых 100");
    expect(html).not.toContain('class="stacked-bar"');
  });

  it("does not let an explicit true flag override an invalid engine result", () => {
    const html = renderCharts(data({ targetValue: 100 }), "structure", true);
    expect(html).toContain("Исправьте исходные данные");
    expect(html).not.toContain('class="stacked-bar"');
  });

  it("restores the unchanged structure chart when the margin is corrected to 20%%", () => {
    expect(renderCharts(data({ targetValue: 100 }))).toContain("Исправьте исходные данные");
    const html = renderCharts(data({ targetValue: 20 }));
    expect(html).toContain('class="stacked-bar"');
    expect(html).toContain("Из каждых 100");
    expect(html).toContain("остаются прибылью");
    expect(html).not.toContain("Исправьте исходные данные");
    expect(html).not.toMatch(/NaN|Infinity/);
  });

  it("keeps the valid price/profit and competitor charts available", () => {
    const input = data({ competitors: [{ id: "qa", name: "Компания QA", price: 4_000_000, vatRate: 0, amountType: "without-vat", taxRegime: "no-vat", adjustmentPercent: 0 }] });
    const scenario = renderCharts(input, "scenario");
    expect(scenario).toContain('class="line-chart"');
    expect(scenario).toContain("При текущей цене прибыль составляет");
    const competitors = renderCharts(input, "competitors");
    expect(competitors).toContain('class="competitor-chart"');
    expect(competitors).toContain("Компания QA");
    expect(competitors).toContain("Наше предложение");
    expect(competitors).not.toContain("Исправьте исходные данные");
  });
});
