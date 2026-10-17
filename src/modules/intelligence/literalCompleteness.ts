import type { EvidenceExcerpt, IntelligenceDateFact } from "./resultEvidence";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

export interface LiteralCompletenessCandidate {
  itemId: string;
  code: "missing-contract-card" | "missing-proposal-date" | "missing-payment-clause" | "literal-completeness-limit";
  message: string;
  evidence: EvidenceExcerpt[];
  /** Missing fields deliberately have no field gate: excluding an absent field
   * must not silently dismiss the source-completeness warning. */
  field?: string;
}

export const LITERAL_COMPLETENESS_LIMITS = { items: 100, sources: 100, fragments: 5000, bytes: 2 * 1024 * 1024, fragmentCharacters: 20000, signals: 256 } as const;
interface Material { source: IntelligenceSource; fragment: IntelligenceFragment; index: number }
const normalized = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/gu, "е").replace(/[‐‑–—]/gu, "-").replace(/[«»„“”]/gu, '"').replace(/\s+/gu, " ").trim();
const included = (fragment: IntelligenceFragment) => !["hidden", "veryHidden"].includes(fragment.sheetState || "visible") || fragment.includedByUser === true;
const numberKey = (value: string) => normalized(value).replace(/^№\s*/u, "").replace(/\s+/gu, "");
function numberAliases(value: string): string[] {
  const full = numberKey(value);
  // A separate long, compact registry identifier can accompany an explicit
  // primary contract token. This is intentionally not general parenthesis
  // stripping: short suffixes, revisions, prose and dates remain part of the
  // printed number; the registry identifier alone never becomes an alias.
  const registry = /^([\p{L}\d][\p{L}\d/_.-]{0,79})\s+\(\d{3,12}(?:[-/]\d{3,12}){2,4}\)$/u.exec(normalized(value));
  return registry ? [full, numberKey(registry[1])] : [full];
}
const selectedString = (item: IntelligenceItem, field: string) => item.selectedFields.includes(field) && typeof item.fields[field] === "string" ? item.fields[field] as string : "";
const excerpt = ({ source, fragment }: Material, quote = fragment.text): EvidenceExcerpt => ({ sourceId: source.id, sourceName: source.name, ...(fragment.id ? { fragmentId: fragment.id } : {}), locator: fragment.locator, quote });
const validIso = (iso: string) => /^\d{4}-\d{2}-\d{2}$/u.test(iso) && Number.isFinite(Date.parse(`${iso}T00:00:00Z`)) && new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso;

function tableCoordinate(fragment: IntelligenceFragment) {
  const id = /^(table(?:-\d+)?)-row-(\d+)$/u.exec(fragment.id || "");
  const locator = /^(таблица(?:\s*№?\s*\d+)?),?\s*строка\s+(\d+)$/iu.exec(fragment.locator.trim());
  if (!id && !locator) return null;
  // An explicit table identity is never replaced by the generic DOCX label.
  const key = id && id[1] !== "table" ? id[1] : locator ? normalized(locator[1]) : id![1];
  return { key: `${fragment.sheetId || ""}:${key}`, row: Number(id?.[2] || locator![2]) };
}

function contractTableRows(material: Material[]): Array<{ number: string; iso: string; evidence: EvidenceExcerpt }> {
  const found: Array<{ number: string; iso: string; evidence: EvidenceExcerpt }> = [];
  const seen = new Set<string>();
  let owner: { key: string; row: number; index: number; columns: number; subject: number; serial: number } | null = null;
  for (const entry of material) {
    const coordinate = tableCoordinate(entry.fragment), cells = entry.fragment.text.split("\t");
    if (!coordinate) { owner = null; continue; }
    const subject = cells.findIndex((cell) => /предмет/iu.test(cell) && /договор/iu.test(cell));
    const header = cells.length >= 4 && subject >= 0 && cells.some((cell) => /заказчик/iu.test(cell)) && cells.some((cell) => /сумма\s+договора/iu.test(cell)) && /№|п\s*\/\s*п/iu.test(cells[0]);
    if (header) { owner = { ...coordinate, index: entry.index, columns: cells.length, subject, serial: 0 }; continue; }
    const serial = /^\s*(\d{1,3})[.)]?\s*$/u.exec(cells[0])?.[1];
    if (!owner || owner.key !== coordinate.key || coordinate.row !== owner.row + 1 || entry.index !== owner.index + 1 || cells.length !== owner.columns || !serial || Number(serial) !== owner.serial + 1) { owner = null; continue; }
    owner = { ...owner, row: coordinate.row, index: entry.index, serial: Number(serial) };
    const matches = [...cells[owner.subject].matchAll(/(?:^|[^\p{L}])договор\s*№\s*([^\t\n]{1,180}?)\s+от\s+(\d{2})[./](\d{2})[./](\d{4})(?=$|[^\d])/giu)];
    if (matches.length !== 1) continue;
    const match = matches[0], number = match[1].trim(), iso = `${match[4]}-${match[3]}-${match[2]}`;
    if (!/[\p{L}\d]/u.test(number) || /^[_\s.…-]+$/u.test(number) || !validIso(iso)) continue;
    const key = `${numberKey(number)}:${iso}`;
    if (!seen.has(key)) { seen.add(key); found.push({ number, iso, evidence: excerpt(entry) }); }
  }
  return found;
}

function paymentClauses(material: Material[]): EvidenceExcerpt[] {
  const clauses: EvidenceExcerpt[] = [];
  let active = false, previous: Material | undefined;
  const paragraphScope = (entry: Material) => /^paragraph-\d+$/iu.test(entry.fragment.id || "") || /^Абзац\s+\d+$/iu.test(entry.fragment.locator) ? `paragraph:${entry.fragment.sheetId || ""}` : `fragment:${entry.index}`;
  for (const entry of material) {
    if (previous && (entry.index !== previous.index + 1 || paragraphScope(entry) !== paragraphScope(previous))) active = false;
    previous = entry;
    if (tableCoordinate(entry.fragment)) { active = false; continue; }
    for (const raw of entry.fragment.text.split(/\r?\n/u)) {
      const line = raw.trim(), heading = line.replace(/^\d{1,3}[.)]\s*/u, "");
      if (/^(?:условия|порядок)\s+оплаты\s*[:.]?$/iu.test(heading)) { active = true; continue; }
      if (!line) continue;
      if (line.length <= 140 && /[:：]$/u.test(line) || /^(?:оговорки|срок\s+действия\s+предложения|коммерческое\s+предложение|с\s+уважением|генеральный\s+директор)(?:[^\p{L}]|$)/iu.test(line)) { active = false; continue; }
      if (!active || !/(?:аванс|предоплат|постоплат|оплат|плат[её]ж|расч[её]т)/iu.test(line) || !/(?:\d\s*%|дн[её]й|календарных|подписан|при[её]мк|отказ)/iu.test(line)) continue;
      if (!clauses.some((fact) => normalized(fact.quote) === normalized(line))) clauses.push(excerpt(entry, line));
    }
  }
  return clauses;
}

/** Additional conservative review signals, never a parser that creates or
 * fills records. Explicit fragments are authoritative; names are not facts.
 * No source-to-source, table-to-table or hidden-sheet context inheritance. */
export function collectLiteralCompleteness(items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[], dateFacts: readonly IntelligenceDateFact[] = []): LiteralCompletenessCandidate[] {
  const limits = LITERAL_COMPLETENESS_LIMITS;
  const eligible = items.slice(0, limits.items).filter((item) => item.destination === "contracts" || item.destination === "proposals");
  if (!eligible.length) return [];
  const signals: LiteralCompletenessCandidate[] = [];
  let limited = items.length > limits.items || sources.length > limits.sources || dateFacts.length > 1000, fragmentCount = 0, totalBytes = 0;
  const boundedDates = dateFacts.slice(0, 1000);
  // Reserve room for a limit warning on every affected card, not just the card
  // that happened to fill the budget first.
  const add = (candidate: LiteralCompletenessCandidate) => {
    if (signals.length < limits.signals - eligible.length) signals.push(candidate); else limited = true;
  };
  const sourceIds = new Set<string>(), duplicateSources = new Set<string>();
  for (const source of sources.slice(0, limits.sources)) { if (sourceIds.has(source.id)) duplicateSources.add(source.id); sourceIds.add(source.id); }
  for (const source of sources.slice(0, limits.sources)) {
    if (!source.id || duplicateSources.has(source.id)) continue;
    const owners = eligible.filter((item) => item.sourceIds.includes(source.id));
    if (!owners.length) continue;
    const allFragments = source.fragments === undefined ? [{ locator: "Текст источника", text: source.text }] : source.fragments;
    const material: Material[] = [];
    const ids = new Set<string>(), duplicateIds = new Set<string>();
    for (const fragment of allFragments.slice(0, Math.max(0, limits.fragments - fragmentCount))) { if (fragment.id && ids.has(fragment.id)) duplicateIds.add(fragment.id); if (fragment.id) ids.add(fragment.id); }
    for (const [index, fragment] of allFragments.entries()) {
      if (++fragmentCount > limits.fragments) { limited = true; break; }
      if (!included(fragment) || fragment.id && duplicateIds.has(fragment.id)) continue;
      if (fragment.text.length > limits.fragmentCharacters) { limited = true; continue; }
      totalBytes += new TextEncoder().encode(fragment.text).byteLength;
      if (totalBytes > limits.bytes) { limited = true; break; }
      material.push({ source, fragment, index });
    }
    const contracts = owners.filter((item) => item.destination === "contracts");
    const contractRows = contracts.length ? contractTableRows(material) : [];
    const datesByNumber = new Map<string, Set<string>>();
    const fullNumbersByAliasDate = new Map<string, Set<string>>();
    for (const fact of contractRows) for (const key of numberAliases(fact.number)) {
      const dates = datesByNumber.get(key) || new Set<string>(); dates.add(fact.iso); datesByNumber.set(key, dates);
      const identity = `${key}:${fact.iso}`, numbers = fullNumbersByAliasDate.get(identity) || new Set<string>(); numbers.add(numberKey(fact.number)); fullNumbersByAliasDate.set(identity, numbers);
    }
    for (const fact of contractRows) {
      const aliases = numberAliases(fact.number), full = numberKey(fact.number);
      const repeatedNumber = aliases.some((key) => datesByNumber.get(key)!.size > 1);
      if (contracts.some((item) => {
        const selected = numberKey(selectedString(item, "number"));
        return aliases.includes(selected) && (!repeatedNumber || selectedString(item, "date") === fact.iso)
          && (selected === full || fullNumbersByAliasDate.get(`${selected}:${fact.iso}`)?.size === 1);
      })) continue;
      const message = repeatedNumber
        ? `В явной таблице опыта номер договора № ${fact.number} повторяется с разными полными датами. Строка от ${fact.iso} не найдена среди карточек с этим номером и выбранной соответствующей датой. Сверьте отдельные договоры; одна карточка с номером без даты не подтверждает обе строки.`
        : `В явной таблице опыта есть отдельный договор № ${fact.number}, но среди переносимых карточек этого источника его номер не найден. Проверьте полноту перечня; строки таблицы не создают карточки автоматически.`;
      for (const item of contracts) add({ itemId: item.id, code: "missing-contract-card", message, evidence: [fact.evidence] });
    }
    const proposals = owners.filter((item) => item.destination === "proposals");
    if (proposals.length !== 1) continue;
    const item = proposals[0];
    const freshProof = (proof: EvidenceExcerpt) => proof.sourceId === source.id && proof.sourceName === source.name && Boolean(proof.quote.trim())
      && material.some(({ fragment }) => fragment.id === proof.fragmentId && fragment.locator === proof.locator && normalized(fragment.text).includes(normalized(proof.quote)));
    const freshDates = boundedDates.filter((fact) => fact.event === "proposal-date" && validIso(fact.iso) && freshProof(fact)
      && (fact.supportingEvidence || []).every(freshProof));
    if (freshDates.length && !freshDates.some((fact) => fact.ambiguous || fact.lowerBound) && new Set(freshDates.map((fact) => fact.iso)).size === 1 && selectedString(item, "documentDate") !== freshDates[0].iso) {
      const fact = freshDates[0];
      const proofs = [fact, ...(fact.supportingEvidence || [])].map((proof) => ({ sourceId: proof.sourceId, sourceName: proof.sourceName, ...(proof.fragmentId ? { fragmentId: proof.fragmentId } : {}), locator: proof.locator, quote: proof.quote }));
      add({ itemId: item.id, code: "missing-proposal-date", message: `Источник явно указывает дату КП ${fact.iso}, но выбранное поле даты её не сохраняет. Сверьте дату письма; срок действия и даты других событий не подставляются автоматически.`, evidence: proofs.filter((proof, index) => proofs.findIndex((other) => other.fragmentId === proof.fragmentId && other.locator === proof.locator && other.quote === proof.quote) === index) });
    }
    const payment = normalized(selectedString(item, "paymentTerms"));
    for (const fact of paymentClauses(material)) if (!payment.includes(normalized(fact.quote))) add({ itemId: item.id, code: "missing-payment-clause", message: "В разделе оплаты источника есть этап с долей, сроком или событием, который не сохранён целиком в выбранных условиях оплаты КП. Проверьте полную формулировку, включая альтернативы приёмки/отказа; наличие одного аванса не подтверждает полноту оплаты.", evidence: [fact] });
  }
  if (limited) for (const item of eligible) signals.push({ itemId: item.id, code: "literal-completeness-limit", message: "Проверка буквальной полноты достигла бюджета (100 источников/карточек, 5000 фрагментов, 2 МиБ, 20000 символов в одном фрагменте или 256 сигналов). Полнота не подтверждена: разделите материалы или сверьте их вручную.", evidence: [] });
  return signals;
}
