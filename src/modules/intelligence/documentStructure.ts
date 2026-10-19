/** Producer-reported OOXML structure, not a semantic/business classification.
 * The immutable source snapshot binds these fields together with whole text.
 * Nothing here attests file bytes independently of the native extractor. */
export interface DocxCellStructure {
  index: number;
  text: string;
  gridSpan: number;
  verticalMerge: "none" | "restart" | "continue";
  nestedTableCount: number;
}
export interface DocxFragmentStructure {
  version: 1;
  format: "docx";
  method: "ooxml";
  part: string;
  kind: "paragraph" | "table-row" | "header-footer" | "note";
  containerId: string;
  order: number;
  /** Part-local physical sectPr index. Not a logical section or a link from
   * shared header/footer/notes to a body section. Aux parts normally use 0. */
  physicalSection: number;
  styleId?: string;
  outlineLevel?: number;
  outlineBasis?: "paragraph" | "style";
  tableId?: string;
  rowIndex?: number;
  rowCount?: number;
  /** False means no effective native marker, not proof of a semantic body row. */
  headerMarker?: boolean;
  cells?: DocxCellStructure[];
}

export const DOCX_STRUCTURE_LIMITS = Object.freeze({ fragments: 50_000, cellsPerRow: 4096, gridSpan: 16_384, textCharacters: 8 * 1024 * 1024 });
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const wellFormed = (value: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length <= maximum && wellFormed(value) && !control.test(value);
const identifier = (value: unknown): value is string => text(value, 256) && Boolean(value.trim()) && !/[\t\r\n]/u.test(value);
const integer = (value: unknown, minimum: number, maximum: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const has = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const base = ["version", "format", "method", "part", "kind", "containerId", "order", "physicalSection"];
const paragraph = ["styleId", "outlineLevel", "outlineBasis"];
const table = ["tableId", "rowIndex", "rowCount", "headerMarker", "cells"];

/** Closed shape and whole-cell ownership validation only. Does not infer
 * headings from text/style names or authorize a model decision/reference. */
export function validDocxFragmentStructure(value: unknown, fragmentText: string): value is DocxFragmentStructure {
  if (!plain(value) || base.some(key => !has(value, key))
    || value.version !== 1 || value.format !== "docx" || value.method !== "ooxml"
    || !identifier(value.part) || !identifier(value.containerId)
    || !integer(value.order, 0, DOCX_STRUCTURE_LIMITS.fragments - 1)
    || !integer(value.physicalSection, 0, DOCX_STRUCTURE_LIMITS.fragments)
    || typeof value.kind !== "string" || !["paragraph", "table-row", "header-footer", "note"].includes(value.kind)) return false;
  const allowed = [...base, ...(value.kind === "paragraph" ? paragraph : value.kind === "table-row" ? table : [])];
  if (Object.keys(value).some(key => !allowed.includes(key))) return false;
  if (value.kind === "paragraph" || value.kind === "table-row") {
    if (value.part !== "word/document.xml") return false;
  } else if (value.kind === "header-footer") {
    if (!/^word\/(?:header|footer)[^/\\\u0000-\u001f]*\.xml$/u.test(value.part) || value.part.includes("..")) return false;
  } else if (value.part !== "word/footnotes.xml" && value.part !== "word/endnotes.xml") return false;
  if (value.kind === "paragraph") {
    if (has(value, "styleId") && !identifier(value.styleId)) return false;
    if (has(value, "outlineLevel") !== has(value, "outlineBasis")) return false;
    if (has(value, "outlineLevel") && (!integer(value.outlineLevel, 0, 8) || typeof value.outlineBasis !== "string" || !["paragraph", "style"].includes(value.outlineBasis))) return false;
  }
  if (value.kind !== "table-row") return true;
  if (table.some(key => !has(value, key)) || !identifier(value.tableId) || value.containerId !== value.tableId
    || !integer(value.rowCount, 1, DOCX_STRUCTURE_LIMITS.fragments) || !integer(value.rowIndex, 0, value.rowCount - 1)
    || typeof value.headerMarker !== "boolean" || !Array.isArray(value.cells)
    || value.cells.length < 1 || value.cells.length > DOCX_STRUCTURE_LIMITS.cellsPerRow) return false;
  const cells: string[] = [];
  let total = 0;
  for (const [index, cell] of value.cells.entries()) {
    if (!plain(cell) || Object.keys(cell).length !== 5 || ["index", "text", "gridSpan", "verticalMerge", "nestedTableCount"].some(key => !has(cell, key))
      || cell.index !== index || !text(cell.text, DOCX_STRUCTURE_LIMITS.textCharacters)
      || !integer(cell.gridSpan, 1, DOCX_STRUCTURE_LIMITS.gridSpan)
      || typeof cell.verticalMerge !== "string" || !["none", "restart", "continue"].includes(cell.verticalMerge)
      || !integer(cell.nestedTableCount, 0, DOCX_STRUCTURE_LIMITS.fragments)) return false;
    total += cell.text.length;
    if (total + value.cells.length - 1 > DOCX_STRUCTURE_LIMITS.textCharacters) return false;
    cells.push(cell.text);
  }
  return cells.join("\t") === fragmentText;
}
