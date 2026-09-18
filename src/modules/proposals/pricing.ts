import { VAT_RATES, type ProposalLine, type PublicLine, type PublicTotals, type Tax } from './types';

export const MAX_PROPOSAL_LINES = 1000;
export const MAX_MONEY_MINOR = 9007199254740991n;
export class ProposalPricingError extends Error {
  constructor(message: string, public field = 'lines', public lineId?: string) { super(message); this.name = 'ProposalPricingError'; }
}
export function normalizeDecimal(value: string, decimals: number, label = 'Число', maximum = 1000000000000n): string {
  const normalized = String(value).trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (normalized.length > 40 || !/^\d+(?:\.\d+)?$/.test(normalized)) throw new ProposalPricingError(`${label}: введите неотрицательное десятичное число без экспоненты`);
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > decimals) throw new ProposalPricingError(`${label}: допускается не более ${decimals} знаков после запятой`);
  if (BigInt(whole) > maximum || (BigInt(whole) === maximum && /[1-9]/.test(fraction))) throw new ProposalPricingError(`${label}: превышен допустимый диапазон`);
  const tail = fraction.replace(/0+$/, '');
  return `${BigInt(whole)}${tail ? `.${tail}` : ''}`;
}
function integer(value: string, scale: number): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
}
function halfUp(numerator: bigint, denominator: bigint): bigint { return (numerator * 2n + denominator) / (denominator * 2n); }
function bounded(value: bigint): string {
  if (value > MAX_MONEY_MINOR) throw new ProposalPricingError('Сумма превышает допустимый предел 90 071 992 547 409,91 ₽');
  return value.toString();
}
export function taxLabel(tax: Tax): string { return tax.kind === 'none' ? 'Без НДС' : `НДС ${tax.rate}%`; }
export function formatMoneyMinor(value: string): string {
  const amount = BigInt(value); const negative = amount < 0n; const absolute = negative ? -amount : amount;
  return `${negative ? '−' : ''}${(absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ' )},${String(absolute % 100n).padStart(2, '0')} ₽`;
}
export function priceProposalLine(line: ProposalLine): PublicLine {
  function decimal(value: string, digits: number, field: string, label: string, maximum?: bigint) {
    try { return normalizeDecimal(value, digits, label, maximum); }
    catch (error) { throw new ProposalPricingError((error as Error).message, `lines.${field}`, line.id); }
  }
  const quantity = decimal(line.quantity, 6, 'quantity', 'Количество', 1000000000n);
  const unitPrice = decimal(line.unitPrice, 4, 'unitPrice', 'Цена');
  const discountPercent = decimal(line.discountPercent, 2, 'discountPercent', 'Скидка', 100n);
  if (integer(quantity, 6) === 0n) throw new ProposalPricingError('Количество должно быть больше нуля', 'lines.quantity', line.id);
  if (line.priceBasis !== 'gross' && line.priceBasis !== 'net') throw new ProposalPricingError('Укажите базу цены', 'lines.priceBasis', line.id);
  if (line.tax.kind !== 'none' && !(line.tax.kind === 'vat' && VAT_RATES.includes(line.tax.rate))) throw new ProposalPricingError('Неподдерживаемая ставка НДС', 'lines.tax', line.id);
  const tax: Tax = line.tax.kind === 'none' ? { kind: 'none' } : { kind: 'vat', rate: line.tax.rate };
  const base = halfUp(integer(quantity, 6) * integer(unitPrice, 4) * (10000n - integer(discountPercent, 2)), 1000000000000n);
  const rate = tax.kind === 'vat' ? BigInt(tax.rate) : 0n;
  const vat = halfUp(base * rate, line.priceBasis === 'net' ? 100n : 100n + rate);
  const net = line.priceBasis === 'net' ? base : base - vat;
  const gross = line.priceBasis === 'net' ? base + vat : base;
  return { title: line.title.trim(), description: line.description.trim(), unit: line.unit.trim(), quantity, unitPrice, priceBasis: line.priceBasis, discountPercent, tax, netMinor: bounded(net), vatMinor: bounded(vat), grossMinor: bounded(gross) };
}
export function priceProposal(lines: ProposalLine[]): { lines: PublicLine[]; totals: PublicTotals } {
  if (!lines.length || lines.length > MAX_PROPOSAL_LINES) throw new ProposalPricingError(`Добавьте от 1 до ${MAX_PROPOSAL_LINES} позиций`);
  const priced = lines.map(priceProposalLine);
  const groups = new Map<string, { tax: Tax; net: bigint; vat: bigint; gross: bigint }>();
  let net = 0n; let vat = 0n; let gross = 0n;
  for (const line of priced) {
    const key = line.tax.kind === 'none' ? 'none' : `vat${line.tax.rate}`;
    const group = groups.get(key) ?? { tax: line.tax, net: 0n, vat: 0n, gross: 0n };
    group.net += BigInt(line.netMinor); group.vat += BigInt(line.vatMinor); group.gross += BigInt(line.grossMinor); groups.set(key, group);
    net += BigInt(line.netMinor); vat += BigInt(line.vatMinor); gross += BigInt(line.grossMinor);
  }
  return { lines: priced, totals: { pricingVersion: 'proposal-pricing/1', netMinor: bounded(net), vatMinor: bounded(vat), grossMinor: bounded(gross), byTax: [...groups.values()].map((group) => ({ tax: group.tax, netMinor: bounded(group.net), vatMinor: bounded(group.vat), grossMinor: bounded(group.gross) })) } };
}
