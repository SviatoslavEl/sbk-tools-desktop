import type { IntelligenceFragment, PdfBounds } from "./workbenchTypes";

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
const bounds = (value: unknown): value is PdfBounds => Array.isArray(value) && value.length === 4 && value.every((part) => typeof part === "number" && Number.isFinite(part) && Math.abs(part) <= 1_000_000) && value[0] < value[2] && value[1] < value[3];

/** Bounded transport validation, not a claim that arbitrary metadata proves a
 * relationship. The producer must independently find every closed cell. */
export function validPdfGridFragment(fragment: unknown): fragment is IntelligenceFragment & { pdfGrid: NonNullable<IntelligenceFragment["pdfGrid"]> } {
  if (!object(fragment) || typeof fragment.id !== "string" || typeof fragment.text !== "string") return false;
  const identity = /^page-([1-9]\d{0,4})-grid-([1-9]\d{0,3})-row-([1-9]\d{0,3})$/u.exec(fragment.id);
  const grid = fragment.pdfGrid;
  if (!identity || !object(grid) || !keys(grid, ["version", "page", "textLayer", "bounds", "cells"]) || grid.version !== 1 || grid.page !== Number(identity[1]) || grid.textLayer !== undefined && grid.textLayer !== "ocr" && grid.textLayer !== "text" || !bounds(grid.bounds)
    || !Array.isArray(grid.cells) || grid.cells.length < 2 || grid.cells.length > 64 || fragment.text.length > 100_000) return false;
  const row = grid.bounds;
  let right = row[0], characters = 0;
  const texts: string[] = [];
  for (const cell of grid.cells) {
    if (!object(cell) || !keys(cell, ["bounds", "text"]) || !bounds(cell.bounds) || typeof cell.text !== "string" || cell.text.length > 20_000 || /\t/u.test(cell.text)) return false;
    const rect = cell.bounds;
    if (Math.abs(rect[0] - right) > 1.5 || Math.abs(rect[1] - row[1]) > 1.5 || Math.abs(rect[3] - row[3]) > 1.5 || rect[2] > row[2] + 1.5) return false;
    characters += cell.text.length;
    if (characters > 100_000) return false;
    texts.push(cell.text); right = rect[2];
  }
  return Math.abs(right - row[2]) <= 1.5 && fragment.text === texts.join("\t");
}
