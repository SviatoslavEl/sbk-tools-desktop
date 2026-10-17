import { createProposalSourceFinancials, normalizeProposalSourceCandidate, proposalSourceCandidateIssue, type ProposalSourceFinancialCandidate } from "../proposals/sourcePricing";
import { normalizeDecimal } from "../proposals/pricing";
import { VAT_RATES } from "../proposals/types";
import { assertResponsePreparationSources } from "./responsePreparationBounds";
import type { IntelligenceSource } from "./workbenchTypes";

export interface ProposalSourceFinancialExtraction {
  candidates: ProposalSourceFinancialCandidate[]; issues: string[]; limited: boolean;
}
const included = (fragment: NonNullable<IntelligenceSource["fragments"]>[number]) => fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden" || fragment.includedByUser === true;
const normalized = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const amount = String.raw`(\d{1,3}(?:[ \u00a0\u202f]\d{3})+(?:[,.]\d{1,2})?|\d+(?:[,.]\d{1,2})?)`;
const money = (value: string | undefined) => value === undefined ? undefined : normalizeDecimal(value, 2);
function identity(value: string): string {
  let left = 2166136261, right = 3339675911;
  for (let index = 0; index < value.length; index++) { left = Math.imul(left ^ value.charCodeAt(index), 16777619); right = Math.imul(right ^ value.charCodeAt(index), 2246822519); }
  return `${(left >>> 0).toString(16)}${(right >>> 0).toString(16)}`;
}
function currency(text: string): string {
  const currencies: string[] = [];
  if (/(?:₽|руб(?:\.|л[яьи]|лей|ль)?(?=$|[^\p{L}])|\bRUB\b|российских\s+руб)/iu.test(text)) currencies.push("RUB");
  if (/(?:\$|\bUSD\b|доллар)/iu.test(text)) currencies.push("USD");
  if (/(?:€|\bEUR\b|евро)/iu.test(text)) currencies.push("EUR");
  if (/(?:\bCNY\b|юан)/iu.test(text)) currencies.push("CNY");
  if (/(?:₸|\bKZT\b|тенге)/iu.test(text)) currencies.push("KZT");
  return currencies.length === 1 ? currencies[0] : "UNK";
}
function sourceKind(context: string): ProposalSourceFinancialCandidate["sourceKind"] {
  if (/(?:начальн[а-я]*\s+максимальн[а-я]*|\bНМЦК?\b|предельн[а-я]*\s+(?:цена|стоимость))/iu.test(context)) return "procurementLimit";
  if (/(?:коммерческое\s+предложение|^\s*КП\b)/iu.test(context.slice(0, 1000))) return "offer";
  return /(?:настоящ[а-я]*\s+договор|договор\s+(?:№|возмездного|оказания|поставки)|стороны.*заключили)/iu.test(context) ? "contract" : "unknown";
}
function tax(text: string): ProposalSourceFinancialCandidate["tax"] {
  const without = /(?:без\s+НДС|НДС\s+не\s+(?:облагается|предусмотрен|начисляется))/iu.test(text);
  const netLabel = /(?:стоимость|цена|сумма)[^.;:]{0,80}?без\s+НДС\s*(?:составляет|равна|:|—|-)?\s*\d/iu.test(text);
  const exempt = /НДС\s+не\s+(?:облагается|предусмотрен|начисляется)/iu.test(text);
  const rates = [...text.matchAll(/(?:НДС|налог\s+на\s+добавленную\s+стоимость)[^.;]{0,100}?(\d{1,2})\s*%/giu)].map((match) => Number(match[1]));
  const unique = [...new Set(rates)];
  if (without && (!netLabel || exempt)) return unique.length ? { kind: "unknown" } : { kind: "none" };
  const rate = VAT_RATES.find((value) => value === unique[0]);
  return unique.length === 1 && rate !== undefined ? { kind: "vat", rate } : { kind: "unknown" };
}
function declared(text: string): { net?: string; gross?: string; vatAmount?: string } {
  const grossPatterns = [
    new RegExp(String.raw`(?:итого\s+(?:стоимость|цена|сумма)[^.;]{0,100}?|(?:общая\s+)?(?:стоимость|цена|сумма)[^.;]{0,100}?(?:с\s+уч[её]том\s+НДС|включая\s+НДС))\s*(?:составляет|равна|:|—|-)?\s*${amount}`, "iu"),
    new RegExp(String.raw`(?:итого\s+(?:с\s+НДС|к\s+оплате)|всего\s+с\s+НДС)\s*(?:составляет|:|—|-)?\s*${amount}`, "iu"),
  ];
  const netPatterns = [
    new RegExp(String.raw`(?:стоимость|цена|сумма)[^.;]{0,80}?(?:без\s+НДС)\s*(?:составляет|:|—|-)?\s*${amount}`, "iu"),
    new RegExp(String.raw`(?:стоимость|цена|сумма)\s+(?:услуг|работ|договора|комплекса|поставки)[^.;\d]{0,50}?(?:составляет|:|равна)\s*${amount}(?=[\s\S]{0,500}?(?:кроме\s+того|дополнительно)\s+(?:НДС|налог\s+на\s+добавленную\s+стоимость))`, "iu"),
  ];
  const take = (patterns: RegExp[]) => {
    const values = [...new Set(patterns.flatMap((pattern) => [...text.matchAll(new RegExp(pattern.source, "giu"))].map((match) => money(match[1]))))];
    if (values.length > 1) throw new Error("Несколько разных цен в одном условии.");
    return values[0];
  };
  const vatAmount = take([
    new RegExp(String.raw`(?:НДС|налог\s+на\s+добавленную\s+стоимость)\s*(?:по\s+ставке\s*)?\d{1,2}\s*%\s*(?:в\s+размере|составляет|:|—|-)?\s*${amount}`, "iu"),
    new RegExp(String.raw`(?:сумма\s+НДС|НДС\s+в\s+размере|налог\s+на\s+добавленную\s+стоимость\s+в\s+размере)\s*(?:составляет|:|—|-)?\s*${amount}`, "iu"),
  ]);
  let gross = take(grossPatterns), net = take(netPatterns);
  if (!gross && !net) {
    const simple = new RegExp(String.raw`(?:общая\s+)?(?:стоимость|цена|сумма)\s+(?:услуг|работ|договора|комплекса|поставки)\s*(?:составляет|равна|:|—|-)\s*${amount}`, "iu").exec(text)?.[1];
    if (simple) {
      if (/(?:без\s+НДС|НДС\s+не\s+облагается)/iu.test(text)) net = simple;
      else if (/(?:в\s+том\s+числе\s+НДС|включая\s+НДС|с\s+НДС|с\s+уч[её]том\s+НДС)/iu.test(text)) gross = simple;
    }
  }
  return { net: money(net), gross: money(gross), vatAmount: money(vatAmount) };
}

/** Conservative literal contract/offer totals. No prices inferred from advance,
 * penalties, liability caps, quantities, budgets or filenames; no LLM request. */
export function extractProposalSourceFinancials(sources: readonly IntelligenceSource[]): ProposalSourceFinancialExtraction {
  const result: ProposalSourceFinancialExtraction = { candidates: [], issues: [], limited: false };
  const stop = (message: string): ProposalSourceFinancialExtraction => ({ candidates: [], issues: [message], limited: true });
  try { assertResponsePreparationSources(sources); } catch (reason) { return stop(reason instanceof Error ? reason.message : "Материалы для исходной цены некорректны."); }
  for (const source of sources) {
    const fragments = source.fragments?.filter(included);
    if (fragments && fragments.some((fragment, index) => fragment.id && fragments.findIndex((other) => other.id === fragment.id) !== index)) {
      result.issues.push(`Источник «${source.name}»: повторены идентификаторы фрагментов, цены не сопоставлены.`); continue;
    }
    const units = fragments !== undefined ? fragments.map((fragment) => ({ ...fragment })) : source.text.split(/\r?\n/u).map((text, index) => ({ text, locator: `Текст, строка ${index + 1}`, id: undefined }));
    const context = units.map((unit) => unit.text).join("\n");
    const kind = sourceKind(context);
    for (const unit of units) {
      const quote = unit.text.trim();
      if (!quote || !/(?:стоимость|цена|сумма)\s+(?:услуг|работ|договора|комплекса|поставки)|итого\s+(?:с\s+НДС|к\s+оплате)|всего\s+с\s+НДС/iu.test(quote)) continue;
      // Keep coherent paragraph evidence; never truncate a long clause until
      // its qualifications disappear, or join unrelated source fragments.
      if (quote.length > 8000) return stop("Ценовой фрагмент слишком велик для однозначного разбора. Разделите материал или проверьте цену вручную.");
      if (/(?:аванс|предоплат|неустойк|штраф|пени|лимит\s+ответственности|компенсаци)/iu.test(quote)) continue;
      if (/(?:тыс\.?|млн\.?|млрд\.?|за\s+(?:месяц|час|год|единицу))/iu.test(quote.replace(/\([^)]*\)/gu, ""))) { result.issues.push(`Источник «${source.name}»: масштаб или период цены требует ручной проверки.`); continue; }
      let values: ReturnType<typeof declared>;
      try { values = declared(quote); } catch { result.issues.push(`Источник «${source.name}»: неоднозначное денежное значение.`); continue; }
      if (values.net === undefined && values.gross === undefined) continue;
      const issues: string[] = [];
      const candidateTax = tax(quote), declaredCurrency = currency(quote);
      if (candidateTax.kind === "unknown") issues.push("В исходном ценовом условии не определён НДС.");
      if (declaredCurrency === "UNK") issues.push("Валюта исходной цены не определена однозначно.");
      if (source.coverage && (!source.coverage.complete || source.coverage.requiresOcr)) issues.push("Источник извлечён не полностью: проверьте цену и оговорки в оригинале.");
      const candidate: ProposalSourceFinancialCandidate = {
        id: `source-price-${identity(JSON.stringify([source.id, unit.id || unit.locator, quote]))}`, sourceId: source.id, sourceName: source.name,
        ...(source.sha256 && /^[a-f\d]{64}$/iu.test(source.sha256) ? { sourceSha256: source.sha256 } : {}), ...(unit.id ? { fragmentId: unit.id } : {}),
        locator: unit.locator, quote, sourceKind: /(?:начальн[а-я]*\s+максимальн[а-я]*|предельн[а-я]*\s+цена)/iu.test(quote) ? "procurementLimit" : kind,
        scope: "aggregate", currency: declaredCurrency, ...values, tax: candidateTax, issues,
      };
      let normalizedCandidate: ProposalSourceFinancialCandidate;
      try { normalizedCandidate = normalizeProposalSourceCandidate(candidate); }
      catch { return stop("Реквизиты ценового источника превышают пределы или повреждены. Ничего не усечено; проверьте источник вручную."); }
      const financialIssue = proposalSourceCandidateIssue(normalizedCandidate);
      if (financialIssue && !issues.includes(financialIssue)) normalizedCandidate.issues.push(financialIssue);
      if (result.candidates.some((previous) => previous.id === normalizedCandidate.id)) return stop("Идентичность нескольких ценовых условий неоднозначна. Цены не сопоставлены автоматически.");
      result.candidates.push(normalizedCandidate);
      if (result.candidates.length > 100) return stop("Слишком много исходных цен: разделите документы. Цены не усечены и не применены.");
    }
  }
  // Different candidate values are never silently resolved by first-match.
  for (const candidate of result.candidates) {
    const alternatives = result.candidates.filter((other) => other.sourceId === candidate.sourceId && other.id !== candidate.id);
    if (alternatives.some((other) => JSON.stringify([other.currency, other.net, other.vatAmount, other.gross, other.tax]) !== JSON.stringify([candidate.currency, candidate.net, candidate.vatAmount, candidate.gross, candidate.tax]))) candidate.issues.push("В документе несколько различных общих цен. Уточните, какая относится к этому объёму, прежде чем переносить цену.");
  }
  return result;
}

/** Re-extract selected immutable evidence at handoff. Candidates cannot be
 * copied to another source/card, amended by a model, or revived from hidden text. */
export function revalidateProposalSourceFinancials(candidates: readonly ProposalSourceFinancialCandidate[], sources: readonly IntelligenceSource[], sourceIds: readonly string[]): ProposalSourceFinancialCandidate[] {
  const stale = () => new Error("Исходная цена не подтверждается текущими выбранными материалами. Повторите анализ; цена не перенесена.");
  const supplied = createProposalSourceFinancials(candidates).candidates;
  if (new Set(sourceIds).size !== sourceIds.length || sourceIds.some((id) => !sources.some((source) => source.id === id))) throw stale();
  const fresh = extractProposalSourceFinancials(sources.filter((source) => sourceIds.includes(source.id)));
  if (fresh.limited) throw stale();
  return supplied.map((candidate) => {
    const matches = fresh.candidates.filter((current) => current.id === candidate.id && current.sourceId === candidate.sourceId && normalized(current.quote) === normalized(candidate.quote));
    if (!sourceIds.includes(candidate.sourceId) || matches.length !== 1 || JSON.stringify(normalizeProposalSourceCandidate(matches[0])) !== JSON.stringify(candidate)) throw stale();
    return structuredClone(matches[0]);
  });
}
