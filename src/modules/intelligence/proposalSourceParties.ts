import type { PartySnapshot } from "../proposals/types";
import { collectContractProposalFacts, type ContractProposalDocument } from "./contractProposalFacts";
import type { SourcePreparationProvenance } from "./sourcePreparedFacts";
import type { IntelligenceFragment, IntelligenceSource } from "./workbenchTypes";

export interface ProposalSourcePartyCandidate {
  id: string; documentId: string; sourceId: string; sourceName: string; sourceSha256?: string;
  role: "issuer" | "recipient";
  snapshot: PartySnapshot;
  evidence: SourcePreparationProvenance[];
  issues: string[];
}
export interface ProposalSourcePartyExtraction { candidates: ProposalSourcePartyCandidate[]; issues: string[]; limited: boolean }
const roles = { исполнитель: "issuer", поставщик: "issuer", подрядчик: "issuer", заказчик: "recipient", покупатель: "recipient" } as const;
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
const roleOf = (value: string): ProposalSourcePartyCandidate["role"] | undefined => roles[normalize(value).replace(/[:：]$/u, "") as keyof typeof roles];
const identity = (value: string) => {
  let left = 2166136261, right = 3339675911;
  for (let at = 0; at < value.length; at++) { left = Math.imul(left ^ value.charCodeAt(at), 16777619); right = Math.imul(right ^ value.charCodeAt(at), 2246822519); }
  return `${(left >>> 0).toString(16)}${(right >>> 0).toString(16)}`;
};
interface Unit extends SourcePreparationProvenance { text: string; index: number; table?: string; row?: number }
interface Block { role: ProposalSourcePartyCandidate["role"]; units: Unit[]; text: string }
const legalName = /^(?:(?:общество\s+с\s+ограниченной\s+ответственностью|(?:публичное\s+)?акционерное\s+общество|ООО|ПАО|ОАО|ЗАО|АО|АНО)\s+[«"][^»"\n]{1,180}[»"]|(?:ИП|индивидуальный\s+предприниматель)\s+[А-ЯЁ][а-яё-]+\s+[А-ЯЁ][а-яё-]+(?:\s+[А-ЯЁ][а-яё-]+)?)$/iu;
function units(source: IntelligenceSource): Unit[] {
  const fragments: IntelligenceFragment[] = source.fragments === undefined ? [{ locator: "Текст источника", text: source.text }] : source.fragments;
  return fragments.flatMap((fragment, index) => {
    if (fragment.sheetState === "hidden" || fragment.sheetState === "veryHidden") return [];
    const match = /^((?:table(?:-\d+)?)|(?:sheet-\d+))-row-(\d+)$/u.exec(fragment.id || "");
    return [{ sourceId: source.id, sourceName: source.name, ...(fragment.id ? { fragmentId: fragment.id } : {}), locator: fragment.locator, quote: fragment.text, text: fragment.text, index, ...(match ? { table: `${fragment.sheetId || ""}:${match[1]}`, row: Number(match[2]) } : {}) }];
  });
}
const proof = (unit: Unit): SourcePreparationProvenance => ({ sourceId: unit.sourceId, sourceName: unit.sourceName, ...(unit.fragmentId ? { fragmentId: unit.fragmentId } : {}), locator: unit.locator, quote: unit.quote });
function partyBlocks(rows: Unit[]): Block[] {
  const blocks: Block[] = [];
  let columns: { roles: Array<ProposalSourcePartyCandidate["role"]>; header: Unit; last: Unit; entries: Unit[][] } | undefined;
  const finish = () => {
    if (columns) columns.roles.forEach((role, index) => {
      const selected = columns!.entries[index];
      if (selected.length) blocks.push({ role, units: [columns!.header, ...selected], text: selected.map((entry) => entry.text).join("\n") });
    });
    columns = undefined;
  };
  for (const unit of rows) {
    const cells = unit.text.split("\t");
    if (cells.length === 2 && cells.every((cell) => roleOf(cell))) {
      finish(); columns = { roles: cells.map((cell) => roleOf(cell)!), header: unit, last: unit, entries: [[], []] }; continue;
    }
    if (columns) {
      if (unit.table && unit.table === columns.last.table && unit.row === (columns.last.row || 0) + 1 && unit.index === columns.last.index + 1 && cells.length === columns.roles.length) {
        cells.forEach((cell, index) => { if (cell.trim()) columns!.entries[index].push({ ...unit, quote: cell, text: cell }); }); columns.last = unit; continue;
      }
      finish();
    }
    for (const cell of cells) {
      const match = /^\s*(Исполнитель|Поставщик|Подрядчик|Заказчик|Покупатель)\s*[:：]?\s*\n([\s\S]+)$/iu.exec(cell);
      if (match) blocks.push({ role: roleOf(match[1])!, units: [{ ...unit, quote: cell, text: cell }], text: match[2] });
    }
  }
  finish(); return blocks;
}
function declaredNames(document: ContractProposalDocument, role: ProposalSourcePartyCandidate["role"]): { name: string; aliases: string[]; evidence: SourcePreparationProvenance[] } | undefined {
  const main = document.parties?.[role === "issuer" ? "executor" : "customer"];
  if (!main) return;
  const aliases: string[] = [];
  for (const entry of main.evidence) {
    const index = entry.quote.indexOf(main.value);
    const after = index >= 0 ? entry.quote.slice(index + main.value.length) : entry.quote;
    const alias = /^\s*\(((?:ООО|ПАО|ОАО|ЗАО|АО|АНО)\s+[«"][^»"\n]{1,180}[»"])\)/iu.exec(after);
    if (alias && !aliases.includes(alias[1])) aliases.push(alias[1]);
  }
  return { name: main.value, aliases, evidence: main.evidence };
}
function parseBlock(block: Block, document: ContractProposalDocument): { snapshot: PartySnapshot; evidence: SourcePreparationProvenance[]; issues: string[] } | undefined {
  const lines = block.text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const printedName = lines.find((line) => legalName.test(line));
  if (!printedName) return;
  const declared = declaredNames(document, block.role), issues: string[] = [];
  if (declared && ![declared.name, ...declared.aliases].some((name) => normalize(name) === normalize(printedName))) return;
  const snapshot: PartySnapshot = { name: declared?.name || printedName, shortName: declared?.aliases.find((name) => normalize(name) === normalize(printedName)) || (/^(?:ООО|ПАО|ОАО|ЗАО|АО|АНО|ИП)\s/u.test(printedName) ? printedName : ""), inn: "", kpp: "", ogrn: "", address: "", contact: "", paymentDetails: "" };
  const assign = (field: "inn" | "kpp" | "ogrn", pattern: RegExp) => {
    const values = [...new Set(lines.flatMap((line) => [...line.matchAll(pattern)].map((match) => match[1])))];
    if (values.length === 1) snapshot[field] = values[0];
    else if (values.length > 1) issues.push(`В реквизитах одной стороны несколько значений ${{ inn: "ИНН", kpp: "КПП", ogrn: "ОГРН" }[field]}; поле оставлено пустым.`);
  };
  assign("inn", /(?:^|[^\p{L}])ИНН\s*[:：]?\s*(\d{10}|\d{12})(?!\d)/giu);
  assign("kpp", /(?:^|[^\p{L}])КПП\s*[:：]?\s*(\d{9})(?!\d)/giu);
  assign("ogrn", /(?:^|[^\p{L}])ОГРН(?:ИП)?\s*[:：]?\s*(\d{13}|\d{15})(?!\d)/giu);
  const addresses: string[] = [], contacts: string[] = [], payment: string[] = [];
  let continuation: "address" | "payment" | undefined;
  for (const line of lines) {
    if (line === printedName || roleOf(line)) { continuation = undefined; continue; }
    if (/^(?:(?:юридический|почтовый|фактический)\s+адрес|адрес(?:\s+в\s+ЕГРЮЛ)?)\s*[:：]/iu.test(line)) { addresses.push(line); continuation = "address"; continue; }
    if (/^(?:телефон|тел\.?|e[-.]?mail|электронная\s+почта|email)\s*[:：]/iu.test(line)) { contacts.push(line); continuation = undefined; continue; }
    if (/^(?:р\/с|к\/с|расч[её]тный\s+сч[её]т|корр\.?\s*сч[её]т(?:\s+банка)?|корреспондентский\s+сч[её]т|БИК(?:\s+банка)?|Банк)\s*[:：]?\s*\S/iu.test(line)) { payment.push(line); continuation = "payment"; continue; }
    if (/^(?:ИНН|КПП|ОГРН(?:ИП)?)\s*[:：]?/iu.test(line)) { continuation = undefined; continue; }
    if (continuation === "address" && !legalName.test(line) && !/[:：]/u.test(line)) addresses.push(line);
    else if (continuation === "payment" && /^(?:(?:ПАО|АО|ООО|ОАО|ЗАО)\s+|банк\s)/iu.test(line)) payment.push(line);
    else continuation = undefined;
  }
  snapshot.address = addresses.join("\n"); snapshot.contact = contacts.join("\n"); snapshot.paymentDetails = payment.join("\n");
  const evidence = [...(declared?.evidence || []), ...block.units.map(proof)];
  return { snapshot, evidence: evidence.filter((entry, index) => evidence.findIndex((other) => other.sourceId === entry.sourceId && other.fragmentId === entry.fragmentId && other.quote === entry.quote) === index), issues };
}

/** Source-derived party snapshots with explicit role/column ownership. No
 * director is made a contact, no account/address is borrowed from a neighbour. */
export function extractProposalSourceParties(sources: readonly IntelligenceSource[]): ProposalSourcePartyExtraction {
  const result: ProposalSourcePartyExtraction = { candidates: [], issues: [], limited: false };
  const inventory = collectContractProposalFacts(sources);
  const stop = (message: string): ProposalSourcePartyExtraction => ({ candidates: [], issues: [message], limited: true });
  if (inventory.limited) return stop("Реквизиты сторон не извлечены целиком: предел или неоднозначные идентификаторы источников.");
  for (const document of inventory.documents) {
    if (!document.eligible || !document.complete || document.sourceIds.length !== 1) continue;
    const source = sources.find((entry) => entry.id === document.sourceIds[0]);
    if (!source) continue;
    const blocks = partyBlocks(units(source));
    for (const role of ["issuer", "recipient"] as const) {
      const parsed = blocks.filter((block) => block.role === role).flatMap((block) => {
        const candidate = parseBlock(block, document); return candidate ? [candidate] : [];
      });
      const unique = parsed.filter((entry, index) => parsed.findIndex((other) => JSON.stringify(other.snapshot) === JSON.stringify(entry.snapshot)) === index);
      if (unique.length > 1) { result.issues.push("Для одной роли указаны разные наборы реквизитов. Выбор первого варианта не выполнен."); continue; }
      let selected = unique[0];
      if (!selected) {
        const declared = declaredNames(document, role);
        const conflict = declared && blocks.some((block) => block.role === role && block.text.split(/\r?\n/u).some((line) => legalName.test(line.trim())));
        if (declared) selected = { snapshot: { name: declared.name, shortName: declared.aliases[0] || "", inn: "", kpp: "", ogrn: "", address: "", contact: "", paymentDetails: "" }, evidence: declared.evidence, issues: conflict ? ["Название в реквизитах не связано с явно объявленной стороной договора. Чужие реквизиты не перенесены."] : [] };
      }
      if (!selected) continue;
      if (selected.evidence.length > 100 || selected.evidence.some((entry) => entry.quote.length > 20_000) || Object.values(selected.snapshot).some((value) => typeof value !== "string" || value.length > 20_000)) return stop("Полные реквизиты превышают предел. Сведения не усечены и не перенесены частично.");
      const candidate: ProposalSourcePartyCandidate = { id: `source-party-${identity(JSON.stringify([document.documentId, source.id, role, selected.snapshot, selected.evidence]))}`, documentId: document.documentId, sourceId: source.id, sourceName: source.name, ...(source.sha256 && /^[a-f\d]{64}$/iu.test(source.sha256) ? { sourceSha256: source.sha256 } : {}), role, snapshot: selected.snapshot, evidence: selected.evidence, issues: selected.issues };
      result.candidates.push(candidate);
    }
  }
  if (result.candidates.length > 200 || new TextEncoder().encode(JSON.stringify(result)).byteLength > 4 * 1024 * 1024) return stop("Объём сторон превышает предел; реквизиты не перенесены частично.");
  return result;
}

/** Re-extract instead of trusting persisted/model-supplied candidate contents. */
export function revalidateProposalSourceParties(candidates: readonly ProposalSourcePartyCandidate[], sources: readonly IntelligenceSource[], sourceIds: readonly string[]): ProposalSourcePartyCandidate[] {
  const stale = () => new Error("Реквизиты сторон не подтверждаются текущими выбранными источниками. Повторите анализ; чужие или изменённые реквизиты не перенесены.");
  if (!Array.isArray(candidates) || candidates.length > 200 || new Set(sourceIds).size !== sourceIds.length || sourceIds.some((id) => !sources.some((source) => source.id === id))) throw stale();
  const fresh = extractProposalSourceParties(sources);
  if (fresh.limited) throw stale();
  const ids = new Set<string>();
  return candidates.map((candidate) => {
    if (!candidate || ids.has(candidate.id) || !sourceIds.includes(candidate.sourceId)) throw stale();
    ids.add(candidate.id);
    const matches = fresh.candidates.filter((current) => current.id === candidate.id && current.sourceId === candidate.sourceId && current.role === candidate.role);
    if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(candidate)) throw stale();
    // Whole fresh extraction includes role and cell ownership. Neither a
    // matching company mention elsewhere nor a quote-only mutation is enough.
    return structuredClone(matches[0]);
  });
}
