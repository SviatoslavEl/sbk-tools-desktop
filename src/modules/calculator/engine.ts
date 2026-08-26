import type {
  AmountType,
  CalculationIssue,
  CalculationResult,
  CalculatorData,
  ComparisonBasis,
  Competitor,
  CostBreakdown,
  ExpenseResult,
  TaxRegime,
  VatRate,
} from "./types";

const EPSILON = 1e-7;
const MAX_PRICE = 1_000_000_000_000;
const TARGET_TOLERANCE = 1e-5;

export const toNet = (amount: number, vatRate: VatRate, type: AmountType) =>
  type === "with-vat" ? amount / (1 + vatRate / 100) : amount;

export const toGross = (amount: number, vatRate: VatRate) => amount * (1 + vatRate / 100);

export function costBreakdown(
  quotedAmount: number,
  vatRate: VatRate,
  amountType: AmountType,
  taxRegime: TaxRegime,
  inputVatDeductible: boolean,
  includeInTotalCost = true,
): CostBreakdown {
  const safeAmount = Math.max(0, Number.isFinite(quotedAmount) ? quotedAmount : 0);
  const effectiveRate = taxRegime === "vat-payer" ? vatRate : 0;
  const netAmount = toNet(safeAmount, effectiveRate, amountType);
  const grossAmount = amountType === "with-vat" ? safeAmount : toGross(safeAmount, effectiveRate);
  const inputVat = Math.max(0, grossAmount - netAmount);
  const deductibleVat = inputVatDeductible && taxRegime === "vat-payer" ? inputVat : 0;
  return {
    quotedAmount: safeAmount,
    netAmount,
    grossAmount,
    inputVat,
    deductibleVat,
    effectiveCost: includeInTotalCost ? grossAmount - deductibleVat : 0,
  };
}

function expenseResultsAtPrice(
  data: CalculatorData,
  directCostBase: number,
  priceNet: number,
  priceGross: number,
): ExpenseResult[] {
  return data.expenses.map((expense) => {
    if (!expense.enabled) {
      return {
        ...expense,
        ...costBreakdown(0, expense.vatRate, expense.amountType, expense.taxRegime, expense.inputVatDeductible, false),
        amount: 0,
        explanation: "Не учитывается",
      };
    }
    let amount = Math.max(0, expense.value);
    let explanation = "Фиксированная сумма";
    if (expense.type === "percent") {
      const base = expense.percentBase === "contract-price"
        ? expense.percentPriceBase === "gross" ? priceGross : priceNet
        : expense.percentBase === "custom"
          ? Math.max(0, expense.customBase || 0)
          : directCostBase;
      const label = expense.percentBase === "contract-price"
        ? `цены контракта ${expense.percentPriceBase === "gross" ? "с НДС" : "без НДС"}`
        : expense.percentBase === "custom"
          ? "указанной базы"
          : "прямых затрат";
      amount = base * Math.max(0, expense.value) / 100;
      explanation = `${expense.value}% от ${label}`;
    }
    const breakdown = costBreakdown(
      amount,
      expense.vatRate,
      expense.amountType,
      expense.taxRegime,
      expense.inputVatDeductible,
      expense.includeInTotalCost,
    );
    return { ...expense, ...breakdown, amount, explanation };
  });
}

function financingCostAtPrice(data: CalculatorData, directCosts: number, priceGross: number) {
  if (!data.financingEnabled) return 0;
  const financingRate = Math.max(0, data.annualFinancingRate) / 100;
  const stages = data.paymentStages.length ? data.paymentStages : [{ sharePercent: 100 - Math.max(0, Math.min(100, data.advancePercent)), delayDays: data.paymentDelayDays }];
  const financing = stages.reduce((sum, stage) => {
    const financedAmount = priceGross * Math.max(0, stage.sharePercent) / 100;
    const delayDays = Math.max(0, stage.delayDays);
    return sum + (data.financingRatePeriod === "monthly" ? financedAmount * financingRate * delayDays / 30 : financedAmount * financingRate * delayDays / 365);
  }, 0);
  const financedAmount = priceGross * Math.max(0, stages.reduce((sum, stage) => sum + stage.sharePercent, 0)) / 100;
  const factoring = data.factoringEnabled
    ? financedAmount * Math.max(0, data.factoringCommissionPercent) / 100
    : 0;
  const guarantees = Math.max(0, data.bidGuaranteeCost)
    + Math.max(0, data.performanceGuaranteeCost)
    + Math.max(0, data.advanceGuaranteeCost);
  const reserve = directCosts * Math.max(0, data.costGrowthReservePercent) / 100;
  return financing + factoring + guarantees + reserve;
}

function validationIssues(data: CalculatorData): CalculationIssue[] {
  const issues: CalculationIssue[] = [];
  if (data.warningMargin < data.minMargin) {
    issues.push({
      code: "invalid-thresholds",
      field: "warningMargin",
      blocking: true,
      message: "Зона предупреждения не может быть ниже минимальной маржи.",
    });
  }
  if (!Number.isFinite(data.targetValue)) {
    issues.push({
      code: "invalid-target",
      field: "targetValue",
      blocking: true,
      message: "Целевой показатель должен быть конечным числом.",
    });
  }
  const stageShare = data.paymentStages.reduce((sum, stage) => sum + stage.sharePercent, 0);
  if (data.paymentStages.length && Math.abs(stageShare - 100) > 0.001) issues.push({ code: "invalid-data", field: "paymentStages", blocking: true, message: `Сумма долей графика платежей должна быть 100%, сейчас ${stageShare.toFixed(2)}%.` });
  if (data.currencyComponentEnabled && (data.foreignAmount < 0 || data.exchangeRate <= 0)) issues.push({ code: "invalid-data", field: "exchangeRate", blocking: true, message: "Для валютной составляющей укажите положительные сумму и курс." });
  return issues;
}

function resultAtPrice(
  data: CalculatorData,
  priceNet: number,
  extraIssues: CalculationIssue[] = [],
): CalculationResult {
  const safePriceNet = Math.max(0, Number.isFinite(priceNet) ? priceNet : 0);
  const priceGross = toGross(safePriceNet, data.priceVatRate);
  const internal = costBreakdown(
    data.cost,
    data.costVatRate,
    data.costAmountType,
    data.costTaxRegime,
    data.costInputVatDeductible,
    data.costIncludeInTotalCost,
  );
  const subcontractors = data.subcontractors.map((item) => costBreakdown(
    item.amount,
    item.vatRate,
    item.amountType,
    item.taxRegime,
    item.inputVatDeductible,
    item.includeInTotalCost,
  ));
  const subcontractorsNet = subcontractors.reduce((sum, item) => sum + item.netAmount, 0);
  const directCosts = internal.effectiveCost
    + subcontractors.reduce((sum, item) => sum + item.effectiveCost, 0);
  const currencyCost = data.currencyComponentEnabled ? Math.max(0, data.foreignAmount) * Math.max(0, data.exchangeRate) : 0;
  const expenseResults = expenseResultsAtPrice(data, directCosts, safePriceNet, priceGross);
  const additionalCosts = expenseResults.reduce((sum, expense) => sum + expense.effectiveCost, 0);
  const agentQuotedAmount = !data.hasAgent
    ? 0
    : data.agentType === "fixed"
      ? Math.max(0, data.agentValue)
      : (data.agentPercentBase === "gross" ? priceGross : safePriceNet) * Math.max(0, data.agentValue) / 100;
  const agent = costBreakdown(
    agentQuotedAmount,
    data.agentVatRate,
    data.agentAmountType,
    data.agentTaxRegime,
    data.agentInputVatDeductible,
    data.hasAgent && data.agentIncludeInTotalCost,
  );
  const financingCost = financingCostAtPrice(data, directCosts + currencyCost, priceGross);
  const fullCosts = directCosts + currencyCost + additionalCosts + agent.effectiveCost + financingCost;
  const profit = safePriceNet - fullCosts;
  const margin = safePriceNet > EPSILON ? profit / safePriceNet * 100 : profit < 0 ? -Infinity : 0;
  const markup = fullCosts > EPSILON ? profit / fullCosts * 100 : profit > 0 ? Infinity : 0;
  const profitability = fullCosts > EPSILON ? profit / fullCosts * 100 : 0;
  const outputVat = priceGross - safePriceNet;
  const inputVatDeductible = internal.deductibleVat
    + subcontractors.reduce((sum, item) => sum + item.deductibleVat, 0)
    + expenseResults.reduce((sum, item) => sum + item.deductibleVat, 0)
    + agent.deductibleVat;
  const issues = [...validationIssues(data), ...extraIssues];
  const valid = !issues.some((issue) => issue.blocking);
  const status = !valid || profit < 0 || margin < data.minMargin
    ? "danger"
    : margin < data.warningMargin ? "warning" : "success";
  return {
    valid,
    issues,
    priceNet: safePriceNet,
    priceGross,
    outputVat,
    inputVatDeductible,
    vatPayable: outputVat - inputVatDeductible,
    vatAmount: outputVat,
    internalCostNet: internal.netAmount,
    subcontractorsNet,
    directCosts,
    expensesTotal: additionalCosts,
    additionalCosts,
    agentCommission: agent.effectiveCost,
    financingCost,
    currencyCost,
    fullCosts,
    totalCost: fullCosts,
    profit,
    margin,
    effectiveMargin: margin,
    markup,
    profitability,
    taxes: outputVat - inputVatDeductible,
    status,
    expenseResults,
  };
}

export type TargetSolution = {
  ok: true;
  priceNet: number;
  achievedValue: number;
} | {
  ok: false;
  issue: CalculationIssue;
};

function limitingVariableCost(data: CalculatorData): { rate: number; label: string } {
  const firstPrice = 10_000_000;
  const secondPrice = 20_000_000;
  const first = resultAtPrice(data, firstPrice).fullCosts;
  const second = resultAtPrice(data, secondPrice).fullCosts;
  const rate = Math.max(0, (second - first) / (secondPrice - firstPrice));
  const candidates: Array<[number, string]> = [];
  for (const expense of data.expenses) {
    if (expense.enabled && expense.includeInTotalCost && expense.type === "percent" && expense.percentBase === "contract-price") {
      candidates.push([expense.value, `расход «${expense.name}»`]);
    }
  }
  if (data.hasAgent && data.agentIncludeInTotalCost && data.agentType === "percent") {
    candidates.push([data.agentValue, "комиссия агента"]);
  }
  if (data.financingEnabled && data.paymentDelayDays > 0 && data.annualFinancingRate > 0) {
    const financingPercent = data.financingRatePeriod === "monthly"
      ? data.annualFinancingRate * data.paymentDelayDays / 30
      : data.annualFinancingRate * data.paymentDelayDays / 365;
    candidates.push([financingPercent, "стоимость финансирования"]);
  }
  candidates.sort((left, right) => right[0] - left[0]);
  return { rate, label: candidates[0]?.[1] || "процентные расходы" };
}

export function solveTarget(data: CalculatorData): TargetSolution {
  const target = data.targetValue;
  const allowed = data.targetType === "margin"
    ? target > -100 && target < 100
    : target > -100 && target <= 10_000;
  if (!Number.isFinite(target) || !allowed) {
    return {
      ok: false,
      issue: {
        code: "invalid-target",
        field: "targetValue",
        blocking: true,
        message: data.targetType === "margin"
          ? "Маржа должна быть больше −100% и меньше 100%."
          : "Наценка должна быть больше −100% и не выше 10 000%.",
      },
    };
  }
  const { rate, label } = limitingVariableCost(data);
  const maxMargin = (1 - rate) * 100;
  const maxMarkup = rate > EPSILON ? (1 - rate) / rate * 100 : Infinity;
  const ceiling = data.targetType === "margin" ? maxMargin : maxMarkup;
  if (target >= ceiling - TARGET_TOLERANCE) {
    return {
      ok: false,
      issue: {
        code: "unreachable-target",
        blocking: true,
        limitingCost: label,
        message: `Цель ${target.toFixed(2)}% недостижима: ${label} создаёт математический потолок ${ceiling.toFixed(2)}%.`,
      },
    };
  }
  const metric = (price: number) => {
    const result = resultAtPrice(data, price);
    return data.targetType === "margin" ? result.margin : result.markup;
  };
  let low = EPSILON;
  let high = Math.max(1, resultAtPrice(data, 0).fullCosts * 2);
  let attempts = 0;
  while (metric(high) < target && high < MAX_PRICE && attempts < 80) {
    high = Math.min(MAX_PRICE, high * 2);
    attempts += 1;
  }
  if (metric(high) < target) {
    return {
      ok: false,
      issue: {
        code: "unreachable-target",
        blocking: true,
        limitingCost: label,
        message: "Целевая цена не найдена в безопасном диапазоне. Проверьте процентные расходы.",
      },
    };
  }
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (low + high) / 2;
    if (metric(middle) < target) low = middle;
    else high = middle;
  }
  const achievedValue = metric(high);
  if (!Number.isFinite(high) || high >= MAX_PRICE || Math.abs(achievedValue - target) > TARGET_TOLERANCE) {
    return {
      ok: false,
      issue: {
        code: "target-not-converged",
        blocking: true,
        message: "Не удалось подтвердить целевой показатель с требуемой точностью.",
      },
    };
  }
  return { ok: true, priceNet: high, achievedValue };
}

export function calculate(data: CalculatorData): CalculationResult {
  if (data.mode === "price-to-margin") {
    return resultAtPrice(data, toNet(data.proposedPrice, data.priceVatRate, data.priceAmountType));
  }
  const solution = solveTarget(data);
  if (!solution.ok) return resultAtPrice(data, 0, [solution.issue]);
  return resultAtPrice(data, solution.priceNet);
}

export function competitorComparablePrice(competitor: Competitor, basis: ComparisonBasis) {
  const effectiveRate = competitor.taxRegime === "vat-payer" ? competitor.vatRate : 0;
  const net = toNet(competitor.price, effectiveRate, competitor.amountType);
  const gross = competitor.amountType === "with-vat" ? competitor.price : toGross(competitor.price, effectiveRate);
  if (basis === "net") return net;
  if (basis === "adjusted") return gross * (1 + competitor.adjustmentPercent / 100);
  return gross;
}

export interface PriceRecommendation {
  valid: boolean;
  issue?: CalculationIssue;
  basis: ComparisonBasis;
  basisLabel: string;
  priceGross: number;
  lowestCompetitor: number;
  protectedFloor: number;
  margin: number;
  limitedByMargin: boolean;
}

export function recommendPrice(data: CalculatorData): PriceRecommendation | null {
  const competitors = data.competitors
    .filter((item) => Number.isFinite(item.price) && item.price > 0)
    .map((item) => competitorComparablePrice(item, data.comparisonBasis));
  if (!competitors.length) return null;
  const lowestCompetitor = Math.min(...competitors);
  const protectedData: CalculatorData = {
    ...data,
    mode: "margin-to-price",
    targetType: "margin",
    targetValue: data.minMargin,
  };
  const floorSolution = solveTarget(protectedData);
  const basisLabel = data.comparisonBasis === "gross"
    ? "полная цена договора с НДС"
    : data.comparisonBasis === "net"
      ? "цена без НДС"
      : "приведённая цена по пользовательской корректировке";
  if (!floorSolution.ok) {
    return {
      valid: false,
      issue: floorSolution.issue,
      basis: data.comparisonBasis,
      basisLabel,
      priceGross: 0,
      lowestCompetitor,
      protectedFloor: 0,
      margin: 0,
      limitedByMargin: true,
    };
  }
  const floor = toGross(floorSolution.priceNet, data.priceVatRate);
  const competitiveComparable = Math.max(0, lowestCompetitor - Math.max(1000, lowestCompetitor * 0.005));
  const competitiveGross = data.comparisonBasis === "net"
    ? toGross(competitiveComparable, data.priceVatRate)
    : competitiveComparable;
  const priceGross = Math.max(floor, competitiveGross);
  const result = resultAtPrice(data, toNet(priceGross, data.priceVatRate, "with-vat"));
  return {
    valid: result.valid,
    issue: result.issues.find((issue) => issue.blocking),
    basis: data.comparisonBasis,
    basisLabel,
    priceGross,
    lowestCompetitor,
    protectedFloor: floor,
    margin: result.margin,
    limitedByMargin: floor >= competitiveGross,
  };
}

export function priceScenarios(data: CalculatorData, points = 9) {
  const calculation = calculate(data);
  const current = calculation.valid
    ? calculation.priceNet
    : Math.max(1, toNet(data.proposedPrice, data.priceVatRate, data.priceAmountType));
  return Array.from({ length: points }, (_, index) => {
    const factor = 0.8 + index * (0.4 / Math.max(1, points - 1));
    const result = resultAtPrice(data, current * factor);
    return { price: result.priceNet, profit: result.profit, margin: result.margin };
  });
}
