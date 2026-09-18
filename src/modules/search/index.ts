import { listRecords, readDraft, type ModuleId, type StoredRecord } from "../../lib/storage";
import { buildCompanyDirectoryMigration, emptyCompanyDirectory, type CompanyDirectoryData } from "../contracts/companies";
import type { ContractData } from "../contracts/types";

export type SearchTool = "procurement" | "calculator" | "contracts" | "staff" | "counterparties" | "proposals";
export interface SearchEntry { id: string; tool: SearchTool; title: string; archived: boolean; fields: string[]; updatedAt: string; }
export interface SearchHit extends SearchEntry { snippet: string; score: number; }
export const searchLabels: Record<SearchTool, string> = { procurement: "Закупки", calculator: "Расчёты", contracts: "Договоры", staff: "Кадры", counterparties: "Контрагенты", proposals: "Коммерческие предложения" };
const modules: Array<[ModuleId, SearchTool]> = [["procurement", "procurement"], ["calculator", "calculator"], ["contract-experience", "contracts"], ["staff", "staff"], ["commercial-proposals", "proposals"]];
const excluded = /^(id|.*Id|.*Ids|sha256|.*Path|.*Password|password|.*Verifier|verifier|salt|token|.*Token|signature|dataUrl|base64|mimeType|schemaVersion|snapshot|sourceSnapshot)$/i;
export const normalizeSearch = (text: string) => text.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
/** Only business modules enter this index. Credentials/settings/drafts and file bytes never do. */
export function searchableFields(value: unknown, depth = 0): string[] {
  if (depth > 12 || value == null) return [];
  if (typeof value === "string") return value.trim() && !value.startsWith("data:") ? [value] : [];
  if (typeof value === "number") return Number.isFinite(value) ? [String(value)] : [];
  if (Array.isArray(value)) return value.flatMap((item) => searchableFields(item, depth + 1));
  if (typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => excluded.test(key) ? [] : searchableFields(item, depth + 1));
}
export function recordEntry(record: StoredRecord, tool: SearchTool): SearchEntry {
  const documents = tool === "procurement" ? (record.payload as {documentVersions?: Array<{fileName?:string;fragments?:Array<{text:string;locator?:string;page?:number}>}>})?.documentVersions || [] : [];
  const fragments = documents.flatMap((document) => (document.fragments || []).map((fragment) => `[${document.fileName || "Документ"} · ${fragment.locator || (fragment.page ? `стр. ${fragment.page}` : "извлечённый текст")}] ${fragment.text}`));
  return { id: record.id, tool, title: record.title || "Без названия", archived: record.archived, updatedAt: record.updatedAt, fields: [...fragments, ...searchableFields(record.payload)] };
}
export function searchEntries(entries: SearchEntry[], query: string, tool: SearchTool | "all" = "all", includeArchived = false): SearchHit[] {
  const terms = normalizeSearch(query).split(" ").filter(Boolean);
  if (!terms.length) return [];
  return entries.flatMap((entry): SearchHit[] => {
    if ((!includeArchived && entry.archived) || (tool !== "all" && entry.tool !== tool)) return [];
    const title = normalizeSearch(entry.title);
    const normalizedFields = entry.fields.map(normalizeSearch);
    if (!terms.every((term) => title.includes(term) || normalizedFields.some((field) => field.includes(term)))) return [];
    const match = normalizedFields.findIndex((field) => terms.some((term) => field.includes(term)));
    const field = match < 0 ? entry.title : entry.fields[match];
    const position = Math.max(0, terms.reduce((best, term) => { const index = normalizeSearch(field).indexOf(term); return index < 0 ? best : Math.min(best, index); }, field.length));
    const start = Math.max(0, position - 65);
    const source = start > 0 && field.startsWith("[") ? field.slice(0, field.indexOf("]") + 1) + " " : "";
    const snippet = `${source}${start ? "…" : ""}${field.slice(start, start + 230)}${field.length > start + 230 ? "…" : ""}`;
    const score = (title === normalizeSearch(query) ? 100 : 0) + terms.filter((term) => title.includes(term)).length * 10;
    return [{ ...entry, snippet, score }];
  }).sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title, "ru"));
}
export async function loadSearchIndex(): Promise<{ entries: SearchEntry[]; errors: string[] }> {
  const results = await Promise.allSettled(modules.map(([module]) => listRecords(module, true)));
  const entries: SearchEntry[] = [];
  const errors: string[] = [];
  results.forEach((result, index) => {
    const [, tool] = modules[index];
    if (result.status === "fulfilled") entries.push(...result.value.filter((record) => tool !== "proposals" || (record.payload as {kind?:string})?.kind !== "template").map((record) => recordEntry(record, tool)));
    else errors.push(`${searchLabels[tool]}: ${String(result.reason)}`);
  });
  try {
    const stored = await readDraft<CompanyDirectoryData>("contract-experience", "company-directory-v1");
    const contracts = results[2].status === "fulfilled" ? results[2].value as StoredRecord<ContractData>[] : [];
    const { directory } = buildCompanyDirectoryMigration(stored || emptyCompanyDirectory(), contracts);
    entries.push(...directory.companies.map((company) => ({ id: company.id, tool: "counterparties" as const, title: company.name, archived: company.archived, fields: searchableFields(company), updatedAt: company.updatedAt })));
  } catch (error) { errors.push(`Контрагенты: ${String(error)}`); }
  return { entries, errors };
}
