import type { IntelligenceDestination, IntelligenceFragment, IntelligenceItem, IntelligenceSource, IntelligenceStaffDocument } from "./workbenchTypes";
import { SOURCE_PREPARATION_LIMITS, type SourcePreparationResult, type SourcePreparationSkipped } from "./sourcePreparedFacts";

export interface StaffCertificateFacts {
  documents: IntelligenceStaffDocument[];
  skipped: SourcePreparationSkipped[];
  limited: boolean;
}

const limits = SOURCE_PREPARATION_LIMITS;
const key = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/\s+/gu, " ").trim();
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const length = (value: string) => Array.from(value).length;
const validId = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && length(value) <= 128 && !/[\u0000-\u001f]/u.test(value);
const safe = (value: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
const person = (value: string) => value.length <= 200 && value.trim().split(/\s+/u).length === 3 && value.trim().split(/\s+/u).every((part) => /^\p{Lu}\p{Ll}+(?:[-’']\p{L}+)*$/u.test(part));
const literal = (value: string) => value.trim();
const meaningful = (value: string) => Boolean(value.trim()) && !/^(?:null|undefined|n\/a|[-—])$/iu.test(value.trim());
const visible = (fragment: IntelligenceFragment) => fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden";
const calendar = (iso: string) => /^\d{4}-\d{2}-\d{2}$/u.test(iso) && Number(iso.slice(0, 4)) >= 1900 && Number(iso.slice(0, 4)) <= 2200 && Number.isFinite(Date.parse(`${iso}T00:00:00Z`)) && new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso;
function examDate(value: string): string | null {
  if (!value.trim()) return "";
  const printed = value.trim(), russian = /^(\d{2})\.(\d{2})\.(\d{4})$/u.exec(printed);
  const iso = russian ? `${russian[3]}-${russian[2]}-${russian[1]}` : printed;
  return calendar(iso) ? iso : null;
}

/** Stable local identity only, never a credential or authoritative business ID.
 * Collisions are checked against their complete source/row identities below. */
function hash(value: string): string {
  let a = 2166136261, b = 3339675911;
  for (let n = 0; n < value.length; n++) { a = Math.imul(a ^ value.charCodeAt(n), 16777619); b = Math.imul(b ^ value.charCodeAt(n), 2246822519); }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}
function coordinate(fragment: IntelligenceFragment): { table: string; row: number } | null {
  const id = /^((?:sheet-\d+)|(?:table(?:-\d+)?))-row-(\d+)$/u.exec(fragment.id || "");
  if (!id) return null;
  const sheet = /^sheet-(\d+)$/u.exec(id[1]);
  if (sheet && fragment.sheetId && fragment.sheetId !== sheet[1]) return null;
  const range = /^Лист\s+.+?,\s*[A-Z]+(\d+):[A-Z]+(\d+)$/u.exec(fragment.locator);
  if (range && (range[1] !== range[2] || Number(range[1]) !== Number(id[2]))) return null;
  const tableLocator = /^Таблица(?:\s*№?\s*(\d+))?,?\s*строка\s+(\d+)$/iu.exec(fragment.locator);
  const tableId = /^table-(\d+)$/u.exec(id[1]);
  if (tableLocator && (Number(tableLocator[2]) !== Number(id[2]) || tableId && tableLocator[1] && tableId[1] !== tableLocator[1])) return null;
  const row = Number(id[2]);
  return Number.isSafeInteger(row) && row > 0 ? { row, table: range ? `sheet:${fragment.sheetId || id[1]}` : `${fragment.sheetId || ""}:${id[1] === "table" && tableLocator?.[1] ? `table-${tableLocator[1]}` : id[1]}` } : null;
}
type Header = { fragment: IntelligenceFragment; cells: string[]; columns: { person: number; name: number; validity: number; exam: number; number: number }; table: string; row: number; index: number };
const conflictingDocuments = (docs: readonly IntelligenceStaffDocument[]) => docs.some((doc, at) => doc.seriesNumber && docs.some((other, otherAt) => otherAt !== at && key(other.name) === key(doc.name) && other.seriesNumber === doc.seriesNumber && (other.examDate !== doc.examDate || other.reportedValidity !== doc.reportedValidity)));
const labels = {
  person: /^(?:контактное\s+лицо|фио|ф\.?\s*и\.?\s*о\.?|фамилия,?\s+имя,?\s+отчество)$/iu,
  name: /^сертификат$/iu, validity: /^действителен$/iu, exam: /^дата\s+сдачи$/iu, number: /^номер\s+сертификата$/iu,
};

/** Selected, visible, explicit row facts only. The header owns columns; each
 * certificate must name its own person. Group rows never fill a missing owner.
 * An incomplete source can yield candidates, never a completeness assertion. */
export function extractStaffCertificateFacts(sources: readonly IntelligenceSource[]): StaffCertificateFacts {
  const result: StaffCertificateFacts = { documents: [], skipped: [], limited: false };
  const stop = (): StaffCertificateFacts => ({ documents: [], skipped: [{ reason: "staff-certificate-limit", message: "Достигнут предел полного разбора сертификатов. Ничего не усечено; разделите материалы.", requiresReview: true }], limited: true });
  let receiptLimit = false, receiptBytes = 0;
  const skip = (reason: string, message: string, source?: IntelligenceSource, fragment?: IntelligenceFragment) => {
    const entry: SourcePreparationSkipped = { reason, message, requiresReview: true, ...(source ? { sourceId: source.id, sourceName: source.name } : {}), ...(fragment ? { fragmentId: fragment.id, locator: fragment.locator, quote: fragment.text } : {}) };
    if (result.skipped.length >= limits.receipts || (receiptBytes += bytes(JSON.stringify(entry))) > limits.resultBytes) { receiptLimit = true; return; }
    result.skipped.push(entry);
  };
  if (sources.length > limits.sources) return stop();
  const ids = new Set<string>(), duplicates = new Set<string>();
  for (const source of sources) { if (ids.has(source.id)) duplicates.add(source.id); ids.add(source.id); }
  let fragments = 0, charged = 0, outputBytes = 0;
  const identities = new Map<string, string>(), counts = new Map<string, number>(), owners = new Set<string>();
  for (const source of sources) {
    if (receiptLimit) return stop();
    if (!validId(source.id) || duplicates.has(source.id)) { skip("staff-certificate-source-identity", "Повторённый или отсутствующий идентификатор источника: сертификаты не сопоставлены."); continue; }
    const selected = source.fragments || [];
    if ((fragments += selected.length) > limits.fragments) return stop();
    const fragmentIds = new Set<string>(), coordinates = new Set<string>(); let ambiguousIdentity = false;
    for (const fragment of selected) {
      if (!visible(fragment)) continue;
      if (length(fragment.text) > limits.fragmentCharacters || (charged += bytes(fragment.text)) > limits.bytes) return stop();
      const at = coordinate(fragment), identity = at ? `${at.table}:${at.row}` : undefined;
      if (fragment.id && fragmentIds.has(fragment.id) || identity && coordinates.has(identity)) ambiguousIdentity = true;
      if (fragment.id) fragmentIds.add(fragment.id); if (identity) coordinates.add(identity);
    }
    if (ambiguousIdentity) { skip("staff-certificate-fragment-identity", "В источнике повторены идентификаторы или координаты строк. Сертификаты этого источника не распределены.", source); continue; }
    let header: Header | undefined;
    for (const [index, fragment] of selected.entries()) {
      if (receiptLimit) return stop();
      if (!visible(fragment)) { header = undefined; continue; }
      const at = coordinate(fragment), cells = fragment.text.split("\t");
      if (!at || !validId(fragment.id)) { header = undefined; continue; }
      const hits = Object.fromEntries(Object.entries(labels).map(([field, pattern]) => [field, cells.flatMap((cell, column) => pattern.test(cell.trim()) ? [column] : [])])) as Record<keyof typeof labels, number[]>;
      if (hits.name.length) {
        header = undefined;
        if (Object.values(hits).some((columns) => columns.length !== 1)) { skip("staff-certificate-header-ambiguous", "Нет единственного явного заголовка владельца, сертификата, статуса, даты сдачи и номера.", source, fragment); continue; }
        const columns = Object.fromEntries(Object.entries(hits).map(([field, columns]) => [field, columns[0]])) as Header["columns"];
        if (columns.person >= columns.name || new Set(Object.values(columns)).size !== 5) { skip("staff-certificate-header-ambiguous", "Роли колонок сертификатной таблицы неоднозначны.", source, fragment); continue; }
        if (length(fragment.text) > limits.quoteCharacters) return stop();
        header = { fragment, cells, columns, ...at, index }; continue;
      }
      if (!header || at.table !== header.table || at.row !== header.row + 1 || index !== header.index + 1 || cells.length !== header.cells.length) { header = undefined; continue; }
      header = { ...header, ...at, index };
      const column = header.columns, title = literal(cells[column.name]), status = literal(cells[column.validity]), printedDate = literal(cells[column.exam]), number = literal(cells[column.number]);
      // A sparse person-group row is allowed structurally, but its name is
      // deliberately not remembered as an owner for subsequent documents.
      if (![title, status, printedDate, number].some(Boolean)) continue;
      const prefixes = cells.slice(column.person, column.name).map(literal).filter(Boolean);
      const names = [...new Set(prefixes.filter(person))];
      if (names.length !== 1 || prefixes.some((value) => value !== names[0])) { skip("certificate-owner-ambiguous", "Каждая строка сертификата должна сама содержать единственное полное ФИО. Владелец не взят из предыдущей строки.", source, fragment); continue; }
      if (!meaningful(title) || !["Да", "Нет"].includes(status) || !safe(fragment.text) || !safe(header.fragment.text)) { skip("staff-certificate-row-invalid", "Название или буквальный статус «Да/Нет» не определены однозначно. Строка сохранена в источнике для проверки.", source, fragment); continue; }
      const exam = examDate(printedDate);
      if (exam === null) { skip("staff-certificate-exam-date", "Дата сдачи не является существующей полной датой. Она не исправлена и не выдана за срок действия.", source, fragment); continue; }
      if (length(fragment.text) > limits.quoteCharacters || length(title) > 2000 || length(number) > 2000) return stop();
      const identity = JSON.stringify([source.id, fragment.id]), id = `staff-certificate-${hash(identity)}`;
      if (identities.has(id) && identities.get(id) !== identity) return stop(); identities.set(id, identity);
      const owner = `${source.id}\u0000${key(names[0])}`; owners.add(owner); counts.set(owner, (counts.get(owner) || 0) + 1);
      if (owners.size > limits.items || counts.get(owner)! > 100) return stop();
      const document: IntelligenceStaffDocument = { id, ownerFullName: names[0], category: "certificate", name: title, seriesNumber: number, examDate: exam, reportedValidity: status, sourceId: source.id, fragmentId: fragment.id, headerFragmentId: header.fragment.id!, quote: fragment.text, headerQuote: header.fragment.text };
      if ((outputBytes += bytes(JSON.stringify(document))) > limits.resultBytes) return stop();
      result.documents.push(document);
      if (fragment.text.includes("\ufffd")) skip("certificate-text-damage", "Строка содержит символ повреждённого текста. Буквальное название сохранено без исправления; проверьте оригинал.", source, fragment);
      if (result.skipped.length > limits.receipts) return stop();
    }
  }
  return receiptLimit || bytes(JSON.stringify(result)) > limits.resultBytes ? stop() : result;
}

/** Unsaved candidates only. Existing model fields and unsupported values are
 * retained for independent review, never hidden or acknowledged here. */
export function completeSourceStaffCertificates(items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[], destinations: readonly IntelligenceDestination[] = items.map((item) => item.destination)): SourcePreparationResult {
  const unchanged = (): SourcePreparationResult => ({ items: [...items], changes: [], skipped: [], limited: false });
  if (!destinations.includes("staff")) return unchanged();
  const stop = (): SourcePreparationResult => ({ ...unchanged(), limited: true, skipped: [{ reason: "staff-certificate-completion-limit", message: "Полное дополнение сертификатов не помещается в предел. Весь этап отменён без частичной записи; разделите материалы.", requiresReview: true }] });
  if (items.length > limits.items || new Set(items.map((item) => item.id)).size !== items.length || items.some((item) => !validId(item.id))) return stop();
  const facts = extractStaffCertificateFacts(sources);
  if (facts.limited) return { ...unchanged(), skipped: facts.skipped, limited: true };
  const result = { ...unchanged(), skipped: [...facts.skipped] }, sourceMap = new Map(sources.map((source) => [source.id, source]));
  const groups = new Map<string, IntelligenceStaffDocument[]>();
  for (const doc of facts.documents) { const group = JSON.stringify([doc.sourceId, key(doc.ownerFullName)]); groups.set(group, [...(groups.get(group) || []), doc]); }
  const assignments = new Map<number, IntelligenceStaffDocument[]>(), created = new Set<number>();
  const provenance = (doc: IntelligenceStaffDocument) => {
    const source = sourceMap.get(doc.sourceId)!, fragment = source.fragments!.find((row) => row.id === doc.fragmentId)!;
    return { sourceId: doc.sourceId, sourceName: source.name, fragmentId: doc.fragmentId, locator: fragment.locator, quote: doc.quote };
  };
  for (const docs of groups.values()) {
    const first = docs[0];
    if (conflictingDocuments(docs)) { result.skipped.push({ ...provenance(first), field: "certificates", reason: "staff-certificate-conflict", message: "Один сертификат и номер имеют разные дату сдачи или статус. Новая карточка не создана, противоречие не разрешено автоматически.", requiresReview: true }); continue; }
    const owners = result.items.flatMap((item, index) => item.destination === "staff" && item.sourceIds.includes(first.sourceId) && typeof item.fields.fullName === "string" && key(item.fields.fullName) === key(first.ownerFullName) ? [index] : []);
    if (owners.length > 1) { result.skipped.push({ ...provenance(first), reason: "staff-certificate-card-ambiguous", message: "ФИО и источник совпадают с несколькими карточками. Сертификаты не распределены по порядку.", requiresReview: true }); continue; }
    let index = owners[0];
    if (index === undefined) {
      if (result.items.length >= limits.items) return stop();
      const id = `source-staff-certificate-${hash(JSON.stringify([first.sourceId, key(first.ownerFullName)]))}`;
      if (result.items.some((item) => item.id === id)) return stop();
      index = result.items.length; created.add(index);
      result.items.push({ id, destination: "staff", title: first.ownerFullName, fields: { fullName: first.ownerFullName }, selectedFields: ["fullName"], sourceIds: [first.sourceId], evidence: [] });
    }
    assignments.set(index, [...(assignments.get(index) || []), ...docs]);
  }
  for (const [index, docs] of assignments) {
    const item = result.items[index], previous = item.fields.certificates;
    if (previous !== undefined && (!Array.isArray(previous) || previous.some((name) => typeof name !== "string" || !name.trim() || length(name) > 2000))) {
      if (created.has(index)) return stop();
      result.skipped.push({ ...provenance(docs[0]), itemId: item.id, field: "certificates", reason: "staff-certificate-old-field-invalid", message: "Имеющееся поле сертификатов имеет неверную структуру. Оно не переписано; сначала исправьте исходное значение.", requiresReview: true }); continue;
    }
    if (conflictingDocuments(docs)) { result.skipped.push({ ...provenance(docs[0]), itemId: item.id, field: "certificates", reason: "staff-certificate-conflict", message: "Один сертификат и номер имеют разные дату сдачи или статус. Противоречие не разрешено автоматически.", requiresReview: true }); continue; }
    const names = [...new Set([...(previous as string[] | undefined || []), ...docs.map((doc) => doc.name)])];
    if (names.length > 100 || docs.length > 100) return stop();
    const evidence = [...(item.evidence || [])];
    for (const doc of docs) for (const claim of [
      { field: "certificates", sourceId: doc.sourceId, fragmentId: doc.fragmentId, quote: doc.quote },
      { field: "fullName", sourceId: doc.sourceId, fragmentId: doc.fragmentId, quote: doc.quote },
    ]) if (!evidence.some((old) => old.field === claim.field && old.sourceId === claim.sourceId && old.fragmentId === claim.fragmentId && old.quote === claim.quote)) evidence.push(claim);
    if (evidence.length > limits.evidence) return stop();
    const changed = JSON.stringify(item.staffDocuments) !== JSON.stringify(docs) || JSON.stringify(previous) !== JSON.stringify(names) || !item.selectedFields.includes("certificates");
    if (changed) {
      result.items[index] = { ...item, fields: { ...item.fields, certificates: names }, selectedFields: [...new Set([...item.selectedFields, "certificates"])], evidence, staffDocuments: docs };
      result.changes.push({ ...provenance(docs[0]), itemId: item.id, field: "certificates", kind: previous === undefined ? "added" : "replaced", ...(previous === undefined ? {} : { previousValue: previous }), value: names, requiresReview: true });
      if (created.has(index)) result.changes.push({ ...provenance(docs[0]), itemId: item.id, field: "record", kind: "created", requiresReview: true });
    }
  }
  return result.changes.length + result.skipped.length > limits.receipts || bytes(JSON.stringify(result)) > limits.resultBytes ? stop() : result;
}
