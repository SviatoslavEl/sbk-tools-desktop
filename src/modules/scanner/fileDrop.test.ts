import { describe, expect, it } from "vitest";
import { droppedDocumentPaths } from "./fileDrop";

describe("native document drops", () => {
  it("accepts Windows, network and macOS paths without rewriting them", () => {
    const paths = ["C:\\Договоры\\Договор.PDF", "\\\\server\\Общая\\документ.docx", "/Users/test/лист.pdf"];
    expect(droppedDocumentPaths(paths)).toEqual(paths);
  });
  it("deduplicates and rejects mixed unsupported files", () => {
    expect(droppedDocumentPaths(["C:\\a.pdf", "C:\\a.pdf"])).toEqual(["C:\\a.pdf"]);
    expect(() => droppedDocumentPaths(["C:\\a.pdf", "C:\\a.exe"])).toThrow("PDF или DOCX");
    expect(() => droppedDocumentPaths([])).toThrow();
  });
});
