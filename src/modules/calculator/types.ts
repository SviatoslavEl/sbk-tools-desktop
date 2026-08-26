export type VatRate = 0 | 5 | 7 | 10 | 11 | 20 | 22;
export type AmountType = "with-vat" | "without-vat";
export type TaxRegime = "vat-payer" | "no-vat";
export type ComparisonBasis = "gross" | "net" | "adjusted";

export interface TaxTreatment {
  amountType: AmountType;
  vatRate: VatRate;
  taxRegime: TaxRegime;
  inputVatDeductible: boolean;
  includeInTotalCost: boolean;
}

export interface Expense extends TaxTreatment {
  id: string;
  name: string;
  category: string;
  type: "fixed" | "percent";
  value: number;
  percentBase: "cost" | "contract-price" | "custom";
  percentPriceBase: "net" | "gross";
  customBase?: number;
  enabled: boolean;
  comment: string;
}

export interface Subcontractor extends TaxTreatment {
  id: string;
  name: string;
  amount: number;
}

export interface Competitor {
  id: string;
  name: string;
  price: number;
  vatRate: VatRate;
  amountType: AmountType;
  taxRegime: TaxRegime;
  adjustmentPercent: number;
}

export interface CalculatorData {
  schemaVersion: 2;
  name: string;
  cost: number;
  costVatRate: VatRate;
  costAmountType: AmountType;
  costTaxRegime: TaxRegime;
  costInputVatDeductible: boolean;
  costIncludeInTotalCost: boolean;
  mode: "margin-to-price" | "price-to-margin";
  targetType: "margin" | "markup";
  targetValue: number;
  proposedPrice: number;
  priceVatRate: VatRate;
  priceAmountType: AmountType;
  expenses: Expense[];
  hasAgent: boolean;
  agentType: "fixed" | "percent";
  agentValue: number;
  agentPercentBase: "net" | "gross";
  agentAmountType: AmountType;
  agentVatRate: VatRate;
  agentTaxRegime: TaxRegime;
  agentInputVatDeductible: boolean;
  agentIncludeInTotalCost: boolean;
  subcontractors: Subcontractor[];
  competitors: Competitor[];
  comparisonBasis: ComparisonBasis;
  financingEnabled: boolean;
  advancePercent: number;
  paymentDelayDays: number;
  annualFinancingRate: number;
  financingRatePeriod: "annual" | "monthly";
  factoringEnabled: boolean;
  factoringCommissionPercent: number;
  bidGuaranteeCost: number;
  performanceGuaranteeCost: number;
  advanceGuaranteeCost: number;
  costGrowthReservePercent: number;
  minMargin: number;
  warningMargin: number;
  notes: string;
}

export interface CostBreakdown {
  quotedAmount: number;
  netAmount: number;
  grossAmount: number;
  inputVat: number;
  deductibleVat: number;
  effectiveCost: number;
}

export interface ExpenseResult extends Expense, CostBreakdown {
  amount: number;
  explanation: string;
}

export interface CalculationIssue {
  code:
    | "invalid-thresholds"
    | "invalid-target"
    | "unreachable-target"
    | "target-not-converged"
    | "invalid-data";
  message: string;
  field?: string;
  blocking: boolean;
  limitingCost?: string;
}

export interface CalculationResult {
  valid: boolean;
  issues: CalculationIssue[];
  priceNet: number;
  priceGross: number;
  outputVat: number;
  inputVatDeductible: number;
  vatPayable: number;
  vatAmount: number;
  internalCostNet: number;
  subcontractorsNet: number;
  directCosts: number;
  expensesTotal: number;
  additionalCosts: number;
  agentCommission: number;
  financingCost: number;
  fullCosts: number;
  totalCost: number;
  profit: number;
  margin: number;
  effectiveMargin: number;
  markup: number;
  profitability: number;
  taxes: number;
  status: "success" | "warning" | "danger";
  expenseResults: ExpenseResult[];
}

export class CalculatorImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalculatorImportError";
  }
}

const vatRates: VatRate[] = [0, 5, 7, 10, 11, 20, 22];
const amountTypes: AmountType[] = ["with-vat", "without-vat"];
const taxRegimes: TaxRegime[] = ["vat-payer", "no-vat"];

const finite = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
  strict: boolean,
): T {
  if (allowed.includes(value as T)) return value as T;
  if (value == null || value === "") return fallback;
  if (strict) throw new CalculatorImportError(`Поле «${field}» содержит неизвестное значение.`);
  return fallback;
}

export const newExpense = (name = "Новый расход"): Expense => ({
  id: crypto.randomUUID(),
  name,
  category: "Прочее",
  type: "fixed",
  value: 0,
  percentBase: "cost",
  percentPriceBase: "net",
  enabled: true,
  comment: "",
  amountType: "without-vat",
  vatRate: 0,
  taxRegime: "no-vat",
  inputVatDeductible: false,
  includeInTotalCost: true,
});

export const initialCalculatorData: CalculatorData = {
  schemaVersion: 2,
  name: "Новый расчёт",
  cost: 1_000_000,
  costVatRate: 0,
  costAmountType: "without-vat",
  costTaxRegime: "no-vat",
  costInputVatDeductible: false,
  costIncludeInTotalCost: true,
  mode: "margin-to-price",
  targetType: "margin",
  targetValue: 20,
  proposedPrice: 1_500_000,
  priceVatRate: 22,
  priceAmountType: "with-vat",
  expenses: [
    { ...newExpense("Банковская гарантия"), category: "Финансы", value: 45_000 },
    { ...newExpense("Логистика"), category: "Логистика", value: 30_000 },
  ],
  hasAgent: false,
  agentType: "percent",
  agentValue: 5,
  agentPercentBase: "net",
  agentAmountType: "without-vat",
  agentVatRate: 0,
  agentTaxRegime: "no-vat",
  agentInputVatDeductible: false,
  agentIncludeInTotalCost: true,
  subcontractors: [],
  competitors: [],
  comparisonBasis: "gross",
  financingEnabled: false,
  advancePercent: 0,
  paymentDelayDays: 0,
  annualFinancingRate: 0,
  financingRatePeriod: "annual",
  factoringEnabled: false,
  factoringCommissionPercent: 0,
  bidGuaranteeCost: 0,
  performanceGuaranteeCost: 0,
  advanceGuaranteeCost: 0,
  costGrowthReservePercent: 0,
  minMargin: 10,
  warningMargin: 15,
  notes: "",
};

function migrateExpense(value: unknown, strict: boolean): Expense {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const base = newExpense(typeof source.name === "string" ? source.name : "Расход");
  return {
    ...base,
    id: typeof source.id === "string" && source.id ? source.id : base.id,
    category: typeof source.category === "string" ? source.category : base.category,
    type: enumValue(source.type, ["fixed", "percent"] as const, base.type, "тип расхода", strict),
    value: finite(source.value, 0),
    percentBase: enumValue(source.percentBase, ["cost", "contract-price", "custom"] as const, base.percentBase, "база расхода", strict),
    percentPriceBase: enumValue(source.percentPriceBase, ["net", "gross"] as const, "net", "формат базы расхода", strict),
    customBase: finite(source.customBase, 0),
    enabled: source.enabled !== false,
    comment: typeof source.comment === "string" ? source.comment : "",
    amountType: enumValue(source.amountType, amountTypes, "without-vat", "формат суммы расхода", strict),
    vatRate: vatRates.includes(source.vatRate as VatRate) ? source.vatRate as VatRate : 0,
    taxRegime: enumValue(source.taxRegime, taxRegimes, "no-vat", "налоговый режим расхода", strict),
    inputVatDeductible: source.inputVatDeductible === true,
    includeInTotalCost: source.includeInTotalCost !== false,
  };
}

export function migrateCalculatorData(value: unknown, strict = false): CalculatorData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CalculatorImportError("Файл расчёта не содержит объекта данных.");
  }
  const source = value as Record<string, unknown>;
  if (strict && source.expenses != null && !Array.isArray(source.expenses)) {
    throw new CalculatorImportError("Список дополнительных расходов повреждён.");
  }
  if (strict && source.subcontractors != null && !Array.isArray(source.subcontractors)) {
    throw new CalculatorImportError("Список соисполнителей повреждён.");
  }
  if (strict && source.competitors != null && !Array.isArray(source.competitors)) {
    throw new CalculatorImportError("Список конкурентов повреждён.");
  }
  const legacyPaymentRiskEnabled = source.paymentRiskEnabled === true;
  const legacyPaymentRiskPercent = Math.max(0, finite(source.paymentRiskPercent, 0));
  return {
    ...initialCalculatorData,
    schemaVersion: 2,
    name: typeof source.name === "string" ? source.name : initialCalculatorData.name,
    cost: finite(source.cost, initialCalculatorData.cost),
    costVatRate: vatRates.includes(source.costVatRate as VatRate) ? source.costVatRate as VatRate : initialCalculatorData.costVatRate,
    costAmountType: enumValue(source.costAmountType, amountTypes, initialCalculatorData.costAmountType, "формат себестоимости", strict),
    costTaxRegime: enumValue(source.costTaxRegime, taxRegimes, source.costVatRate ? "vat-payer" : "no-vat", "налоговый режим себестоимости", strict),
    costInputVatDeductible: source.costInputVatDeductible === true,
    costIncludeInTotalCost: source.costIncludeInTotalCost !== false,
    mode: enumValue(source.mode, ["margin-to-price", "price-to-margin"] as const, initialCalculatorData.mode, "режим расчёта", strict),
    targetType: enumValue(source.targetType, ["margin", "markup"] as const, initialCalculatorData.targetType, "целевой показатель", strict),
    targetValue: finite(source.targetValue, initialCalculatorData.targetValue),
    proposedPrice: finite(source.proposedPrice, initialCalculatorData.proposedPrice),
    priceVatRate: vatRates.includes(source.priceVatRate as VatRate) ? source.priceVatRate as VatRate : initialCalculatorData.priceVatRate,
    priceAmountType: enumValue(source.priceAmountType, amountTypes, initialCalculatorData.priceAmountType, "формат цены", strict),
    expenses: Array.isArray(source.expenses) ? source.expenses.map((item) => migrateExpense(item, strict)) : initialCalculatorData.expenses.map((item) => ({ ...item, id: crypto.randomUUID() })),
    hasAgent: source.hasAgent === true,
    agentType: enumValue(source.agentType, ["fixed", "percent"] as const, initialCalculatorData.agentType, "тип комиссии агента", strict),
    agentValue: finite(source.agentValue, initialCalculatorData.agentValue),
    agentPercentBase: enumValue(source.agentPercentBase, ["net", "gross"] as const, initialCalculatorData.agentPercentBase, "база комиссии агента", strict),
    agentAmountType: enumValue(source.agentAmountType, amountTypes, "without-vat", "формат комиссии агента", strict),
    agentVatRate: vatRates.includes(source.agentVatRate as VatRate) ? source.agentVatRate as VatRate : 0,
    agentTaxRegime: enumValue(source.agentTaxRegime, taxRegimes, "no-vat", "налоговый режим агента", strict),
    agentInputVatDeductible: source.agentInputVatDeductible === true,
    agentIncludeInTotalCost: source.agentIncludeInTotalCost !== false,
    subcontractors: Array.isArray(source.subcontractors) ? source.subcontractors.map((item) => {
      const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const vatRate = vatRates.includes(entry.vatRate as VatRate) ? entry.vatRate as VatRate : 0;
      return {
        id: typeof entry.id === "string" && entry.id ? entry.id : crypto.randomUUID(),
        name: typeof entry.name === "string" ? entry.name : "Соисполнитель",
        amount: finite(entry.amount, 0),
        vatRate,
        amountType: enumValue(entry.amountType, amountTypes, "without-vat", "формат суммы соисполнителя", strict),
        taxRegime: enumValue(entry.taxRegime, taxRegimes, vatRate ? "vat-payer" : "no-vat", "налоговый режим соисполнителя", strict),
        inputVatDeductible: entry.inputVatDeductible === true,
        includeInTotalCost: entry.includeInTotalCost !== false,
      };
    }) : [],
    competitors: Array.isArray(source.competitors) ? source.competitors.map((item) => {
      const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const vatRate = vatRates.includes(entry.vatRate as VatRate) ? entry.vatRate as VatRate : 0;
      return {
        id: typeof entry.id === "string" && entry.id ? entry.id : crypto.randomUUID(),
        name: typeof entry.name === "string" ? entry.name : "Конкурент",
        price: finite(entry.price, 0),
        vatRate,
        amountType: enumValue(entry.amountType, amountTypes, "with-vat", "формат цены конкурента", strict),
        taxRegime: enumValue(entry.taxRegime, taxRegimes, vatRate ? "vat-payer" : "no-vat", "налоговый режим конкурента", strict),
        adjustmentPercent: finite(entry.adjustmentPercent, 0),
      };
    }) : [],
    comparisonBasis: enumValue(source.comparisonBasis, ["gross", "net", "adjusted"] as const, "gross", "методика сравнения", strict),
    financingEnabled: source.financingEnabled === true || legacyPaymentRiskEnabled,
    advancePercent: finite(source.advancePercent, 0),
    paymentDelayDays: finite(source.paymentDelayDays, legacyPaymentRiskEnabled ? 30 : 0),
    annualFinancingRate: finite(source.annualFinancingRate, legacyPaymentRiskEnabled ? legacyPaymentRiskPercent * 12 : 0),
    financingRatePeriod: enumValue(source.financingRatePeriod, ["annual", "monthly"] as const, "annual", "период ставки финансирования", strict),
    factoringEnabled: source.factoringEnabled === true,
    factoringCommissionPercent: finite(source.factoringCommissionPercent, 0),
    bidGuaranteeCost: finite(source.bidGuaranteeCost, 0),
    performanceGuaranteeCost: finite(source.performanceGuaranteeCost, 0),
    advanceGuaranteeCost: finite(source.advanceGuaranteeCost, 0),
    costGrowthReservePercent: finite(source.costGrowthReservePercent, 0),
    minMargin: finite(source.minMargin, initialCalculatorData.minMargin),
    warningMargin: finite(source.warningMargin, initialCalculatorData.warningMargin),
    notes: typeof source.notes === "string" ? source.notes : "",
  };
}
