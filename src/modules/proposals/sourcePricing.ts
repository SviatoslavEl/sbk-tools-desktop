import { createProposalLine } from "./defaults";
import { normalizeDecimal, priceProposalLine } from "./pricing";
import { VAT_RATES, type ProposalData, type ProposalLine, type Tax } from "./types";

/** Private source facts, never a quotation or a model-issued approval. */
export interface ProposalSourceFinancialCandidate {
  id: string; sourceId: string; sourceName: string; sourceSha256?: string;
  fragmentId?: string; locator: string; quote: string;
  sourceKind: "contract" | "offer" | "procurementLimit" | "unknown";
  scope: "aggregate" | "position"; positionName?: string; currency: string;
  net?: string; vatAmount?: string; gross?: string; quantity?: string;
  unit?: string; unitPrice?: string; priceBasis?: "gross" | "net";
  tax: Tax | { kind: "unknown" }; issues: string[];
}
export interface ProposalSourceFinancials {
  version: 1; candidates: ProposalSourceFinancialCandidate[];
  /** Created only by the receiving editor, never accepted from model output. */
  decision?: { kind: "applied" | "not-used"; candidateId?: string; fingerprint: string };
}

const meaningful = (value: string) => value.trim().replace(/\s+/gu, " ");
const key = (value: string) => meaningful(value).normalize("NFKC").toLocaleLowerCase("ru");
const decimal = (value: string | undefined, digits = 2) => value === undefined ? undefined : normalizeDecimal(value, digits);
const minor = (value: string) => { const [whole, fraction = ""] = normalizeDecimal(value, 2).split("."); return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")); };
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u;

export function normalizeProposalSourceCandidate(input: ProposalSourceFinancialCandidate): ProposalSourceFinancialCandidate {
  const allowed = ["id", "sourceId", "sourceName", "sourceSha256", "fragmentId", "locator", "quote", "sourceKind", "scope", "positionName", "currency", "net", "vatAmount", "gross", "quantity", "unit", "unitPrice", "priceBasis", "tax", "issues"];
  if (!input || typeof input !== "object" || !["aggregate", "position"].includes(input.scope)
    || Object.keys(input).some((field) => !allowed.includes(field))
    || !["contract", "offer", "procurementLimit", "unknown"].includes(input.sourceKind)
    || typeof input.id !== "string" || !input.id || input.id.length > 200
    || typeof input.sourceId !== "string" || !input.sourceId || input.sourceId.length > 128
    || typeof input.sourceName !== "string" || input.sourceName.length > 2000
    || typeof input.quote !== "string" || !input.quote.trim() || input.quote.length > 8000
    || typeof input.locator !== "string" || input.locator.length > 2000
    || !Array.isArray(input.issues) || input.issues.length > 30 || input.issues.some((issue) => typeof issue !== "string" || issue.length > 2000)
    || [input.id, input.sourceId, input.sourceName, input.quote, input.locator, ...input.issues].some((value) => control.test(value))
    || input.fragmentId !== undefined && (typeof input.fragmentId !== "string" || !input.fragmentId || input.fragmentId.length > 128 || /[\u0000-\u001f]/u.test(input.fragmentId))
    || input.sourceSha256 !== undefined && !/^[a-f\d]{64}$/iu.test(input.sourceSha256)
    || typeof input.currency !== "string" || !/^[A-Z]{3}$/u.test(input.currency)
    || [input.net, input.vatAmount, input.gross, input.quantity, input.unitPrice].some((value) => value !== undefined && typeof value !== "string")
    || input.positionName !== undefined && (typeof input.positionName !== "string" || !input.positionName.trim() || input.positionName.length > 500 || control.test(input.positionName))
    || input.unit !== undefined && (typeof input.unit !== "string" || input.unit.length > 50 || control.test(input.unit))
    || input.priceBasis !== undefined && input.priceBasis !== "gross" && input.priceBasis !== "net"
    || !input.tax || !["unknown", "none", "vat"].includes(input.tax.kind)
    || Object.keys(input.tax).some((field) => !["kind", ...(input.tax.kind === "vat" ? ["rate"] : [])].includes(field))
    || input.tax.kind === "vat" && !VAT_RATES.includes(input.tax.rate)) throw new Error("Некорректные исходные финансовые сведения. Повторите анализ документа.");
  const next = { ...input, issues: [...input.issues], tax: { ...input.tax }, net: decimal(input.net), vatAmount: decimal(input.vatAmount), gross: decimal(input.gross),
    quantity: decimal(input.quantity, 6), unitPrice: decimal(input.unitPrice, 4) };
  // Omit unknown values rather than manufacturing zeroes or default tax facts.
  return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as unknown as ProposalSourceFinancialCandidate;
}

export function createProposalSourceFinancials(candidates: readonly ProposalSourceFinancialCandidate[]): ProposalSourceFinancials {
  if (candidates.length > 100 || new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) throw new Error("Неоднозначный или слишком большой список исходных цен.");
  return { version: 1, candidates: candidates.map(normalizeProposalSourceCandidate) };
}

function priceLine(candidate: ProposalSourceFinancialCandidate, line: ProposalLine): ProposalLine {
  if (candidate.currency !== "RUB") throw new Error("В КП поддерживаются рубли. Валюта исходной цены не пересчитывается автоматически.");
  if (candidate.sourceKind === "procurementLimit") throw new Error("Начальная или предельная цена закупки не является ценой нашего предложения.");
  if (candidate.issues.length) throw new Error(candidate.issues.join(" "));
  if (candidate.tax.kind === "unknown") throw new Error("НДС в источнике не определён: выберите и проверьте цену вручную.");
  const basis = candidate.scope === "aggregate" ? candidate.gross !== undefined ? "gross" : "net" : candidate.priceBasis;
  const price = candidate.scope === "aggregate" ? candidate.gross ?? candidate.net : candidate.unitPrice;
  if (price === undefined || !basis) throw new Error("Не определены цена и её налоговая база.");
  if (candidate.scope === "position" && (!candidate.quantity || !candidate.unit?.trim())) throw new Error("Количество и единица исходной позиции не определены.");
  const result: ProposalLine = { ...line, quantity: candidate.scope === "aggregate" ? "1" : candidate.quantity!, unit: candidate.scope === "aggregate" ? "комплекс" : candidate.unit!,
    unitPrice: price, priceBasis: basis, discountPercent: "0", tax: { ...candidate.tax } };
  const priced = priceProposalLine(result);
  for (const [field, actual] of [["net", priced.netMinor], ["vatAmount", priced.vatMinor], ["gross", priced.grossMinor]] as const) {
    if (candidate[field] !== undefined && minor(candidate[field]!) !== BigInt(actual)) throw new Error("Суммы без НДС, НДС и итог в источнике не согласуются. Проверьте исходную цену вручную.");
  }
  return result;
}

/** Cheap UI eligibility check. It never means that a user approved the price. */
export function proposalSourceCandidateIssue(candidate: ProposalSourceFinancialCandidate): string | undefined {
  try { const normalized = normalizeProposalSourceCandidate(candidate); priceLine(normalized, createProposalLine()); return; }
  catch (reason) { return reason instanceof Error ? reason.message : "Исходная цена требует проверки."; }
}

function canonicalJson(value: unknown): string {
  // Storage may round-trip JSON through an object-key-sorting serializer.
  // Object insertion order is not business data; array order and every scalar
  // remain exact, including decimal strings, source quotes and identifiers.
  return JSON.stringify(value, (_property, entry: unknown) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : entry);
}

function fingerprint(data: ProposalData): string {
  // Exact private binding, not a hash/authentication mechanism. Editing price,
  // scope, parties or family invalidates the previous applicability decision.
  return canonicalJson([data.familyId, data.title, [data.issuer.name, data.issuer.inn, data.issuer.kpp], [data.recipient.name, data.recipient.inn, data.recipient.kpp],
    data.introduction, data.deliveryTerms, data.paymentTerms, data.conclusion,
    data.lines.map(({ id, title, description, unit, quantity, unitPrice, priceBasis, discountPercent, tax }) => ({ id, title, description, unit, quantity, unitPrice, priceBasis, discountPercent, tax })),
    data.sourceFinancials?.candidates]);
}

function sameFingerprint(stored: string, data: ProposalData): boolean {
  if (typeof stored !== "string") return false;
  const current = fingerprint(data);
  // Also accept a genuine earlier insertion-ordered binding after comparing
  // its complete parsed values. No DB migration or new approval is created.
  return stored === current || canonicalJson(JSON.parse(stored)) === current;
}

export function applyProposalSourcePrice(data: ProposalData, candidateId: string, confirmation: {
  sameProject: boolean; aggregateAsSingleLine?: boolean; replaceExistingPrices?: boolean;
}): ProposalData {
  const state = data.sourceFinancials;
  if (!state || state.version !== 1 || !confirmation.sameProject) throw new Error("Подтвердите, что исходная цена применима к тому же проекту и объёму этого КП.");
  const candidates = createProposalSourceFinancials(state.candidates).candidates;
  const matches = candidates.filter((candidate) => candidate.id === candidateId);
  if (matches.length !== 1) throw new Error("Исходная цена больше не доступна. Повторите анализ.");
  const candidate = matches[0];
  if (data.lines.some((line) => line.unitPrice.trim()) && !confirmation.replaceExistingPrices) throw new Error("В КП уже введены цены. Подтвердите их замену либо оставьте собственные цены.");
  let lines: ProposalLine[];
  if (candidate.scope === "aggregate") {
    if (!confirmation.aggregateAsSingleLine) throw new Error("Подтвердите одну сводную позицию: цена дана на весь комплекс, а не на каждый блок.");
    // The source completion already distinguishes the document heading
    // “КП по …” from its offered service “Услуги по …”. Applying a package
    // price must not overwrite that explicit service name with the heading.
    // This is a narrow preservation rule, not a way to name arbitrary goods.
    const sourceService = data.lines.length === 1 && candidate.sourceKind === "contract"
      && /(?:стоимост[ьи]|цен[аыуе])[^.;\n]{0,100}(?:услуг|работ)(?=$|[^\p{L}])/iu.test(candidate.quote)
      && /^КП\s+по\s+\S/iu.test(data.title.trim())
      && key(data.lines[0].title) === key(data.title.trim().replace(/^КП\s+по\s+/iu, "Услуги по "));
    const alreadyAggregate = data.lines.length === 1 && data.lines[0].unit === "комплекс" && data.lines[0].quantity === "1" && key(data.lines[0].title) === key(data.title);
    const completeScope = sourceService ? data.lines[0].description : alreadyAggregate ? data.lines[0].description.trim() : data.lines.map((line) => [line.title.trim(), line.description.trim()].filter(Boolean).join("\n")).filter(Boolean).join("\n\n");
    if (!completeScope.trim() || !data.title.trim()) throw new Error("Сначала заполните предмет и полный состав работ. Цена не заменяет описание услуги.");
    if (completeScope.length > 20_000) throw new Error("Полный состав работ не помещается в одну позицию. Сократите его вручную без потери условий.");
    lines = [priceLine(candidate, { ...createProposalLine(), title: sourceService ? data.lines[0].title : data.title.trim(), description: completeScope })];
  } else {
    const matching = data.lines.filter((line) => candidate.positionName && key(line.title) === key(candidate.positionName));
    if (matching.length !== 1) throw new Error("Исходная цена не сопоставлена с единственной неизменённой позицией КП.");
    lines = data.lines.map((line) => line.id === matching[0].id ? priceLine(candidate, line) : structuredClone(line));
  }
  const next: ProposalData = { ...data, lines, sourceFinancials: { version: 1, candidates } };
  next.sourceFinancials!.decision = { kind: "applied", candidateId, fingerprint: fingerprint(next) };
  return next;
}

export function dismissProposalSourcePricing(data: ProposalData): ProposalData {
  if (!data.sourceFinancials) return data;
  const next = { ...data, sourceFinancials: createProposalSourceFinancials(data.sourceFinancials.candidates) };
  next.sourceFinancials.decision = { kind: "not-used", fingerprint: fingerprint(next) };
  return next;
}

export function resetProposalSourcePricing(data: ProposalData): ProposalData {
  return data.sourceFinancials ? { ...data, sourceFinancials: createProposalSourceFinancials(data.sourceFinancials.candidates) } : data;
}

/** The editor/export gate uses this; incomplete drafts may still be saved. */
export function proposalSourcePricingIssues(data: ProposalData): string[] {
  if (!data.sourceFinancials) return [];
  try {
    const state = data.sourceFinancials;
    if (state.version !== 1) throw new Error();
    createProposalSourceFinancials(state.candidates);
    if (!state.candidates.length) return [];
    if (!state.decision || !["applied", "not-used"].includes(state.decision.kind) || !sameFingerprint(state.decision.fingerprint, data)
      || state.decision.kind === "applied" && !state.candidates.some((candidate) => candidate.id === state.decision!.candidateId)) return ["Решите, использовать ли исходную цену в этом КП. После изменения проекта, сторон, состава или цен проверьте решение заново."];
    return [];
  } catch { return ["Исходные финансовые сведения повреждены. Повторите анализ или введите собственную цену после проверки."]; }
}
