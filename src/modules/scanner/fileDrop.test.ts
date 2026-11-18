import { describe, expect, it } from "vitest";
import { droppedDocumentPaths } from "./fileDrop";

describe("native document drops", () => {
  it("accepts Windows, network and macOS paths without rewriting them", () => {
    const paths = ["C:\\Договоры\\Договор.PDF", "C:\\Договоры\\оборот.JPG", "\\\\server\\Общая\\печать.png", "/Users/test/лист.JPEG", "/Users/test/документ.docx"];
    expect(droppedDocumentPaths(paths)).toEqual(paths);
  });
  it("deduplicates and rejects mixed unsupported files", () => {
    expect(droppedDocumentPaths(["C:\\a.pdf", "C:\\a.pdf"])).toEqual(["C:\\a.pdf"]);
    expect(() => droppedDocumentPaths(["C:\\a.png", "C:\\a.exe"])).toThrow("PDF, DOCX, JPEG и PNG");
    expect(() => droppedDocumentPaths([])).toThrow();
  });
});
