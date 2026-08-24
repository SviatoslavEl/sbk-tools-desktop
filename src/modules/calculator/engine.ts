import type {
  AmountType,
  CalculationResult,
  CalculatorData,
  ExpenseResult,
  VatRate,
} from "./types";

export const toNet = (amount: number, vatRate: VatRate, type: AmountType) =>
  type === "with-vat" ? amount / (1 + vatRate / 100) : amount;

export const toGross = (amount: number, vatRate: VatRate) => amount * (1 + vatRate / 100);

function expensesAtPrice(data: CalculatorData, costNet: number, priceNet: number): ExpenseResult[] {
  return data.expenses.map((expense) => {
    if (!expense.enabled) return { ...expense, amount: 0, explanation: "Не учитывается" };
    if (expense.type === "fixed") {
      return { ...expense, amount: Math.max(0, expense.value), explanation: "Фиксированная сумма" };
    }
    const base = expense.percentBase === "contract-price"
      ? priceNet
      : expense.percentBase === "custom"
        ? Math.max(0, expense.customBase || 0)
        : costNet;
    const label = expense.percentBase === "contract-price"
      ? "цены контракта без НДС"
      : expense.percentBase === "custom"
        ? "указанной базы"
        : "себестоимости без НДС";
    return {
      ...expense,
      amount: base * Math.max(0, expense.value) / 100,
      explanation: `${expense.value}% от ${label}`,
    };
  });
}

function resultAtPrice(data: CalculatorData, priceNet: number): CalculationResult {
  const internalCostNet = toNet(data.cost, data.costVatRate, data.costAmountType);
  const subcontractorsNet = data.subcontractors.reduce(
    (sum, item) => sum + toNet(item.amount, item.vatRate, item.amountType),
    0,
  );
  const expenseResults = expensesAtPrice(data, internalCostNet + subcontractorsNet, priceNet);
  const expensesTotal = expenseResults.reduce((sum, expense) => sum + expense.amount, 0);
  const priceGross = toGross(priceNet, data.priceVatRate);
  const agentCommission = !data.hasAgent
    ? 0
    : data.agentType === "fixed"
      ? Math.max(0, data.agentValue)
      : (data.agentPercentBase === "gross" ? priceGross : priceNet) * Math.max(0, data.agentValue) / 100;
  const totalCost = internalCostNet + subcontractorsNet + expensesTotal + agentCommission;
  const profit = priceNet - totalCost;
  const margin = priceNet > 0 ? profit / priceNet * 100 : 0;
  const markup = totalCost > 0 ? profit / totalCost * 100 : 0;
  const profitability = internalCostNet + subcontractorsNet > 0
    ? profit / (internalCostNet + subcontractorsNet) * 100
    : 0;
  const effectiveMargin = margin - (data.paymentRiskEnabled ? Math.max(0, data.paymentRiskPercent) : 0);
  const status = profit < 0 || effectiveMargin < data.minMargin
    ? "danger"
    : effectiveMargin < data.warningMargin ? "warning" : "success";
  return {
    priceNet,
    priceGross,
    vatAmount: priceGross - priceNet,
    internalCostNet,
    subcontractorsNet,
    expensesTotal,
    agentCommission,
    profit,
    margin,
    effectiveMargin,
    markup,
    profitability,
    taxes: priceGross - priceNet,
    status,
    expenseResults,
  };
}

function solveTarget(data: CalculatorData): number {
  const baseCost = toNet(data.cost, data.costVatRate, data.costAmountType)
    + data.subcontractors.reduce((sum, item) => sum + toNet(item.amount, item.vatRate, item.amountType), 0);
  let low = Math.max(0, baseCost);
  let high = Math.max(1, baseCost * 2);
  const target = Math.max(-99, Math.min(95, data.targetValue));
  const metric = (price: number) => {
    const result = resultAtPrice(data, price);
    return data.targetType === "margin" ? result.margin : result.markup;
  };
  let attempts = 0;
  while (metric(high) < target && attempts < 32) {
    high *= 2;
    attempts += 1;
  }
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (low + high) / 2;
    if (metric(middle) < target) low = middle;
    else high = middle;
  }
  return high;
}

export function calculate(data: CalculatorData): CalculationResult {
  const priceNet = data.mode === "margin-to-price"
    ? solveTarget(data)
    : toNet(data.proposedPrice, data.priceVatRate, data.priceAmountType);
  return resultAtPrice(data, Math.max(0, priceNet));
}

export function recommendPrice(data: CalculatorData) {
  const competitors = data.competitors
    .filter((item) => item.price > 0)
    .map((item) => toGross(toNet(item.price, item.vatRate, item.amountType), data.priceVatRate));
  if (!competitors.length) return null;
  const lowestCompetitor = Math.min(...competitors);
  const protectedData: CalculatorData = {
    ...data,
    mode: "margin-to-price",
    targetType: "margin",
    targetValue: Math.min(95, data.minMargin + (data.paymentRiskEnabled ? data.paymentRiskPercent : 0)),
  };
  const floor = toGross(solveTarget(protectedData), data.priceVatRate);
  const competitive = Math.max(0, lowestCompetitor - Math.max(1000, lowestCompetitor * 0.005));
  const priceGross = Math.max(floor, competitive);
  const result = resultAtPrice(data, toNet(priceGross, data.priceVatRate, "with-vat"));
  return {
    priceGross,
    lowestCompetitor,
    protectedFloor: floor,
    margin: result.margin,
    limitedByMargin: floor >= competitive,
  };
}

export function priceScenarios(data: CalculatorData, points = 9) {
  const current = calculate(data).priceNet;
  return Array.from({ length: points }, (_, index) => {
    const factor = 0.8 + index * (0.4 / Math.max(1, points - 1));
    const result = resultAtPrice(data, current * factor);
    return { price: result.priceNet, profit: result.profit, margin: result.margin };
  });
}
