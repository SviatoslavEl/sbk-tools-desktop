import { describe, expect, it } from "vitest";
import { converterSourceExtensions, converterSourceMatches, converterSourcePaths } from "./converterSource";
import { droppedDocumentPaths } from "./fileDrop";
import { scannerSourceExtensions } from "./scannerSource";

describe("converter input formats", () => {
  it("accepts the added formats only in the converter", () => {
    const extra = converterSourceExtensions.filter((extension) => !scannerSourceExtensions.includes(extension));
    const paths = extra.map((extension) => `C:\\Фото\\Лист.${extension.toUpperCase()}`);
    expect(converterSourcePaths([...paths, paths[0]])).toEqual(paths);
    for (const path of paths) expect(() => droppedDocumentPaths([path])).toThrow();
    expect(scannerSourceExtensions).toEqual(["pdf", "docx", "jpg", "jpeg", "png"]);
    expect(() => converterSourcePaths(["/tmp/file.exe"])).toThrow("file.exe");
  });

  it("treats JFIF as JPEG when skipping inputs already in the desired format", () => {
    expect(converterSourceMatches("/tmp/photo.JFIF", "JPEG")).toBe(true);
    expect(converterSourceMatches("/tmp/photo.JFIF", "PNG")).toBe(false);
  });
});
