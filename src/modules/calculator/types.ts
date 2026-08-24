export type VatRate = 0 | 5 | 7 | 10 | 11 | 20 | 22;
export type AmountType = "with-vat" | "without-vat";

export interface Expense {
  id: string;
  name: string;
  category: string;
  type: "fixed" | "percent";
  value: number;
  percentBase: "cost" | "contract-price" | "custom";
  customBase?: number;
  enabled: boolean;
  comment: string;
}

export interface Subcontractor {
  id: string;
  name: string;
  amount: number;
  vatRate: VatRate;
  amountType: AmountType;
}

export interface Competitor {
  id: string;
  name: string;
  price: number;
  vatRate: VatRate;
  amountType: AmountType;
}

export interface CalculatorData {
  name: string;
  cost: number;
  costVatRate: VatRate;
  costAmountType: AmountType;
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
  subcontractors: Subcontractor[];
  competitors: Competitor[];
  paymentRiskEnabled: boolean;
  paymentRiskPercent: number;
  minMargin: number;
  warningMargin: number;
  notes: string;
}

export interface ExpenseResult extends Expense {
  amount: number;
  explanation: string;
}

export interface CalculationResult {
  priceNet: number;
  priceGross: number;
  vatAmount: number;
  internalCostNet: number;
  subcontractorsNet: number;
  expensesTotal: number;
  agentCommission: number;
  profit: number;
  margin: number;
  effectiveMargin: number;
  markup: number;
  profitability: number;
  taxes: number;
  status: "success" | "warning" | "danger";
  expenseResults: ExpenseResult[];
}

export const newExpense = (name = "Новый расход"): Expense => ({
  id: crypto.randomUUID(),
  name,
  category: "Прочее",
  type: "fixed",
  value: 0,
  percentBase: "cost",
  enabled: true,
  comment: "",
});

export const initialCalculatorData: CalculatorData = {
  name: "Новый расчёт",
  cost: 1_000_000,
  costVatRate: 0,
  costAmountType: "without-vat",
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
  subcontractors: [],
  competitors: [],
  paymentRiskEnabled: false,
  paymentRiskPercent: 2,
  minMargin: 10,
  warningMargin: 15,
  notes: "",
};
