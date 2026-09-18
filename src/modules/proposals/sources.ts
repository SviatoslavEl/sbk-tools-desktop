import { calculate } from "../calculator/engine";
import { migrateCalculatorData, type CalculatorData } from "../calculator/types";
import type { ProcurementData } from "../procurement/types";
import { scenarioFinancials } from "../procurement/domain";
import { createProposal } from "./defaults";
import type { ProposalData, Tax } from "./types";

/** Decimal half-up, including exponent-form Number strings; never binary toFixed rounding. */
export function sourcePrice(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new Error("Цена источника должна быть конечной неотрицательной суммой.");
  const [coefficient, exponent = "0"] = String(value).toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const raw = BigInt(whole + fraction);
  const scale = fraction.length - Number(exponent);
  const divisor = scale > 2 ? 10n ** BigInt(scale - 2) : 1n;
  const minor = scale > 2 ? (raw + divisor / 2n) / divisor : raw * 10n ** BigInt(2 - scale);
  if (minor > 100000000000000n) throw new Error("Цена источника превышает допустимый предел позиции КП.");
  return `${minor / 100n}.${String(minor % 100n).padStart(2, "0")}`;
}

export function proposalFromCalculator(data: CalculatorData, recordId?: string, wasUnsaved = true): ProposalData {
  const result = calculate(data);
  if (!result.valid || !Number.isFinite(result.priceGross) || result.priceGross < 0) throw new Error("Исправьте расчёт перед созданием КП.");
  const proposal = createProposal();
  return { ...proposal, title: data.name || "Коммерческое предложение", lines: [{ ...proposal.lines[0], title: data.name || "Услуги", unitPrice: sourcePrice(result.priceGross), priceBasis: "gross", tax: data.priceVatRate === 0 ? {kind:"none"} : {kind:"vat",rate:data.priceVatRate} }], source: {tool:"calculator", recordId, wasUnsaved, capturedAt:new Date().toISOString(),priceOrigin:"Текущая рассчитанная цена с НДС"} };
}
export interface ProcurementPriceSource { id: string; label: string; price: string; tax: Tax; loss: boolean; }
export function procurementProposalPrices(data: ProcurementData): ProcurementPriceSource[] {
  const scenarios = data.participationScenarios.filter((scenario) => Number.isFinite(scenario.customerPriceGross) && scenario.customerPriceGross >= 0 && scenario.customerPriceGross <= 1e12 && [0,5,7,10,11,20,22].includes(scenario.vatRate)).map((scenario): ProcurementPriceSource => ({id:`scenario:${scenario.id}`,label:`Сценарий «${scenario.name}»${scenario.selected ? " · выбранный" : ""}`,price:sourcePrice(scenario.customerPriceGross),loss:scenarioFinancials(scenario).profit < 0,tax:scenario.vatRate === 0 ? {kind:"none"} : {kind:"vat",rate:scenario.vatRate as 5|7|10|11|20|22}}));
  const calculations = data.calculations.flatMap((snapshot): ProcurementPriceSource[] => {
    try { const source = migrateCalculatorData(snapshot.snapshot); const result = calculate(source); return result.valid && Number.isFinite(result.priceGross) && result.priceGross >= 0 ? [{id:`calculation:${snapshot.id}`,label:`Снимок расчёта «${snapshot.title}»`,price:sourcePrice(result.priceGross),loss:result.profit < 0,tax:source.priceVatRate === 0 ? {kind:"none"} : {kind:"vat",rate:source.priceVatRate}}] : []; }
    catch { return []; }
  });
  return [...scenarios, ...calculations];
}
export function proposalFromProcurement(data: ProcurementData, sourceId: string, recordId?: string): ProposalData {
  const source = procurementProposalPrices(data).find((entry) => entry.id === sourceId);
  if (!source) throw new Error("Выберите существующий сценарий или снимок расчёта. НМЦ автоматически не переносится.");
  const proposal = createProposal();
  return {...proposal,title:data.name,recipient:{...proposal.recipient,name:data.customer},lines:[{...proposal.lines[0],title:data.subject,unitPrice:source.price,tax:source.tax}],source:{tool:"procurement",recordId,sourceRevision:String(data.revision),capturedAt:new Date().toISOString(),wasUnsaved:false,priceOrigin:source.label}};
}
