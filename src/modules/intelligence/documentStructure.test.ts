import { describe, expect, it } from "vitest";
import { validDocxFragmentStructure, type DocxCellStructure, type DocxFragmentStructure } from "./documentStructure";
import { assertResponsePreparationSources } from "./responsePreparationBounds";
import type { IntelligenceSource } from "./workbenchTypes";

const paragraph = (): DocxFragmentStructure => ({ version: 1, format: "docx", method: "ooxml", part: "word/document.xml", kind: "paragraph", containerId: "docx:body", order: 0, physicalSection: 0 });
const row = (): DocxFragmentStructure => ({ ...paragraph(), kind: "table-row", containerId: "docx:table:1", tableId: "docx:table:1", rowIndex: 1, rowCount: 2, headerMarker: false,
  cells: [{ index: 0, text: "A\tвнутри ячейки\nусловие", gridSpan: 2, verticalMerge: "restart", nestedTableCount: 1 }, { index: 1, text: "", gridSpan: 1, verticalMerge: "continue", nestedTableCount: 0 }] });
const rowText = () => row().cells!.map(cell => cell.text).join("\t");
const source = (structure = row(), text = rowText()): IntelligenceSource => ({ id: "source", name: "Синтетический DOCX", text, sha256: "a".repeat(64), fragments: [{ id: "row", locator: "Таблица", text, structure }] });

describe("closed native DOCX structure, not semantic classification", () => {
  it("accepts unknown paragraph style without inventing a heading", () => {
    const value = { ...paragraph(), styleId: "CustomHeadingLookingName" };
    expect(validDocxFragmentStructure(value, "Не классифицированный текст")).toBe(true);
    expect(value).not.toHaveProperty("outlineLevel");
    expect(() => assertResponsePreparationSources([source(value, "Текст")])).not.toThrow();
  });
  it.each(["paragraph", "style"])("accepts only paired explicit %s outline evidence", basis => {
    expect(validDocxFragmentStructure({ ...paragraph(), outlineLevel: 2, outlineBasis: basis }, "Заголовок")).toBe(true);
    expect(validDocxFragmentStructure({ ...paragraph(), outlineLevel: 9, outlineBasis: basis }, "Обычный текст")).toBe(false);
    expect(validDocxFragmentStructure({ ...paragraph(), outlineLevel: 2 }, "Текст")).toBe(false);
  });
  it("retains whole cells, internal tabs, newlines, empty merged cells and nesting without fill-down", () => {
    const value = row(), before = structuredClone(value);
    expect(validDocxFragmentStructure(value, rowText())).toBe(true);
    expect(() => assertResponsePreparationSources([source()])).not.toThrow();
    expect(value).toEqual(before);
    expect(value.cells![1].text).toBe("");
    expect(validDocxFragmentStructure(value, "A\tвнутри ячейки\nусловие")).toBe(false);
  });
  it.each([false, true])("retains the native header marker %s without assigning business meaning", headerMarker => {
    expect(validDocxFragmentStructure({ ...row(), headerMarker }, rowText())).toBe(true);
  });
  it.each([
    { version: 2 }, { format: "pdf" }, { method: "guess" }, { injected: true }, { order: -1 }, { order: 50_000 }, { physicalSection: Infinity },
    { tableId: "other" }, { rowIndex: 2 }, { rowCount: 0 }, { headerMarker: "yes" }, { styleId: "not-a-row-property" }, { cells: [] },
  ])("rejects malformed/cross-owner structure %j without dropping it", patch => {
    const value = { ...row(), ...patch };
    expect(validDocxFragmentStructure(value, rowText())).toBe(false);
    expect(() => assertResponsePreparationSources([source(value as DocxFragmentStructure)])).toThrow(/формат фрагментов/u);
  });
  it.each([{ index: 1 }, { gridSpan: 0 }, { verticalMerge: "filled-down" }, { nestedTableCount: -1 }, { text: "Чужой текст" }, { extra: true }, { text: "\ud800" }])("rejects changed cells %j", patch => {
    const value = row(); value.cells![0] = { ...value.cells![0], ...patch } as DocxCellStructure;
    expect(validDocxFragmentStructure(value, rowText())).toBe(false);
  });
  it("keeps auxiliary part-local section zero without claiming body ownership", () => {
    for (const [kind, part] of [["header-footer", "word/header1.xml"], ["header-footer", "word/footer2.xml"], ["note", "word/footnotes.xml"], ["note", "word/endnotes.xml"]] as const) {
      expect(validDocxFragmentStructure({ ...paragraph(), kind, part, containerId: part }, "Текст")).toBe(true);
    }
    expect(validDocxFragmentStructure({ ...paragraph(), kind: "note", part: "word/header1.xml" }, "Текст")).toBe(false);
    expect(validDocxFragmentStructure({ ...paragraph(), kind: "header-footer", part: "word/header/../other.xml" }, "Текст")).toBe(false);
  });
  it("charges duplicated whole-cell metadata against the unchanged full snapshot budget", () => {
    const text = "я".repeat(1_500_000), value = row(); value.cells = [{ index: 0, text, gridSpan: 1, verticalMerge: "none", nestedTableCount: 0 }];
    expect(() => assertResponsePreparationSources([source(value, text)])).toThrow(/8 МБ/u);
  });
  it("allows a legacy source without structure but refuses a malformed supplied structure", () => {
    const value = source(); delete value.fragments![0].structure;
    expect(() => assertResponsePreparationSources([value])).not.toThrow();
    value.fragments![0].structure = { ...paragraph(), containerId: "bad\nidentifier" };
    expect(() => assertResponsePreparationSources([value])).toThrow(/формат фрагментов/u);
  });
  it.each([["note"], { toString: "note" }, null, 1])("does not coerce non-string kinds %j into a valid enum", kind => {
    expect(validDocxFragmentStructure({ ...paragraph(), kind, part: "word/footnotes.xml" }, "Текст")).toBe(false);
  });
  it.each([["style"], { toString: "style" }, null, true])("does not coerce non-string outline evidence %j", outlineBasis => {
    expect(validDocxFragmentStructure({ ...paragraph(), outlineLevel: 1, outlineBasis }, "Текст")).toBe(false);
  });
  it.each([["restart"], { toString: "restart" }, null, 1])("does not coerce non-string merge values %j", verticalMerge => {
    const value = row(); Object.assign(value.cells![0], { verticalMerge });
    expect(validDocxFragmentStructure(value, rowText())).toBe(false);
  });
});
