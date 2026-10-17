import type { IntelligenceFragment, IntelligenceSource } from "./workbenchTypes";
import { validPdfGridFragment } from "./pdfGrid";

export interface SourcePositionFact {
  id: string; sourceId: string; sourceName: string; fragmentId?: string; locator: string;
  quote: string; sku: string; name: string; description: string; configurationId?: string;
  ambiguous: boolean; reasons: string[];
  associationProof?: "pdf-table-row";
}
export interface SourceConfigurationFact {
  id: string; sourceId: string; sourceName: string; fragmentId?: string; locator: string;
  quote: string; name: string; description: string; componentCount: number;
  sku?: string; positionId?: string; ambiguous: boolean; reasons: string[];
  associationProof?: "pdf-table-row";
}
export interface SourcePositionFacts {
  positions: SourcePositionFact[]; configurations: SourceConfigurationFact[];
  truncated: boolean; warnings: string[];
}

export const SOURCE_POSITION_LIMITS = {
  sources: 100, fragments: 1000, totalBytes: 1024 * 1024, fragmentCharacters: 100_000,
  lines: 3000, positions: 100, configurations: 100, descriptionCharacters: 20_000,
} as const;

export const sourcePositionReasonLabels: Readonly<Record<string, string>> = {
  "unbound-configuration": "Артикул и состав не связаны явно в исходнике",
  "unbound-sku": "У состава нет однозначно указанного артикула",
  "incomplete-source": "Исходный текст может быть неполным",
  "duplicate-fragment-id": "В источнике повторяется идентификатор фрагмента",
  "multiple-sku-section": "В этой секции указано несколько артикулов",
  "missing-name": "Наименование позиции явно не обозначено",
  "uncertain-description-boundary": "Нужно проверить границы и переносы состава",
  "multiple-configurations": "Одному артикулу соответствуют несколько составов",
  "duplicate-sku": "Артикул встречается в нескольких местах",
  "conflicting-pdf-row": "Табличная связь противоречит другому выбранному фрагменту",
};

interface Line { text: string; start: number; end: number }
interface Anchor { line: number; sku: string; bindable: boolean; position: SourcePositionFact }
const skuLabel = String.raw`(?:артикул|SKU|P\s*\/\s*N|part\s*(?:number|no\.?)|код\s+(?:товара|комплектации|производителя))`;
const explicitSku = new RegExp(String.raw`\b${skuLabel}\s*[:：#№]\s*([A-Za-z0-9][A-Za-z0-9._/\-]{1,79})(?![A-Za-z0-9._/\-])`, "giu");
// Cyrillic labels do not have JS \b word boundaries. Keep this separate from
// the ASCII alternatives rather than relying on a locale-insensitive \b.
const labelledSku = new RegExp(String.raw`(?:^|[\s(,;])${skuLabel}\s*[:：#№]\s*([A-Za-z0-9][A-Za-z0-9._/\-]{1,79})(?![A-Za-z0-9._/\-])`, "giu");
const bullet = /^\s*[-–—•▪●]\s*\S/u;
const namedLine = /^\s*(?:наименование(?:\s+(?:товара|оборудования|комплектации))?|товар|оборудование)\s*[:：]\s*(\S[\s\S]*)$/iu;
const endSection = /^\s*(?:итого|всего|сумма|условия|срок|оплата|гарантия|примечание|подпись|генеральный\s+директор|контакт|юридический\s+адрес|фактический\s+адрес|дата|исполнитель|заказчик)(?:\s|[:：,]|$)/iu;
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 128 && !/[\u0000-\u001f]/u.test(id);
const validSku = (sku: string) => !/^(?:unknown|tbd|n\/?a|none|null|not|0+)$/iu.test(sku) && !/^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}$/u.test(sku) && !/[._/\-]{2,}$/u.test(sku);
const unique = (values: string[]) => [...new Set(values)];

function linesOf(text: string): Line[] {
  const lines: Line[] = []; const pattern = /[^\r\n]*(?:\r\n|\r|\n|$)/gu;
  for (const match of text.matchAll(pattern)) {
    if (!match[0]) continue;
    const value = match[0].replace(/(?:\r\n|\r|\n)$/u, "");
    lines.push({ text: value, start: match.index!, end: match.index! + value.length });
    if (lines.length > SOURCE_POSITION_LIMITS.lines) break;
  }
  return lines;
}

function configurationName(line: string): string | null {
  if (bullet.test(line)) return null;
  const name = /^\s*(.*?)\s+в\s+составе\s*[:：]\s*$/iu.exec(line)?.[1];
  if (name?.trim()) return name.trim();
  return /^\s*состав(?:\s+комплектации)?\s*[:：]\s*$/iu.test(line) ? "" : null;
}

function skuTokens(line: string): string[] {
  if (bullet.test(line)) return [];
  return unique([...line.matchAll(labelledSku)].map((match) => match[1]).filter(validSku));
}

function tableHeader(line: string): boolean {
  if (!/(?:артикул|\bSKU\b|part\s*(?:number|no\.?))/iu.test(line)) return false;
  return !line.replace(/(?:артикул|SKU|изготовитель|производитель|наименование|номер|товара|позиция|part|number|manufacturer|description|quantity|price|model|модель|цена|количество|кол-во|item|qty|no\.?|№|п\s*\/\s*п)/giu, "").replace(/[\s|;,:()./\-–—]/gu, "");
}

function skuHeader(line: string): boolean {
  return configurationName(line) !== null || !line.replace(labelledSku, "").replace(/[\s;(),]+/gu, "");
}

const literal = (value: string) => value.replace(/\s+/gu, " ").trim();

/** Closed vector-grid cells are independent source geometry, not an order
 * heuristic. Raw-page duplicates are retired only after a unique full literal
 * match. Missing/changed row evidence never borrows a composition by index. */
function applyPdfGridBindings(result: SourcePositionFacts, sources: readonly IntelligenceSource[]) {
  const rawPositions = [...result.positions], rawConfigurations = [...result.configurations];
  const candidates: Array<{ source: IntelligenceSource; fragment: IntelligenceFragment; sku: string; name: string; description: string; quote: string; count: number }> = [];
  for (const source of sources) {
    if (sources.filter((entry) => entry.id === source.id).length !== 1) continue;
    const fragmentCounts = new Map<string, number>();
    for (const fragment of source.fragments || []) if (fragment.id) fragmentCounts.set(fragment.id, (fragmentCounts.get(fragment.id) || 0) + 1);
    let header: { key: string; row: number; index: number; columns: number; sku: number; composition: number; bottom: number; columnsAt: number[] } | undefined;
    for (const [index, fragment] of (source.fragments || []).entries()) {
      const coordinate = /^page-(\d+)-grid-(\d+)-row-(\d+)$/u.exec(fragment.id || ""), grid = validPdfGridFragment(fragment) ? fragment.pdfGrid : undefined;
      if (!coordinate || !grid || grid.page !== Number(coordinate[1]) || fragment.sheetState === "hidden" || fragment.sheetState === "veryHidden" || fragmentCounts.get(fragment.id!) !== 1) { header = undefined; continue; }
      const key = `${fragment.sheetId || ""}:${coordinate[1]}:${coordinate[2]}`, row = Number(coordinate[3]);
      const skus = grid.cells.flatMap((cell, column) => /^(?:артикул|SKU|part\s*(?:number|no\.?))$/iu.test(literal(cell.text)) ? [column] : []);
      const descriptions = grid.cells.flatMap((cell, column) => /^наименование(?:\s+(?:оборудования|товара|комплектации))?(?:\s+предложенного\s+к\s+поставке)?$/iu.test(literal(cell.text)) ? [column] : []);
      if (skus.length === 1 && descriptions.length === 1) { header = { key, row, index, columns: grid.cells.length, sku: skus[0], composition: descriptions[0], bottom: grid.bounds[1], columnsAt: grid.cells.map((cell) => cell.bounds[0]) }; continue; }
      if (!header || header.key !== key || header.row + 1 !== row || header.index + 1 !== index || header.columns !== grid.cells.length || Math.abs(header.bottom - grid.bounds[3]) > 1.5 || grid.cells.some((cell, column) => Math.abs(cell.bounds[0] - header!.columnsAt[column]) > 1.5)) { header = undefined; continue; }
      header = { ...header, row, index, bottom: grid.bounds[1] };
      const sku = grid.cells[header.sku].text.trim(), cell = grid.cells[header.composition].text.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._/\-]{1,79}$/u.test(sku) || !validSku(sku) || cell.length > SOURCE_POSITION_LIMITS.descriptionCharacters || fragment.text.length > SOURCE_POSITION_LIMITS.fragmentCharacters) continue;
      const lines = linesOf(cell), name = configurationName(lines[0]?.text || ""), count = lines.slice(1).filter((line) => bullet.test(line.text)).length;
      if (!name || !count || !bullet.test(lines[1]?.text || "") || lines.slice(1).some((line) => configurationName(line.text) !== null || skuTokens(line.text).length || endSection.test(line.text))) continue;
      candidates.push({ source, fragment, sku, name, description: cell.slice(lines[1].start), quote: cell, count });
    }
  }
  for (const candidate of candidates) {
    const { source, fragment, sku, name, description, quote, count } = candidate;
    const warn = () => { result.warnings = unique([...result.warnings, "Связь SKU и состава в таблице неоднозначна или не совпала с полным исходным текстом. Сопоставьте её вручную; автоматический выбор не выполнен."]).slice(0, 100); };
    if (candidates.filter((entry) => entry.sku.toUpperCase() === sku.toUpperCase()).length !== 1) { warn(); continue; }
    const positions = rawPositions.filter((entry) => entry.sourceId === source.id && entry.sku.toUpperCase() === sku.toUpperCase());
    const configurations = rawConfigurations.filter((entry) => entry.sourceId === source.id && (literal(entry.quote) === literal(quote) || literal(entry.quote).endsWith(` ${literal(quote)}`)));
    const conflict = () => {
      warn();
      for (const position of positions) { position.ambiguous = true; position.reasons = unique([...position.reasons, "conflicting-pdf-row"]); }
      for (const configuration of rawConfigurations.filter((entry) => positions.some((position) => position.configurationId === entry.id))) { configuration.ambiguous = true; configuration.reasons = unique([...configuration.reasons, "conflicting-pdf-row"]); }
    };
    if (positions.length > 1 || configurations.length > 1 || positions.some((entry) => entry.configurationId && !configurations.some((configuration) => configuration.id === entry.configurationId))
      || rawConfigurations.some((entry) => entry.sourceId === source.id && entry.sku?.toUpperCase() === sku.toUpperCase() && !configurations.includes(entry))) { conflict(); continue; }
    // If a raw page exposed composition blocks but none equals this complete
    // cell, do not silently replace disagreement with a different extraction.
    if (rawConfigurations.some((entry) => entry.sourceId === source.id) && !configurations.length) { conflict(); continue; }
    if (result.positions.length - positions.length >= SOURCE_POSITION_LIMITS.positions || result.configurations.length - configurations.length >= SOURCE_POSITION_LIMITS.configurations) { result.truncated = true; continue; }
    const base = { sourceId: source.id, sourceName: source.name, fragmentId: fragment.id, locator: fragment.locator, associationProof: "pdf-table-row" as const, ambiguous: false, reasons: [] };
    const positionId = `grid-position:${JSON.stringify([source.id, fragment.id, sku])}`, configurationId = `grid-configuration:${JSON.stringify([source.id, fragment.id, sku])}`;
    result.positions = result.positions.filter((entry) => !positions.includes(entry));
    result.configurations = result.configurations.filter((entry) => !configurations.includes(entry));
    result.positions.push({ ...base, id: positionId, sku, name, description, quote: fragment.text, configurationId });
    result.configurations.push({ ...base, id: configurationId, sku, name, description, componentCount: count, quote, positionId });
  }
}

/**
 * Evidence finder, not a semantic parser. Detached table rows and composition
 * blocks are NEVER paired by their order, count, filename or model output.
 * Every quoted value is a literal substring of one eligible source fragment.
 */
export function extractSourcePositionFacts(sources: readonly IntelligenceSource[]): SourcePositionFacts {
  const result: SourcePositionFacts = { positions: [], configurations: [], truncated: false, warnings: [] };
  let fragmentCount = 0, totalBytes = 0;
  const warn = (message: string, truncated = false) => { result.warnings = unique([...result.warnings, message]).slice(0, 100); result.truncated ||= truncated; };
  const boundedSources = sources.slice(0, SOURCE_POSITION_LIMITS.sources);
  const duplicates = new Set(boundedSources.flatMap((source, index) => boundedSources.findIndex((entry) => entry.id === source.id) !== index ? [source.id] : []));
  if (sources.length > SOURCE_POSITION_LIMITS.sources) warn("Превышен предел источников поиска артикулов; часть материалов не проверена.", true);
  sourceLoop: for (const source of boundedSources) {
    if (!validId(source.id) || duplicates.has(source.id)) { warn("Источник с отсутствующим или повторяющимся идентификатором пропущен."); continue; }
    // Explicit fragments, even an empty selection, are authoritative. Never
    // resurrect hidden/removed aggregate source.text behind that selection.
    const fragments: IntelligenceFragment[] = source.fragments === undefined ? [{ locator: "Текст источника", text: source.text }] : source.fragments.slice(0, SOURCE_POSITION_LIMITS.fragments);
    if (source.fragments && source.fragments.length > fragments.length) warn("Превышен предел фрагментов; часть материалов не проверена.", true);
    for (const [fragmentIndex, fragment] of fragments.entries()) {
      if ((fragment.sheetState === "hidden" || fragment.sheetState === "veryHidden") && fragment.includedByUser !== true) continue;
      if (++fragmentCount > SOURCE_POSITION_LIMITS.fragments) { warn("Превышен предел фрагментов; часть материалов не проверена.", true); break sourceLoop; }
      const text = fragment.text || "";
      if (text.length > SOURCE_POSITION_LIMITS.fragmentCharacters) { warn("Превышен объём поиска артикулов; большой фрагмент пропущен целиком.", true); continue; }
      totalBytes += new TextEncoder().encode(text).byteLength;
      if (totalBytes > SOURCE_POSITION_LIMITS.totalBytes) { warn("Превышен объём поиска артикулов; большой фрагмент пропущен целиком.", true); break sourceLoop; }
      const lines = linesOf(text);
      if (lines.length > SOURCE_POSITION_LIMITS.lines) { warn("Слишком много строк; фрагмент пропущен целиком.", true); continue; }
      if (fragment.pdfGrid !== undefined) continue;
      const fragmentId = validId(fragment.id) ? fragment.id : undefined;
      const base = { sourceId: source.id, sourceName: source.name.slice(0, 500), ...(fragmentId ? { fragmentId } : {}), locator: fragment.locator.slice(0, 500) || `Фрагмент ${fragmentIndex + 1}` };
      const sharedReasons = source.coverage?.complete === false ? ["incomplete-source"] : [];
      const duplicateFragment = Boolean(fragmentId && fragments.filter((entry) => entry.id === fragmentId).length > 1);
      if (duplicateFragment) sharedReasons.push("duplicate-fragment-id");
      const stableId = (kind: string, offset: number, sku = "") => `${kind}:${JSON.stringify([source.id, fragmentId || `fragment-${fragmentIndex}`, duplicateFragment ? fragmentIndex : null, offset, sku])}`;
      const anchors: Anchor[] = [];
      let tableAt = -100;
      for (const [lineIndex, line] of lines.entries()) {
        if (tableHeader(line.text)) tableAt = lineIndex;
        const explicit = skuTokens(line.text);
        const table = lineIndex - tableAt <= 16 && /^\s*\d{1,4}[.)]?\s+([A-Za-z0-9][A-Za-z0-9._/\-]{2,79})(?:\s|$)/u.exec(line.text)?.[1];
        const tokens = explicit.length ? explicit : table && /[A-Za-z]/u.test(table) && /\d/u.test(table) && validSku(table) ? [table] : [];
        if (tokens.length && !explicit.length) tableAt = lineIndex;
        if (!tokens.length && tableAt >= 0 && lineIndex > tableAt && endSection.test(line.text)) tableAt = -100;
        for (const sku of tokens) {
          if (line.text.length > SOURCE_POSITION_LIMITS.descriptionCharacters) { warn("Строка артикула слишком длинная; она пропущена без обрезки.", true); break; }
          if (result.positions.length >= SOURCE_POSITION_LIMITS.positions) { warn("Найдено более 100 артикулов; дальнейшие позиции не показаны.", true); break; }
          const position: SourcePositionFact = { ...base, id: stableId("position", line.start, sku), quote: text.slice(line.start, line.end), sku, name: "", description: "", ambiguous: true, reasons: [...sharedReasons, "unbound-configuration"] };
          result.positions.push(position); anchors.push({ line: lineIndex, sku, bindable: explicit.length > 0 && skuHeader(line.text), position });
        }
      }
      for (const [headingIndex, heading] of lines.entries()) {
        let name = configurationName(heading.text);
        if (name === null) continue;
        if (heading.text.length > 2000) { warn("Заголовок состава слишком длинный; состав пропущен без обрезки.", true); continue; }
        let first = headingIndex + 1;
        while (first < lines.length && !lines[first].text.trim()) first++;
        if (first >= lines.length || !bullet.test(lines[first].text)) continue;
        let end = first, componentCount = 0, uncertainEnd = false;
        while (end < lines.length) {
          const line = lines[end].text;
          if (configurationName(line) !== null || skuTokens(line).length || namedLine.test(line) || endSection.test(line) || !line.trim()) break;
          if (bullet.test(line)) componentCount++;
          else if (end > first && /[;.]\s*$/u.test(lines[end - 1].text)) { uncertainEnd = true; break; }
          else if (!/^\s*(?:\d+(?:[,.]\d+)?\s*)?(?:шт\.?|компл\.?|ед\.?)\s*[;.]?\s*$/iu.test(line)) uncertainEnd = true;
          end++;
        }
        let quoteStart = heading.start;
        const description = text.slice(lines[first].start, lines[end - 1].end);
        if (description.length > SOURCE_POSITION_LIMITS.descriptionCharacters || result.configurations.length >= SOURCE_POSITION_LIMITS.configurations) { warn("Превышен предел составов/длины описания; состав пропущен целиком, без обрезки.", true); continue; }
        const candidates = anchors.filter((anchor) => {
          if (!anchor.bindable || anchor.line > headingIndex || headingIndex - anchor.line > 6) return false;
          return lines.slice(anchor.line + 1, headingIndex).every((line) => !line.text.trim() || namedLine.test(line.text));
        });
        if (!name) for (let index = headingIndex - 1; index >= Math.max(0, headingIndex - 5); index--) {
          const found = namedLine.exec(lines[index].text)?.[1];
          if (found) { name = found.trim(); quoteStart = lines[index].start; break; }
          if (lines[index].text.trim() && !skuTokens(lines[index].text).length) break;
        }
        // A SKU may be printed in the composition heading itself. Remove only
        // the labelled identifier from the display name, not any components.
        if (name && skuTokens(heading.text).length) name = name.replace(labelledSku, " ").replace(explicitSku, " ").replace(/^[\s,;()]+|[\s,;()]+$/gu, "").trim();
        const reasons = [...sharedReasons, ...(candidates.length === 1 ? [] : [candidates.length ? "multiple-sku-section" : "unbound-sku"]), ...(!name ? ["missing-name"] : []), ...(uncertainEnd ? ["uncertain-description-boundary"] : [])];
        const configuration: SourceConfigurationFact = { ...base, id: stableId("configuration", heading.start), quote: text.slice(quoteStart, lines[end - 1].end), name: name || "", description, componentCount, ambiguous: reasons.length > 0, reasons };
        if (candidates.length === 1) {
          const position = candidates[0].position;
          if (position.configurationId) { configuration.reasons.push("multiple-configurations"); configuration.ambiguous = true; position.reasons = unique([...position.reasons, "multiple-configurations"]); position.ambiguous = true; }
          else {
            configuration.sku = position.sku; configuration.positionId = position.id;
            configuration.quote = text.slice(lines[candidates[0].line].start, lines[end - 1].end);
            position.configurationId = configuration.id; position.name = configuration.name; position.description = description;
            position.quote = configuration.quote;
            position.reasons = [...reasons]; position.ambiguous = reasons.length > 0;
          }
        }
        result.configurations.push(configuration);
      }
    }
  }
  if (!result.truncated) applyPdfGridBindings(result, boundedSources);
  const skuCounts = new Map<string, number>();
  for (const position of result.positions) skuCounts.set(position.sku.toUpperCase(), (skuCounts.get(position.sku.toUpperCase()) || 0) + 1);
  for (const position of result.positions) if ((skuCounts.get(position.sku.toUpperCase()) || 0) > 1) {
    position.ambiguous = true; position.reasons = unique([...position.reasons, "duplicate-sku"]);
    const configuration = result.configurations.find((entry) => entry.id === position.configurationId);
    if (configuration) { configuration.ambiguous = true; configuration.reasons = unique([...configuration.reasons, "duplicate-sku"]); }
  }
  return result;
}
