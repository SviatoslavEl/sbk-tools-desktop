import { multipleLots } from "./automaticConditions";
import type {
  IntelligenceDestination, IntelligenceEvidence, IntelligenceFieldValue, IntelligenceFragment,
  IntelligenceItem, IntelligenceSource,
} from "./workbenchTypes";

export interface SourcePreparationProvenance {
  sourceId: string; sourceName: string; fragmentId?: string; locator: string; quote: string;
}
export interface SourcePreparationChange extends SourcePreparationProvenance {
  itemId: string; field: string; kind: "added" | "replaced" | "created" | "quarantined";
  previousValue?: IntelligenceFieldValue; value?: IntelligenceFieldValue; requiresReview: true;
}
export interface SourcePreparationSkipped extends Partial<SourcePreparationProvenance> {
  itemId?: string; field?: string; reason: string; message: string; requiresReview: true;
}
export interface SourcePreparationResult {
  items: IntelligenceItem[]; changes: SourcePreparationChange[]; skipped: SourcePreparationSkipped[]; limited: boolean;
}
export const SOURCE_PREPARATION_LIMITS = Object.freeze({
  items: 100, sources: 100, fragments: 5000, bytes: 2 * 1024 * 1024, fragmentCharacters: 20_000,
  evidence: 500, receipts: 500, quoteCharacters: 2000, fieldCharacters: 20_000, resultBytes: 8 * 1024 * 1024,
});

interface Material extends SourcePreparationProvenance {
  source: IntelligenceSource; fragment: IntelligenceFragment; index: number;
  table: string; row: number; cells: string[];
}
interface ContractFact { row: Material; header: Material; fields: IntelligenceItem["fields"]; number: string; date: string; amountLabel: string; amountText: string }
interface NmcFact { row: Material; headers: Material[]; value: number; totalLabel: string; amountText: string }
interface StaffFact { row: Material; header: Material; fields: IntelligenceItem["fields"]; name: string; employmentFlag: boolean; experience: string; educationLabel: boolean }
interface ManagerFact { name: string; nameRow: Material; roleRow: Material; contacts: Array<{ row: Material; field: "phone" | "email"; value: string }> }
export interface PreparedContractTableFact {
  sourceId: string; number: string; date: string; fields: IntelligenceItem["fields"];
  row: SourcePreparationProvenance; header: SourcePreparationProvenance; amountLabel: string; amountText: string;
}
export interface PreparedNmcTableFact { row: SourcePreparationProvenance; headers: SourcePreparationProvenance[]; value: number; totalLabel: string; amountText: string }
export interface PreparedTableFacts {
  contracts: PreparedContractTableFact[]; nmcs: PreparedNmcTableFact[];
  skipped: SourcePreparationSkipped[]; limited: boolean;
}
interface Inventory {
  contracts: ContractFact[]; nmcs: NmcFact[]; staff: StaffFact[]; managers: ManagerFact[];
  skipped: SourcePreparationSkipped[]; limited: boolean;
}
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const key = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/gu, "е").replace(/[‐‑–—]/gu, "-").replace(/\s+/gu, " ").trim();
const numberKey = (value: string) => key(value).replace(/^№\s*/u, "").replace(/\s+/gu, "");
const characters = (value: string) => Array.from(value).length;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const validId = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && characters(value) <= 128 && !/[\u0000-\u001f]/u.test(value);
const included = (fragment: IntelligenceFragment) => fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden" || fragment.includedByUser === true;
const proof = (entry: SourcePreparationProvenance): SourcePreparationProvenance => ({ sourceId: entry.sourceId, sourceName: entry.sourceName, ...(entry.fragmentId ? { fragmentId: entry.fragmentId } : {}), locator: entry.locator, quote: entry.quote });
const claim = (entry: SourcePreparationProvenance, field: string): IntelligenceEvidence => ({ sourceId: entry.sourceId, ...(entry.fragmentId ? { fragmentId: entry.fragmentId } : {}), field, quote: entry.quote });
const sameClaim = (left: IntelligenceEvidence, right: IntelligenceEvidence) => left.field === right.field && left.sourceId === right.sourceId && left.fragmentId === right.fragmentId && left.quote === right.quote;
const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
export const isPrimaryContractAmountLabel = (cell: string) => /^(?:(?:общая|итоговая)\s+)?сумма\s+договора(?=$|[^\p{L}])/iu.test(cell.trim());
const foreignCurrency = (value: string) => /(?:\b(?:USD|EUR|CNY|KZT|BYN|JPY|GBP|CHF)\b|[$€¥₸£]|доллар[а-я]*|евро|юан[а-я]*|тенге|белорус[а-я\s]+рубл[а-я]*)/iu.test(value);
function moneyIssue(label: string, printed: string): "foreign-currency" | "unsupported-money-units" | undefined {
  if (foreignCurrency(label) || foreignCurrency(printed)) return "foreign-currency";
  // Unknown explicit currency-like codes are not silently treated as RUB.
  // VAT is a tax marker; other unknown three-letter labels require review.
  const codes = [...(label + " " + printed).matchAll(/(?<![\p{L}])[A-Z]{3}(?![\p{L}])/gu)].map((match) => match[0]);
  if (codes.some((code) => !["RUB", "RUR", "VAT"].includes(code))) return "unsupported-money-units";
  const scaledOrMinor = /(?:^|[^\p{L}])(?:тыс\.?|тысяч[\p{L}]*|млн\.?|миллион[\p{L}]*|млрд\.?|миллиард[\p{L}]*|коп(?:\.|еек|ейк[\p{L}]*)?)(?=$|[^\p{L}])/iu;
  if (scaledOrMinor.test(label) || scaledOrMinor.test(printed)) return "unsupported-money-units";
  // This explanatory clause still labels the contract total, not a unit
  // price. No other unit/period is converted, even by a seemingly obvious x1000.
  const units = label.replace(/,\s*с\s*уч[её]том\s+округления\s+цены\s+за\s+единицу[^,;]*/iu, "");
  if (/(?:за\s+(?:единиц|ед\.|шт(?:ук)?\.?|комплект|месяц|год|час|сут|дн|квартал|недел)|в\s+(?:месяц|год|час|сутки|день|квартал|неделю)|руб(?:\.|лей|ля)?\s*\/\s*(?:мес|год|час|сут|дн|ед|шт))/iu.test(units)) return "unsupported-money-units";
}
/** Shared fail-closed monetary semantics for preparation and evidence audit.
 * No currency, scale, minor-unit or period conversion is performed. */
export function unsupportedMonetaryUnit(label: string, printed: string): boolean {
  return moneyIssue(label, printed) !== undefined;
}
const fullDate = (day: string, month: string, year: string) => {
  const iso = `${year}-${month}-${day}`;
  return Number(year) >= 1900 && Number(year) <= 2200 && Number.isFinite(Date.parse(`${iso}T00:00:00Z`)) && new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
};

function coordinate(fragment: IntelligenceFragment): { table: string; row: number } | null {
  const id = /^((?:table(?:-\d+)?)|(?:sheet-\d+))-row-(\d+)$/u.exec(fragment.id || "");
  const locator = /^(таблица(?:\s*№?\s*\d+)?),?\s*строка\s+(\d+)$/iu.exec(fragment.locator.trim());
  if (!id && !locator) return null;
  const table = id && id[1] !== "table" ? id[1] : locator ? key(locator[1]) : id![1];
  const row = Number(id?.[2] || locator![2]);
  return Number.isSafeInteger(row) && row > 0 ? { table: `${fragment.sheetId || ""}:${table}`, row } : null;
}

/** Currency syntax only. No arithmetic, scientific notation, formulas, ranges,
 * percentages or selection of a plausible number from surrounding prose. */
function money(value: string): number | null {
  const printed = value.trim().replace(/\s*(?:руб\.?|рублей|рубля|₽)\s*$/iu, "").replace(/[\u00a0\u202f]/gu, " ");
  if (!/^(?:\d+|\d{1,3}(?: \d{3})+)(?:[,.]\d{1,2})?$/u.test(printed)) return null;
  const amount = Number(printed.replace(/ /gu, "").replace(",", "."));
  return Number.isFinite(amount) && amount > 0 && amount <= 1_000_000_000_000 ? amount : null;
}

function contractFacts(material: Material[]): ContractFact[] {
  const facts: ContractFact[] = [];
  let owner: { header: Material; previous: Material; serial: number; customer: number; subject: number; amount: number; period: number } | null = null;
  for (const row of material) {
    const { cells } = row;
    const customer = cells.findIndex((cell) => /^заказчик(?:\s|$|\()/iu.test(cell.trim()));
    const subject = cells.findIndex((cell) => /предмет/iu.test(cell) && /договор/iu.test(cell));
    const amount = cells.findIndex(isPrimaryContractAmountLabel);
    const period = cells.findIndex((cell) => /сроки\s+выполнения/iu.test(cell));
    if (cells.length >= 4 && customer >= 0 && subject >= 0 && amount >= 0 && /^(?:№|п\s*\/\s*п)/iu.test(cells[0].trim())) {
      owner = { header: row, previous: row, serial: 0, customer, subject, amount, period }; continue;
    }
    const serial = /^\s*(\d{1,3})[.)]?\s*$/u.exec(cells[0])?.[1];
    if (!owner || row.table !== owner.previous.table || row.row !== owner.previous.row + 1 || row.index !== owner.previous.index + 1 || cells.length !== owner.header.cells.length || !serial || Number(serial) !== owner.serial + 1) { owner = null; continue; }
    owner = { ...owner, previous: row, serial: Number(serial) };
    const matches = [...cells[owner.subject].matchAll(/(?:^|[^\p{L}])договор\s*№\s*([^\t\n]{1,180}?)\s+от\s+(\d{2})[./](\d{2})[./](\d{4})(?=$|[^\d])/giu)];
    if (matches.length !== 1) continue;
    const match = matches[0], number = match[1].trim(), date = fullDate(match[2], match[3], match[4]);
    if (!date || !/[\p{L}\d]/u.test(number) || /^[_\s.…-]+$/u.test(number)) continue;
    const fields: IntelligenceItem["fields"] = { number, date, subject: cells[owner.subject].trim() };
    const client = cells[owner.customer].trim();
    // A confidentiality statement is retained as reference, never invented as
    // the customer's legal name. Month ranges stay literal, not fake ISO dates.
    const notes: string[] = [];
    if (client && !/(?:конфиденциал|не\s+раскрыва|не\s+указан)/iu.test(client)) fields.customer = client;
    else if (client) notes.push(`${owner.header.cells[owner.customer].trim()}: ${client}`);
    const amountLabel = owner.header.cells[owner.amount], amountText = cells[owner.amount];
    const amountValue = money(amountText); if (amountValue !== null && !moneyIssue(amountLabel, amountText)) fields.amount = amountValue;
    if (owner.period >= 0 && cells[owner.period].trim()) notes.push(`${owner.header.cells[owner.period].trim()}: ${cells[owner.period].trim()}`);
    if (notes.length) fields.notes = row.quote;
    facts.push({ row, header: owner.header, fields, number, date, amountLabel, amountText });
  }
  return facts;
}

const nmcLabel = (cell: string) => /(?:н\s*\(?\s*м\s*\)?\s*ц|начальн[\p{L}]*\s*\(?\s*максимальн[\p{L}]*\s*\)?\s+цен)/iu.test(cell);
export const isPrimaryNmcLabel = (cell: string) => /^(?:(?:общая|итоговая)\s+)?(?:н\s*\(?\s*м\s*\)?\s*цк?|начальн[\p{L}]*\s*\(?\s*максимальн[\p{L}]*\s*\)?\s+цен[\p{L}]*)(?=$|[^\p{L}])/iu.test(cell.trim());
const totalNmcLabel = (cell: string) => isPrimaryNmcLabel(cell) && /(?:договора|закупки|итого|общая)/iu.test(cell)
  // «НМЦ договора, с учётом округления цены за единицу» still labels
  // the contract total. A direct «НМЦ ... за единицу» label does not.
  && !/(?:за\s+единиц|единичн|руб\.?\s*\/\s*ед)/iu.test(cell.split(/[,;]/u)[0]);
function nmcFacts(material: Material[]): NmcFact[] {
  const found: NmcFact[] = [];
  let previous: Material | undefined, headers: Material[] = [], column = -1, totalLabel = "";
  let candidates: NmcFact[] = [], totals: NmcFact[] = [];
  const flush = () => {
    const current = totals.length ? totals : candidates;
    // A total row is explicit aggregation. Without it only one actual row is
    // eligible; sums of differently-priced rows are never computed here.
    if (current.length && (totals.length || current.length === 1)) found.push(...current);
    candidates = []; totals = []; headers = []; column = -1; totalLabel = "";
  };
  for (const row of material) {
    if (previous && (row.table !== previous.table || row.row !== previous.row + 1 || row.index !== previous.index + 1)) flush();
    previous = row;
    const labelled = row.cells.flatMap((cell, index) => totalNmcLabel(cell) ? [index] : []);
    if (labelled.length) {
      if (column >= 0 && candidates.length) flush();
      column = labelled.length === 1 ? labelled[0] : -1;
      totalLabel = column >= 0 ? row.cells[column] : "";
      headers.push(row); continue;
    }
    if (column < 0) { if (row.cells.some(nmcLabel)) headers = [row]; continue; }
    const value = column < row.cells.length ? money(row.cells[column]) : null;
    if (value !== null) {
      const fact = { row, headers: [...headers], value, totalLabel, amountText: row.cells[column] };
      candidates.push(fact);
      if (row.cells.slice(0, column).some((cell) => /^\s*итого(?:$|[,\s:])/iu.test(cell))) totals.push(fact);
    } else if (candidates.length) flush();
    else if (headers.length < 4) headers.push(row);
    else flush();
  }
  flush(); return found;
}

const personName = (value: string) => /^(?:[А-ЯЁA-Z][а-яёa-z]+(?:[-’'][А-ЯЁA-Zа-яёa-z]+)?\s+){1,3}[А-ЯЁA-Z][а-яёa-z]+(?:[-’'][А-ЯЁA-Zа-яёa-z]+)?$/u.test(value.trim());
function staffFacts(material: Material[]): StaffFact[] {
  const found: StaffFact[] = [];
  let owner: { header: Material; previous: Material; name: number; role: number; experience: number; employment: number; directions: number } | null = null;
  for (const row of material) {
    const name = row.cells.findIndex((cell) => /^(?:фио|ф\.?\s*и\.?\s*о\.?|фамилия,?\s+имя,?\s+отчество)$/iu.test(cell.trim()));
    const role = row.cells.findIndex((cell) => /^(?:роль\s+в\s+проекте|должность)$/iu.test(cell.trim()));
    const experience = row.cells.findIndex((cell) => /^опыт(?:\s|$)/iu.test(cell.trim()));
    if (row.cells.length >= 3 && name >= 0 && role >= 0 && experience >= 0) {
      owner = { header: row, previous: row, name, role, experience, employment: row.cells.findIndex((cell) => /^в\s+штате$/iu.test(cell.trim())), directions: row.cells.findIndex((cell) => /^(?:закрываемые\s+направления|направления\s+работ)/iu.test(cell.trim())) }; continue;
    }
    if (!owner || row.table !== owner.previous.table || row.row !== owner.previous.row + 1 || row.index !== owner.previous.index + 1 || row.cells.length !== owner.header.cells.length || !personName(row.cells[owner.name])) { owner = null; continue; }
    owner = { ...owner, previous: row };
    const fullName = row.cells[owner.name].trim(), fields: IntelligenceItem["fields"] = { fullName };
    if (row.cells[owner.role].trim()) fields.role = row.cells[owner.role].trim();
    if (row.cells[owner.experience].trim()) {
      fields.experienceNotes = row.cells[owner.experience].trim();
      const years = /^(\d{1,2})\s+(?:лет|год(?:а)?)(?:\s|[.,;]|$)/iu.exec(row.cells[owner.experience].trim());
      // «Более 25» is a lower bound, never an exact numeric experience value.
      if (years && Number(years[1]) <= 100) fields.experienceYears = Number(years[1]);
    }
    for (const [column, label] of owner.header.cells.entries()) {
      const value = row.cells[column].trim();
      if (value && /^(?:телефон|phone)$/iu.test(label.trim())) fields.phone = value;
      if (/^(?:e-?mail|электронная\s+почта|почта)$/iu.test(label.trim()) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) fields.email = value;
    }
    const notes = [owner.employment, owner.directions].filter((index) => index >= 0 && row.cells[index].trim()).map((index) => `${owner!.header.cells[index].trim()}: ${row.cells[index].trim()}`);
    if (notes.length) fields.notes = row.quote;
    found.push({ row, header: owner.header, fields, name: fullName, employmentFlag: owner.employment >= 0, experience: row.cells[owner.experience].trim(), educationLabel: row.cells.some((_cell, index) => /образован/iu.test(owner!.header.cells[index])) });
  }
  return found;
}

/** Only an explicitly labelled vertical contact table. It is not a roster and
 * cannot manufacture employees. Exact ownership is used only for quarantine. */
function managerFacts(material: Material[]): ManagerFact[] {
  const found: ManagerFact[] = [];
  for (let index = 0; index < material.length; index++) {
    const nameRow = material[index];
    if (nameRow.cells.length !== 2 || !/^фио$/iu.test(nameRow.cells[0].trim()) || !personName(nameRow.cells[1])) continue;
    let previous = nameRow, roleRow: Material | undefined;
    const contacts: ManagerFact["contacts"] = [];
    for (let cursor = index + 1; cursor < Math.min(index + 7, material.length); cursor++) {
      const row = material[cursor];
      if (row.table !== previous.table || row.row !== previous.row + 1 || row.index !== previous.index + 1 || row.cells.length !== 2) break;
      const label = row.cells[0].trim(), value = row.cells[1].trim();
      if (/^(?:роль|должность)$/iu.test(label)) { if (/(?:коммерческий\s+директор|менеджер)/iu.test(value)) roleRow = row; }
      else if (/^(?:телефон|phone)$/iu.test(label)) contacts.push({ row, field: "phone", value });
      else if (/^(?:e-?mail|электронная\s+почта|почта)$/iu.test(label)) contacts.push({ row, field: "email", value });
      else if (!/^адрес$/iu.test(label)) break;
      previous = row;
    }
    if (roleRow) found.push({ name: nameRow.cells[1].trim(), nameRow, roleRow, contacts });
  }
  return found;
}

function numberAliases(value: string): string[] {
  const full = numberKey(value);
  const registry = /^([\p{L}\d][\p{L}\d/_.-]{0,79})\s+\(\d{3,12}(?:[-/]\d{3,12}){2,4}\)$/u.exec(key(value));
  return registry ? [full, numberKey(registry[1])] : [full];
}
function recordId(seed: string, used: Set<string>): string {
  // A local draft identity, not a security hash or business-record identity.
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) hash = Math.imul(hash ^ seed.charCodeAt(index), 16777619);
  const base = `source-contract-${(hash >>> 0).toString(16)}`;
  let value = base, suffix = 1; while (used.has(value)) value = `${base}-${suffix++}`;
  used.add(value); return value;
}

function collectPreparedFacts(sources: readonly IntelligenceSource[], destinations: readonly IntelligenceDestination[]): Inventory {
  const limits = SOURCE_PREPARATION_LIMITS;
  const result: Inventory = { contracts: [], nmcs: [], staff: [], managers: [], skipped: [], limited: false };
  const skip = (reason: string, message: string, extra: Partial<SourcePreparationSkipped> = {}) => result.skipped.push({ reason, message, requiresReview: true, ...extra });
  const limit = (message: string): Inventory => ({ contracts: [], nmcs: [], staff: [], managers: [], skipped: [{ reason: "preparation-limit", message, requiresReview: true }], limited: true });
  if (sources.length > limits.sources) return limit("Подготовка ограничена 100 источниками. Материалы не усечены; разделите задачу.");
  const sourceIds = new Set<string>(), duplicateSources = new Set<string>();
  for (const source of sources) { if (sourceIds.has(source.id)) duplicateSources.add(source.id); sourceIds.add(source.id); }
  let fragmentCount = 0, totalBytes = 0;
  for (const source of sources) {
    if (!validId(source.id) || duplicateSources.has(source.id)) { skip("invalid-source", "Источник с отсутствующим или повторяющимся идентификатором пропущен.", validId(source.id) ? { sourceId: source.id } : {}); continue; }
    const fragments = source.fragments === undefined ? [{ locator: "Текст источника", text: source.text }] : source.fragments;
    const fragmentIds = new Set<string>(), duplicateFragments = new Set<string>();
    for (const fragment of fragments) { if (fragment.id && fragmentIds.has(fragment.id)) duplicateFragments.add(fragment.id); if (fragment.id) fragmentIds.add(fragment.id); }
    const material: Material[] = [];
    for (const [index, fragment] of fragments.entries()) {
      if (++fragmentCount > limits.fragments) return limit("Подготовка достигла предела 5000 фрагментов. Ничего не усечено; разделите документы или листы.");
      if (!included(fragment)) continue;
      totalBytes += bytes(fragment.text);
      if (totalBytes > limits.bytes || characters(fragment.text) > limits.fragmentCharacters) return limit("Подготовка достигла предела 2 МиБ текста или 20000 символов в одном фрагменте. Ничего не усечено; разделите материалы.");
      if (fragment.id && duplicateFragments.has(fragment.id)) { skip("duplicate-fragment", "Фрагмент с повторяющимся идентификатором не использован для подготовки.", { sourceId: source.id, sourceName: source.name, fragmentId: fragment.id, locator: fragment.locator }); continue; }
      const at = coordinate(fragment);
      if (at) material.push({ source, fragment, index, ...at, cells: fragment.text.split("\t"), sourceId: source.id, sourceName: source.name, ...(fragment.id ? { fragmentId: fragment.id } : {}), locator: fragment.locator, quote: fragment.text });
    }
    if (destinations.includes("contracts")) result.contracts.push(...contractFacts(material));
    if (destinations.includes("procurement")) {
      const found = nmcFacts(material);
      if (found.length && multipleLots(source)) for (const fact of found) skip("multiple-lots", "В источнике несколько явных лотов. НМЦ не назначена одной карточке по порядку или одинаковой сумме.", proof(fact.row));
      else result.nmcs.push(...found);
    }
    if (destinations.includes("staff")) { result.staff.push(...staffFacts(material)); result.managers.push(...managerFacts(material)); }
  }
  if (result.contracts.length + result.staff.length > limits.items || result.nmcs.length > limits.items) return limit("Таблицы содержат более 100 явных строк договоров/команды или итогов НМЦ. Подготовка не усечена; разделите задачу.");
  if (result.skipped.length > limits.receipts) return limit("Проверка таблиц достигла предела 500 квитанций. Материалы не усечены; разделите задачу.");
  return result;
}

/** Shared read-only grammar for preparation and evidence audit. No cards are
 * created and no candidate/model value is trusted by this inventory. Consumers
 * must still match the owned source, exact number/date and literal row/header;
 * multiple conflicting source facts never prove a unique value. */
export function extractPreparedTableFacts(sources: readonly IntelligenceSource[]): PreparedTableFacts {
  const inventory = collectPreparedFacts(sources, ["contracts", "procurement"]);
  return {
    contracts: inventory.contracts.map((fact) => ({ sourceId: fact.row.sourceId, number: fact.number, date: fact.date, fields: { ...fact.fields }, row: proof(fact.row), header: proof(fact.header), amountLabel: fact.amountLabel, amountText: fact.amountText })),
    nmcs: inventory.nmcs.map((fact) => ({ row: proof(fact.row), headers: fact.headers.map(proof), value: fact.value, totalLabel: fact.totalLabel, amountText: fact.amountText })),
    skipped: inventory.skipped, limited: inventory.limited,
  };
}

/** Deterministic preparation of UNSAVED candidates. Never interprets unlabelled
 * numbers, assigns a party role, pairs detached configurations or acknowledges
 * a review gate. Raw model text and displaced values are preserved by callers.
 * A global budget failure rolls back this whole helper, not a prefix of rows. */
export function prepareIntelligenceSourceFacts(
  items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[],
  destinations: readonly IntelligenceDestination[] = [...new Set(items.map((item) => item.destination))],
): SourcePreparationResult {
  const result: SourcePreparationResult = { items: [...items], changes: [], skipped: [], limited: false };
  const limits = SOURCE_PREPARATION_LIMITS;
  const skip = (reason: string, message: string, extra: Partial<SourcePreparationSkipped> = {}) => result.skipped.push({ reason, message, requiresReview: true, ...extra });
  const rollback = (message: string): SourcePreparationResult => ({ items: [...items], changes: [], skipped: [{ reason: "preparation-limit", message, requiresReview: true }], limited: true });
  if (!destinations.some((destination) => ["contracts", "procurement", "staff"].includes(destination))) return result;
  if (items.length > limits.items || sources.length > limits.sources) return rollback("Подготовка ограничена 100 карточками и 100 источниками. Ничего не усечено; разделите задачу.");
  const ids = new Set<string>();
  if (items.some((item) => !validId(item.id) || ids.has(item.id) || (ids.add(item.id), false))) {
    skip("invalid-card-identity", "Идентификаторы карточек повреждены или повторяются. Подготовка из источников не выполнена."); return result;
  }
  const inventory = collectPreparedFacts(sources, destinations);
  if (inventory.limited) return { ...result, skipped: inventory.skipped, limited: true };
  const { contracts, nmcs, staff, managers } = inventory;
  result.skipped.push(...inventory.skipped);
  const usedIds = new Set(items.map((item) => item.id));
  const apply = (index: number, fields: IntelligenceItem["fields"], row: Material, headers: Material[]) => {
    const current = result.items[index];
    if ([row, ...headers].some((entry) => characters(entry.quote) > limits.quoteCharacters) || Object.values(fields).some((value) => typeof value === "string" && characters(value) > limits.fieldCharacters)) {
      skip("proof-too-long", "Полная строка или заголовок не помещаются в предел цитаты/поля. Карточка не изменена и цитата не усечена.", { itemId: current.id, ...proof(row) }); return;
    }
    const patch: SourcePreparationChange[] = [], evidence = [...(current.evidence || [])].filter((entry) => !own(fields, entry.field));
    const nextFields = { ...current.fields };
    for (const [field, value] of Object.entries(fields)) {
      const previousValue = current.fields[field];
      if (!sameValue(previousValue, value) || !current.selectedFields.includes(field)) patch.push({ itemId: current.id, field, kind: own(current.fields, field) ? "replaced" : "added", ...proof(row), ...(previousValue !== undefined ? { previousValue } : {}), value, requiresReview: true });
      nextFields[field] = value;
      for (const entry of [row, ...(["amount", "nmc"].includes(field) ? headers : [])]) { const next = claim(entry, field); if (!evidence.some((old) => sameClaim(old, next))) evidence.push(next); }
    }
    if (evidence.length > limits.evidence) { skip("evidence-limit", "Подтверждения превышают предел 500 цитат. Карточка не изменена; разделите задачу.", { itemId: current.id, ...proof(row) }); return; }
    result.items[index] = { ...current, fields: nextFields, selectedFields: [...new Set([...current.selectedFields, ...Object.keys(fields)])], evidence };
    result.changes.push(...patch);
  };
  const conflictingRows = new Set<ContractFact>();
  for (const fact of contracts) {
    const issue = moneyIssue(fact.amountLabel, fact.amountText);
    if (issue) skip(issue, issue === "foreign-currency" ? "Сумма договора явно указана в иностранной валюте. Рублёвое значение не вычислено автоматически." : "Сумма договора указана с масштабом, в копейках, за единицу или период. Рублёвый итог не пересчитан; проверьте единицы по заголовку.", { field: "amount", ...proof(fact.row) });
    const same = contracts.filter((other) => other.row.sourceId === fact.row.sourceId && numberKey(other.number) === numberKey(fact.number) && other.date === fact.date);
    if (same.some((other) => !sameValue(other.fields, fact.fields))) for (const entry of same) conflictingRows.add(entry);
  }
  const handled = new Set<string>();
  for (const fact of contracts) {
    if (conflictingRows.has(fact)) { skip("conflicting-contract-rows", "Один номер и дата имеют разные данные в таблице. Карточка не назначена по порядку строк.", proof(fact.row)); continue; }
    const identity = JSON.stringify([fact.row.sourceId, numberKey(fact.number), fact.date]);
    if (handled.has(identity)) continue; handled.add(identity);
    const aliases = numberAliases(fact.number);
    const owners = result.items.flatMap((item, index) => item.destination === "contracts" && item.sourceIds.includes(fact.row.sourceId) && typeof item.fields.number === "string" && aliases.includes(numberKey(item.fields.number)) ? [index] : []);
    const matching = owners.filter((index) => {
      const card = result.items[index];
      const alternatives = contracts.filter((other) => card.sourceIds.includes(other.row.sourceId) && numberAliases(other.number).includes(numberKey(String(card.fields.number))));
      const dates = new Set(alternatives.map((other) => other.date));
      return dates.size <= 1 || card.fields.date === fact.date;
    });
    const unresolved = owners.some((index) => {
      const card = result.items[index];
      const alternatives = contracts.filter((other) => card.sourceIds.includes(other.row.sourceId) && numberAliases(other.number).includes(numberKey(String(card.fields.number))));
      return new Set(alternatives.map((other) => other.date)).size > 1 && !alternatives.some((other) => other.date === card.fields.date);
    });
    if (matching.length > 1 || unresolved) { skip("ambiguous-contract-card", "Номер не определяет единственную карточку и дату договора. Сопоставление не угадано.", proof(fact.row)); continue; }
    if (matching.length === 1) {
      const index = matching[0], card = result.items[index];
      const competing = contracts.filter((other) => card.sourceIds.includes(other.row.sourceId) && numberAliases(other.number).includes(numberKey(String(card.fields.number))) && other.date === fact.date);
      if (competing.some((other) => !sameValue(other.fields, fact.fields))) { skip("conflicting-contract-sources", "Источники одной карточки противоречат друг другу. Значения не заменены.", { itemId: card.id, ...proof(fact.row) }); continue; }
      apply(index, fact.fields, fact.row, [fact.header]);
    } else {
      if (result.items.length >= limits.items) return rollback("Явные строки таблицы превышают предел 100 карточек. Не создана часть списка: разделите задачу.");
      if ([fact.row, fact.header].some((entry) => characters(entry.quote) > limits.quoteCharacters)) { skip("proof-too-long", "Полная строка или заголовок длиннее 2000 символов. Карточка не создана, цитата не усечена.", proof(fact.row)); continue; }
      const id = recordId(identity, usedIds);
      result.items.push({ id, title: `Договор № ${fact.number}`, destination: "contracts", fields: {}, sourceIds: [fact.row.sourceId], selectedFields: [], evidence: [] });
      const index = result.items.length - 1;
      apply(index, fact.fields, fact.row, [fact.header]);
      result.changes.push({ itemId: id, field: "record", kind: "created", ...proof(fact.row), requiresReview: true });
    }
  }
  const nmcByItem = new Map<number, NmcFact[]>();
  for (const fact of nmcs) {
    const issue = moneyIssue(fact.totalLabel, fact.amountText);
    if (issue) { skip(issue, issue === "foreign-currency" ? "Итог НМЦ явно указан в иностранной валюте. Рублёвое значение не вычислено автоматически." : "НМЦ указана с масштабом, в копейках, за единицу или период. Рублёвый итог не пересчитан; проверьте единицы по заголовку.", { field: "nmc", ...proof(fact.row) }); continue; }
    const owners = result.items.flatMap((item, index) => item.destination === "procurement" && item.sourceIds.includes(fact.row.sourceId) ? [index] : []);
    if (owners.length !== 1) { skip(owners.length ? "multiple-cards" : "unowned-source", "НМЦ относится не к единственной карточке закупки. Сумма не назначена автоматически.", proof(fact.row)); continue; }
    nmcByItem.set(owners[0], [...(nmcByItem.get(owners[0]) || []), fact]);
  }
  for (const [index, facts] of nmcByItem) {
    if (new Set(facts.map((fact) => fact.value)).size !== 1) {
      for (const fact of facts) skip("conflicting-nmc", "Явные итоги НМЦ различаются. Значение не выбрано по порядку или величине.", { itemId: result.items[index].id, field: "nmc", ...proof(fact.row) });
      continue;
    }
    const fact = facts[0]; apply(index, { nmc: fact.value }, fact.row, fact.headers);
  }
  const quarantine = (index: number, fields: string[], row: Material) => {
    const item = result.items[index], selected = fields.filter((field) => item.selectedFields.includes(field));
    if (!selected.length) return;
    if (characters(row.quote) > limits.quoteCharacters) { skip("proof-too-long", "Не удалось показать полную цитату для исключения спорного поля. Оно не изменено.", { itemId: item.id, ...proof(row) }); return; }
    result.items[index] = { ...item, selectedFields: item.selectedFields.filter((field) => !selected.includes(field)) };
    for (const field of selected) result.changes.push({ itemId: item.id, field, kind: "quarantined", ...proof(row), previousValue: item.fields[field], requiresReview: true });
  };
  const seenPeople = new Set<string>();
  for (const fact of staff) {
    const identity = JSON.stringify([fact.row.sourceId, key(fact.name)]);
    if (seenPeople.has(identity)) continue; seenPeople.add(identity);
    const samePerson = staff.filter((other) => other.row.sourceId === fact.row.sourceId && key(other.name) === key(fact.name));
    if (samePerson.some((other) => !sameValue(other.fields, fact.fields))) { skip("conflicting-person-rows", "Один человек имеет разные данные в явных строках команды. Значения не назначены по порядку.", proof(fact.row)); continue; }
    const owners = result.items.flatMap((item, index) => item.destination === "staff" && item.sourceIds.includes(fact.row.sourceId) && typeof item.fields.fullName === "string" && key(item.fields.fullName) === key(fact.name) ? [index] : []);
    if (owners.length > 1) { skip("ambiguous-person-card", "Один человек совпал с несколькими карточками. Поля не назначены автоматически.", proof(fact.row)); continue; }
    let index = owners[0];
    if (index === undefined) {
      if (result.items.length >= limits.items) return rollback("Явные строки команды превышают предел 100 карточек. Список не усечён; разделите задачу.");
      if ([fact.row, fact.header].some((entry) => characters(entry.quote) > limits.quoteCharacters)) { skip("proof-too-long", "Полная строка команды или заголовок длиннее 2000 символов. Карточка не создана, цитата не усечена.", proof(fact.row)); continue; }
      const id = recordId(`staff:${identity}`, usedIds);
      result.items.push({ id, title: fact.name, destination: "staff", fields: {}, sourceIds: [fact.row.sourceId], selectedFields: [], evidence: [] });
      index = result.items.length - 1;
      result.changes.push({ itemId: id, field: "record", kind: "created", ...proof(fact.row), requiresReview: true });
    }
    const item = result.items[index], fields = { ...fact.fields };
    const competing = staff.filter((other) => item.sourceIds.includes(other.row.sourceId) && key(other.name) === key(fact.name));
    if (competing.some((other) => !sameValue(other.fields, fact.fields))) { skip("conflicting-person-sources", "Источники одной карточки содержат разные данные человека. Поля не заменены.", { itemId: item.id, ...proof(fact.row) }); continue; }
    apply(index, fields, fact.row, [fact.header]);
    if (!own(fields, "experienceYears") && typeof fields.experienceNotes === "string" && /^(?:более|свыше|не\s+менее)\s+\d+\s+(?:лет|год)/iu.test(fields.experienceNotes)) quarantine(index, ["experienceYears"], fact.row);
    const education = item.fields.education;
    if (!fact.educationLabel && Array.isArray(education) && education.length && education.every((entry) => Boolean(entry.trim()) && key(fact.experience).includes(key(entry)))) {
      quarantine(index, ["education"], fact.row);
      skip("experience-is-not-education", "Эти строки находятся в колонке опыта, а не образования. Они сохранены видимыми, но исключены из переноса как образование; сведения о дипломе или учебном заведении не придуманы.", { itemId: item.id, field: "education", ...proof(fact.header) });
    }
    if (fact.employmentFlag && item.sourceIds.length === 1 && typeof item.fields.basis === "string" && item.fields.basis.trim()) {
      const eligible = fact.row.source.fragments === undefined ? [fact.row.source.text] : fact.row.source.fragments.filter(included).map((entry) => entry.text);
      if (!eligible.some((text) => key(text).includes(key(item.fields.basis as string)))) {
        quarantine(index, ["basis", "basisOther", "basisNumber"], fact.row);
        skip("employment-is-not-basis", "Флаг «В штате» не подтверждает вид или номер договора. Спорное основание оставлено видимым, но исключено из переноса; проверьте первичный документ.", { itemId: item.id, field: "basis", ...proof(fact.row) });
      }
    }
    for (const manager of managers.filter((entry) => item.sourceIds.includes(entry.nameRow.sourceId) && key(entry.name) !== key(fact.name))) for (const contact of manager.contacts) {
      if (own(fields, contact.field)) continue;
      const value = item.fields[contact.field];
      if (typeof value === "string" && value.trim() && (contact.field === "phone"
        ? value.replace(/\D/gu, "").length >= 7 && contact.value.replace(/\D/gu, "").includes(value.replace(/\D/gu, ""))
        : key(contact.value).includes(key(value)))) quarantine(index, [contact.field], contact.row);
    }
  }
  for (const manager of managers) {
    if (!staff.some((fact) => fact.row.sourceId === manager.nameRow.sourceId) || staff.some((fact) => fact.row.sourceId === manager.nameRow.sourceId && key(fact.name) === key(manager.name))) continue;
    for (const [index, item] of result.items.entries()) if (item.destination === "staff" && item.sourceIds.includes(manager.nameRow.sourceId) && typeof item.fields.fullName === "string" && key(item.fields.fullName) === key(manager.name)) {
      quarantine(index, item.selectedFields, manager.nameRow);
      skip("contact-manager-not-roster", "Этот человек явно указан отдельным контактом менеджера, а не строкой состава команды. Карточка и прежние данные сохранены, но её поля не выбраны для переноса в кадры.", { itemId: item.id, ...proof(manager.roleRow) });
    }
  }
  if (result.changes.length + result.skipped.length > limits.receipts || bytes(JSON.stringify(result)) > limits.resultBytes) return rollback("Подготовленные карточки или квитанции достигли предела 500 изменений / 8 МиБ. Ничего не усечено; разделите задачу.");
  return result;
}
