import type { IntelligenceFragment, IntelligenceSource } from "./workbenchTypes";

export type IntelligenceConditionCategory = "requirement" | "certificate" | "license" | "document" | "quantity" | "payment" | "delivery" | "exception";
export interface IntelligenceConditionSupport { sourceId: string; sourceName: string; fragmentId?: string; locator: string; quote: string; }
export interface IntelligenceConditionFact {
  sourceId: string;
  sourceName: string;
  fragmentId?: string;
  locator: string;
  /** Literal contiguous source text, not a model summary or a legal conclusion. */
  quote: string;
  category: IntelligenceConditionCategory;
  /** A complete literal row under an explicit, contiguous quantity table.
   * This is not a structured quantity or a SKU-to-configuration assignment. */
  explicitTableRole?: "quantity";
  /** Only the literal title cell of an explicit requirement/proof row. */
  explicitTableTitle?: string;
  /** A literal reduction/step or auto-extension clause, not a deadline shift. */
  explicitProcedure?: true;
  /** Freshly parsed, closed equipment-feature scope, never an input flag. */
  explicitTechnicalRole?: true;
  /** A child keeps its own literal quote; the scope heading is separate. */
  supportingEvidence?: IntelligenceConditionSupport[];
  /** A condition, alternative, external reference or unclear scope needs review. */
  ambiguous?: boolean;
  /** A literal candidate can remain useful for review without being safe to
   * copy as an application obligation. Never concatenate detached evidence. */
  automaticTransferRestriction?: "detached-scope" | "informational-document";
}

export const intelligenceConditionLimits = Object.freeze({ sources: 64, fragments: 5000, lines: 5000, characters: 2 * 1024 * 1024, quoteCharacters: 20000, listFieldCharacters: 2000, facts: 256 });
const certificate = /(?:сертификат|(?<![a-z0-9])(?:OSCP|OSEP|BSCP|OSWE|OSWP|KLCP|eJPT|eCPPT|CISSP|CISA|CISM|CEH|(?:CompTIA\s+)?PenTest\+?|HTB\s+CPTS)(?![a-z0-9]))/iu;
const license = /(?:лицензи|фстэк|фсб|тзки)/iu;
const specificDocument = /(?:копи[яиюй]|выписк|егрюл|егрип|декларац|кнд\s*1120101|карточк[аиу]\s+(?:предприятия|организации)|запрос\s+на\s+аккредитац|коммерческ[а-я\s]+предложен|проект\s+договора|одобрени[а-я\s]+сделк|согласии\s+на\s+совершение|полномочи|доверенност|реф[-\s]?лист|гарантийн[а-я\s]+письм|благодарственн[а-я\s]+письм|соглашени[а-я\s]+о\s+неразглашении|обезличенн[а-я\s]+отч[её]т)/iu;
const obligation = /(?:обязател|долж[а-я]*|необходим|требу[еёю][а-я]*|требован|предостав|представить|приложить|подтвердить|запрещ|фиксиру[а-я]*|не\s+подлежит\s+изменению|не\s+допуска|не\s+менее|не\s+более|не\s+позднее|не\s+ранее|непроведени|неприостановлени|отсутстви|соответств)/iu;
const payment = /(?<!\p{L})(?:оплат|постоплат|предоплат|аванс|расч[её]т[а-я]*\s+(?:между\s+сторонами|по\s+договору))/iu;
const delivery = /(?:срок[а-я]*\s+(?:поставк|исполнен|выполнен|оказан)|(?:поставка|поставки|поставить|доставка|доставки)(?!\p{L})|срок[а-я]*\s+реакци|восстановлен|гаранти[яиюй]|адрес,?\s+условия\s+и\s+сроки)/iu;
const quantity = /(?:\d+(?:[.,]\d+)?\s*(?:шт(?:ук)?\.?|единиц[а-я]*|сервер[а-я]*|специалист[а-я]*|сотрудник[а-я]*|человек|проект[а-я]*|экземпляр[а-я]*|комплект[а-я]*|лицензий|%)(?!\p{L})|(?:^|\t)(?:шт|ед|компл)\.?\t\s*\d+(?:[.,]\d+)?|(?:не\s+менее|не\s+более|минимум|максимум)\s+\d+|(?<!\p{L})(?:кол-во|количество)(?!\p{L}))/iu;
const conditional = /(?:при\s+наличии|если|за\s+исключением|в\s+случае|при\s+условии|(?:^|[^\p{L}])(?:или|либо)(?=$|[^\p{L}])|не\s+включа[а-я]*|могут\s+не|допускается|не\s+ранее|нерезидент|(?:один|одного|одним|одна|одно)\s+из)/iu;
const exemption = /(?:могут\s+не\s+включа[а-я]*|не\s+включа[а-я]*\s+участником|не\s+требу[её][а-я]*|не\s+предоставля[а-я]*|за\s+исключением)/iu;
const externalScope = /(?:согласно|в\s+соответствии\s+с|см\.|указан[а-я]*\s+в|предусмотрен[а-я]*\s+(?:настоящим|пунктом)|по\s+каждому\s+(?:лоту|этапу)|техническ[а-я\s]+задани|таблиц[аеу]\s+\d)/iu;
const listStart = /^\s*(?:\d+(?:\.\d+)*[.)]\s+|[а-яa-z][)]\s+|[•●▪]\s*|[oо]\t|[-–—]\s+)/iu;
const numberedStart = /^\s*\d+(?:\.\d+)*[.)]\s+/u;
// Only exact, content-free section labels are skipped. A heading is also a
// boundary, so it can never become the tail of the preceding certificate.
const sectionHeading = /^\s*(?:\d+(?:\.\d+)*[.)]?\s+)?(?:сертификаты(?:\s+(?:специалистов|сотрудников))?|документы(?:\s+(?:(?:в\s+)?составе\s+заявки|заявки))?|состав\s+заявки|перечень\s+документов)\s*:\s*$/iu;
const documentCopyStart = /^\s*(?:\d+(?:\.\d+)*[.)]\s+|[а-яa-z][)]\s+|[•●▪]\s*|[oо]\t|[-–—]\s+)?копи[яиюй](?!\p{L})/iu;
const strongStart = /^\s*(?:условия\s+оплаты|оплата|порядок\s+оплаты|срок[а-я]*\s+(?:поставки|исполнения|выполнения|оказания|реакции)|место\s+поставки|адрес,?\s+условия\s+и\s+сроки|гарантия|при\s+взаимодействии|исполнитель|участник|необходимо|требуется|предоставить|представить|копия|копии|декларация|решение|запрос\s+на\s+аккредитацию|кнд\s+1120101|типовой\s+проект|лицензия|сертификат|OSCP\b|OSEP\b|BSCP\b|OSWE\b|OSWP\b|KLCP\b|eJPT\b|CompTIA\b|HTB\s+CPTS\b)/iu;
const alternativeIntro = /(?:(?:один|одного|одним|одна|одно)\s+из|следующ[а-я]*\s+вариант|(?:предостав|представ)[а-я\s]{0,30}(?:документ|подтверждени)[^\n]{0,120}:\s*$)/iu;
const labeledStart = /^\s*(?:условия\s+оплаты|оплата|порядок\s+оплаты|фиксация\s+цены|срок[а-я]*\s+(?:поставки|исполнения|выполнения|оказания|реакции)|место\s+поставки|адрес,?\s+условия\s+и\s+сроки|гарантия)[^:\n\t]{0,80}[:\t]/iu;
const procedureStart = /^\s*(?:\d+[.)]\s*)?(?:автопродление\s+при[её]ма\s+(?:предложений|заявок)|после\s+подачи\s+первого\s+предложения|минимальн[а-я]*\s+шаг(?:\s+изменения)?\s+цены)(?=$|[\s:\t,])/iu;
const applicabilityIntro = /^\s*(?:\d+(?:\.\d+)*[.)]\s*)?(?:(?:только|исключительно)\s+для[^:\n]{1,160}|для\s+(?:не)?резидент[^:\n]{0,140}):\s*$/iu;
const choiceIntro = /(?:один|одного|одним|одна|одно)\s+из[^\n]{0,200}:\s*$/iu;
const scopedIntro = (text: string) => applicabilityIntro.test(text) || choiceIntro.test(text);
const historicalContext = /(?:обосновани[ея]\s+(?:нмц|начальн)|источники?\s+ценовой\s+информации|ранее\s+полученн[а-я\s]*предложен)/iu;
const applicationRequest = /(?:(?:участник|поставщик|претендент)[^\n]{0,100}(?:представ|предостав|прилаг|направ|включ)|(?:представ|предостав|прилож|включ)[^\n]{0,100}(?:в\s+состав|к\s+заявк|заявк)|документы\s+в\s+составе\s+заявки|состав\s+заявки)/iu;
const licenceProofDocument = /(?:предостав|представ|прилож|включ)[^\n]{0,160}документ[^\n]{0,240}(?:сведен|подтвержден|подтвержда)/iu;

function included(fragment: IntelligenceFragment): boolean {
  return fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden" || fragment.includedByUser === true;
}
type Budget = { lines: number; limited: boolean };

function conditionTableCoordinate(fragment: IntelligenceFragment): { key: string; row: number } | undefined {
  const row = /^(table(?:-\d+)?|sheet-\d+)-row-(\d+)$/u.exec(fragment.id || "");
  if (!row) return;
  return { key: `${fragment.sheetId || ""}:${row[1]}`, row: Number(row[2]) };
}

const technicalLabel = /^\s*(?:[•●▪–—-]\s*)?(?:климатический\s+режим|условия\s+эксплуатации|рабочая\s+температура|охлаждение|место\s+(?:передачи|поставки)(?:\s+(?:оборудования|товара))?)\s*:\s*\S/iu;
const technicalHeading = (text: string) => /(?:сервер|оборудование|модуль|контроллер)(?:[а-я]*)\s+долж[а-я]*(?!\p{L})/iu.test(text)
  && /следующ[а-я]*\s+(?:функци|возможност)[а-я]*\s*:\s*$/iu.test(text);

/** A feature list is owned only by a visible, contiguous paragraph block with
 * an explicit equipment obligation and an independent closing condition.
 * EOF, hidden/gapped rows and arbitrary new headings never close a prefix. */
function explicitTechnicalParagraphs(source: IntelligenceSource, fragments: readonly IntelligenceFragment[], remainingCharacters: number) {
  const roles = new Map<IntelligenceFragment, { supportingEvidence?: IntelligenceConditionSupport[] }>(), headers = new Set<IntelligenceFragment>(), standalone = new Set<IntelligenceFragment>();
  const seen = new Set<string>(), duplicates = new Set<string>(); let characters = 0, limited = fragments.length > intelligenceConditionLimits.fragments;
  for (const fragment of fragments.slice(0, intelligenceConditionLimits.fragments)) {
    if (fragment.id) { if (seen.has(fragment.id)) duplicates.add(fragment.id); seen.add(fragment.id); }
    if (included(fragment)) characters += fragment.text.length;
    if (characters > remainingCharacters) { limited = true; break; }
  }
  if (limited) return { roles, headers, standalone, limited };
  const coordinate = (fragment: IntelligenceFragment) => {
    const id = /^paragraph-([1-9]\d*)$/u.exec(fragment.id || ""), locator = /^Абзац\s+([1-9]\d*)$/iu.exec(fragment.locator.trim());
    if (!id || !locator || !Number.isSafeInteger(Number(id[1])) || Number(id[1]) !== Number(locator[1]) || duplicates.has(fragment.id!)) return undefined;
    if (fragment.sheetState === "hidden" || fragment.sheetState === "veryHidden" || !fragment.text.trim() || fragment.text.includes("\t")) return undefined;
    return Number(id[1]);
  };
  for (const [index, fragment] of fragments.entries()) {
    if (coordinate(fragment) === undefined) continue;
    if (technicalLabel.test(fragment.text)) { standalone.add(fragment); roles.set(fragment, {}); }
    if (!technicalHeading(fragment.text)) continue;
    headers.add(fragment);
    let previous = fragment, count = 0, size = fragment.text.length, closed = false;
    const children: IntelligenceFragment[] = [];
    for (let nextIndex = index + 1; nextIndex < fragments.length; nextIndex++) {
      const next = fragments[nextIndex], number = coordinate(next), previousNumber = coordinate(previous);
      if (number === undefined || previousNumber === undefined || number !== previousNumber + 1 || next.sheetId !== previous.sheetId) break;
      if (technicalLabel.test(next.text) || labeledStart.test(next.text)) { closed = children.length > 0; break; }
      if (technicalHeading(next.text) || /[:：]/u.test(next.text) || /^\s*(?:коммерческое\s+предложение|техническое\s+задание|договор|контракт|новая\s+закупка)(?=$|[\s№])/iu.test(next.text)) break;
      if (++count > 32 || (size += next.text.length) > intelligenceConditionLimits.quoteCharacters) { limited = true; break; }
      children.push(next); previous = next;
    }
    if (!closed) continue;
    const support: IntelligenceConditionSupport = { sourceId: source.id, sourceName: source.name, fragmentId: fragment.id, locator: fragment.locator, quote: fragment.text };
    roles.set(fragment, {});
    for (const child of children) roles.set(child, { supportingEvidence: [support] });
  }
  return { roles, headers, standalone, limited };
}
/** An explicitly headed requirement+proof table owns its complete rows. A bare
 * heading is not itself a document to submit. Context stops at gaps, hidden
 * rows, another table or a different column shape. */
function explicitRequirementRows(fragments: readonly IntelligenceFragment[]): { headers: Set<IntelligenceFragment>; rows: Set<IntelligenceFragment>; quantityHeaders: Set<IntelligenceFragment>; quantityRows: Set<IntelligenceFragment>; titles: Map<IntelligenceFragment, string> } {
  const headers = new Set<IntelligenceFragment>(), rows = new Set<IntelligenceFragment>(), quantityHeaders = new Set<IntelligenceFragment>(), quantityRows = new Set<IntelligenceFragment>();
  const titles = new Map<IntelligenceFragment, string>();
  const seen = new Set<string>(), duplicates = new Set<string>();
  for (const fragment of fragments) if (fragment.id) { if (seen.has(fragment.id)) duplicates.add(fragment.id); seen.add(fragment.id); }
  let owner: { key: string; row: number; index: number; columns: number; serial: number; title: number; kind: "requirement" | "quantity" } | undefined;
  for (const [index, fragment] of fragments.entries()) {
    const coordinate = conditionTableCoordinate(fragment), cells = fragment.text.split("\t");
    if (!included(fragment) || !coordinate || fragment.id && duplicates.has(fragment.id)) { owner = undefined; continue; }
    const header = cells.length >= 3 && /^(?:№|номер|№\s*п\s*\/\s*п)$/iu.test(cells[0].trim())
      && cells.some((cell) => /^(?:содержание|описание|наименование)\s+требования$/iu.test(cell.trim()))
      && cells.some((cell) => /^(?:документы|сведения|документы\s*\/\s*сведения)\s+(?:для\s+)?подтверждения$/iu.test(cell.trim()));
    if (header) { headers.add(fragment); owner = { ...coordinate, index, columns: cells.length, serial: 0, title: cells.findIndex((cell) => /^наименование\s+требования$/iu.test(cell.trim())), kind: "requirement" }; continue; }
    const quantityHeader = cells.length >= 3 && /^№/u.test(cells[0].trim())
      && cells.some((cell) => /наименовани[ея]\s+(?:оборудования|товара|изделия|комплектующ)/iu.test(cell))
      && /^(?:кол-во|количество)(?:\s|$)/iu.test(cells[cells.length - 1].trim());
    if (quantityHeader) { quantityHeaders.add(fragment); owner = { ...coordinate, index, columns: cells.length, serial: 0, title: -1, kind: "quantity" }; continue; }
    if (owner?.kind === "quantity") {
      if (owner.key !== coordinate.key || owner.row + 1 !== coordinate.row || owner.index + 1 !== index
        || cells.length < 3 || cells.length > owner.columns + 4 || !/^\s*\d{1,3}(?:\.\d{1,3}){0,4}[.)]?\s*$/u.test(cells[0])
        || !/^\s*(?:\d+(?:[.,]\d+)?|[хx—-])\s*$/iu.test(cells[cells.length - 1]) || !/[\p{L}]/u.test(cells.slice(1, -1).join(" "))) { owner = undefined; continue; }
      owner = { ...owner, row: coordinate.row, index }; quantityRows.add(fragment); continue;
    }
    const serial = /^\s*(\d{1,3})[.)]?\s*$/u.exec(cells[0])?.[1];
    if (!owner || owner.key !== coordinate.key || owner.row + 1 !== coordinate.row || owner.index + 1 !== index || cells.length !== owner.columns || !serial || Number(serial) !== owner.serial + 1) { owner = undefined; continue; }
    owner = { ...owner, row: coordinate.row, index, serial: Number(serial) };
    if (cells.slice(1).every((cell) => cell.trim())) { rows.add(fragment); if (owner.title >= 0) titles.set(fragment, cells[owner.title].trim()); }
  }
  return { headers, rows, quantityHeaders, quantityRows, titles };
}

/** Split explicit list entries, but keep wrapped prose and choice continuations
 * intact. No text from a different fragment or source enters a candidate. */
function* literalUnits(text: string, budget: Budget, onSection?: (heading: string) => void): Generator<string> {
  let start = 0, position = 0, hasLine = false, alternatives = false, scoped = false, priorSentenceEnded = false;
  while (position < text.length) {
    if (budget.lines >= intelligenceConditionLimits.lines) { budget.limited = true; return; }
    budget.lines++;
    const newline = text.indexOf("\n", position), end = newline < 0 ? text.length : newline;
    if (sectionHeading.test(text.slice(position, end))) {
      const prior = text.slice(start, position).trim();
      if (prior) yield prior;
      onSection?.(text.slice(position, end));
      position = newline < 0 ? text.length : newline + 1;
      start = position; hasLine = false; alternatives = false; scoped = false; priorSentenceEnded = false;
      continue;
    }
    const prefix = text.slice(position, Math.min(end, position + 240));
    const startsNumber = numberedStart.test(prefix);
    const boundary = hasLine && (scopedIntro(prefix) || procedureStart.test(prefix) || startsNumber && !scoped
      || (!alternatives && (listStart.test(prefix) || labeledStart.test(prefix) || priorSentenceEnded && strongStart.test(prefix)))
      || scoped && priorSentenceEnded && !listStart.test(prefix) && strongStart.test(prefix));
    if (boundary) {
      const quote = text.slice(start, position).trim();
      if (quote) yield quote;
      start = position; alternatives = false; scoped = false;
    }
    if (alternativeIntro.test(prefix)) alternatives = true;
    if (scopedIntro(prefix)) { alternatives = true; scoped = true; }
    if (prefix.trim()) priorSentenceEnded = /[.!?][»”"')]*\s*$/u.test(text.slice(Math.max(position, end - 12), end));
    hasLine = true;
    position = newline < 0 ? text.length : newline + 1;
  }
  const quote = text.slice(start).trim();
  if (quote) yield quote;
}

function classify(quote: string): { category: IntelligenceConditionCategory; ambiguous?: boolean; explicitProcedure?: true } | null {
  if (/^(?:[\d.)•\s]*)(?:документы\s+заявки|состав\s+заявки|перечень\s+документов|условия\s+оплаты|сроки?\s+поставки)\s*:?\s*$/iu.test(quote)) return null;
  if (/^(?:\d+[.)]\s*)?(?:требования?\s+к\s+(?:содержанию|составу)|инструкция\s+по\s+заполнению|к\s+требованиям\s+к\s+содержанию)/iu.test(quote) && quote.length < 240) return null;
  const hasCertificate = certificate.test(quote), hasLicense = license.test(quote);
  const hasObligation = obligation.test(quote), hasQuantity = quantity.test(quote) && /\d/u.test(quote);
  const hasDocument = specificDocument.test(quote) || /документ/iu.test(quote) && (hasObligation || listStart.test(quote) || conditional.test(quote));
  const documentRole = hasDocument && (!/без\s+доверенности/iu.test(quote) || /(?:копи|документ|полномочи)/iu.test(quote));
  const procedure = procedureStart.test(quote) && /(?:\d+(?:[.,]\d+)?\s*(?:%|минут[а-я]*|мин\.)|редукцион|только\s+пониж[а-я]*\s+цену)/iu.test(quote);
  let category: IntelligenceConditionCategory;
  if (hasCertificate) category = "certificate";
  // Requesting a copy of a licence is an application document, not a bare
  // licensing qualification. Keep the whole clause, including any exceptions.
  else if (hasLicense && (documentCopyStart.test(quote) || licenceProofDocument.test(quote))) category = "document";
  // A regulator can be the recipient of a declaration or authority document;
  // its name alone does not change that document into a licensing obligation.
  else if (hasLicense && !/лицензи/iu.test(quote) && documentRole) category = exemption.test(quote) ? "exception" : "document";
  else if (hasLicense) category = "license";
  else if (exemption.test(quote)) category = "exception";
  else if (documentRole) category = "document";
  else if (payment.test(quote)) category = "payment";
  else if (delivery.test(quote)) category = "delivery";
  else if (procedure) category = "requirement";
  else if (hasQuantity) category = "quantity";
  else if (hasObligation || listStart.test(quote)) category = "requirement";
  else if (conditional.test(quote)) category = "exception";
  else return null;
  const ambiguous = quote.length > intelligenceConditionLimits.listFieldCharacters || conditional.test(quote) || externalScope.test(quote) || /:\s*$/u.test(quote) || (category === "requirement" && !hasObligation) || (category === "quantity" && !hasObligation);
  return { category, ...(ambiguous || procedure ? { ambiguous: true } : {}), ...(procedure ? { explicitProcedure: true } : {}) };
}

/** A bounded review inventory, not legal interpretation or proof of completeness.
 * Pass only selected sources. An explicit fragments array is authoritative;
 * aggregate text never restores removed fragments or excluded workbook sheets. */
export function extractIntelligenceConditionFacts(sources: readonly IntelligenceSource[]): { facts: IntelligenceConditionFact[]; limited: boolean } {
  const facts: IntelligenceConditionFact[] = [], seen = new Set<string>();
  const budget: Budget = { lines: 0, limited: false };
  let characters = 0, fragmentCount = 0;
  outer: for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    if (sourceIndex >= intelligenceConditionLimits.sources) { budget.limited = true; break; }
    const source = sources[sourceIndex];
    const fragments = source.fragments === undefined ? [{ locator: "Текст источника", text: source.text }] : source.fragments;
    const requirementTable = explicitRequirementRows(fragments.slice(0, intelligenceConditionLimits.fragments));
    const technical = explicitTechnicalParagraphs(source, fragments, intelligenceConditionLimits.characters - characters);
    budget.limited ||= technical.limited;
    let detachedScope = false, informational = false, incompleteTechnical = false;
    for (const fragment of fragments) {
      if (++fragmentCount > intelligenceConditionLimits.fragments) { budget.limited = true; break outer; }
      if (!included(fragment)) { detachedScope = false; informational = false; continue; }
      if (!fragment.text.length) continue;
      if (characters + fragment.text.length > intelligenceConditionLimits.characters) { budget.limited = true; continue; }
      characters += fragment.text.length;
      if (technical.headers.has(fragment)) incompleteTechnical = !technical.roles.has(fragment);
      else if (technical.standalone.has(fragment) || labeledStart.test(fragment.text)) incompleteTechnical = false;
      if (requirementTable.headers.has(fragment)) { detachedScope = false; informational = false; continue; }
      if (requirementTable.quantityHeaders.has(fragment)) continue;
      // A fragment boundary is not permission to strip a scope heading. Such a
      // candidate stays literal and reviewable, but requires manual assignment.
      // Hidden fragments cannot contribute scope or be resurrected as evidence.
      const firstLine = fragment.text.trimStart().split("\n", 1)[0];
      if (sectionHeading.test(firstLine)) detachedScope = false;
      if (applicationRequest.test(firstLine) && !scopedIntro(firstLine)) informational = false;
      const completeTableRow = requirementTable.rows.has(fragment) || requirementTable.quantityRows.has(fragment), technicalRole = technical.roles.get(fragment);
      const units = completeTableRow || technicalRole ? [fragment.text] : literalUnits(fragment.text, budget, (heading) => {
        detachedScope = false;
        if (applicationRequest.test(heading)) informational = false;
      });
      if (completeTableRow || technicalRole) budget.lines++;
      for (const quote of units) {
        if (quote.length > intelligenceConditionLimits.quoteCharacters) { budget.limited = true; continue; }
        const condition = requirementTable.rows.has(fragment) ? { category: "document" as const, ...(requirementTable.titles.has(fragment) ? { explicitTableTitle: requirementTable.titles.get(fragment) } : {}), ...(conditional.test(quote) || externalScope.test(quote) || /_{2,}/u.test(quote) ? { ambiguous: true } : {}) }
          : requirementTable.quantityRows.has(fragment) ? { category: "quantity" as const, explicitTableRole: "quantity" as const, ...(conditional.test(quote) || externalScope.test(quote) || /\t\s*[хx—-]\s*$/iu.test(quote) ? { ambiguous: true } : {}) }
          : technicalRole ? { category: /^\s*место\s+(?:передачи|поставки)/iu.test(quote) ? "delivery" as const : "requirement" as const, explicitTechnicalRole: true as const, ambiguous: true as const, ...technicalRole } : classify(quote);
        if (historicalContext.test(quote)) informational = true;
        else if (applicationRequest.test(quote)) informational = false;
        if (!condition) continue;
        const key = JSON.stringify([source.id, condition.category, quote]);
        if (seen.has(key)) continue;
        if (facts.length >= intelligenceConditionLimits.facts) { budget.limited = true; break outer; }
        seen.add(key);
        const restriction = informational ? "informational-document" : detachedScope || incompleteTechnical ? "detached-scope" : undefined;
        facts.push({ sourceId: source.id, sourceName: source.name, fragmentId: fragment.id, locator: fragment.locator, quote, ...condition,
          ...(restriction ? { automaticTransferRestriction: restriction, ambiguous: true } : {}) });
      }
      if (scopedIntro(fragment.text.trim()) && !fragment.text.trim().includes("\n")) detachedScope = true;
      if (budget.lines >= intelligenceConditionLimits.lines) {
        // Remaining fragments may contain more candidates. Do not silently
        // present a scan that stopped at its work limit as an exhaustive list.
        if (fragments.indexOf(fragment) < fragments.length - 1 || sourceIndex < sources.length - 1) budget.limited = true;
        break outer;
      }
    }
  }
  return { facts, limited: budget.limited };
}
