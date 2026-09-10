import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Scanner } from "./Scanner";
import { belongsToScannerResult, emptyScannerOperationStates, updateScannerOperationState, type ScannerOperationStates, type ScannerWorkspaceMode } from "./scannerOperationState";

const fixture = vi.hoisted(() => ({ mode: "document" as ScannerWorkspaceMode, states: null as ScannerOperationStates | null }));

// Seed the real component's initial operation feedback without a browser or
// production-only test props. All remaining hooks and markup run normally.
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => react.useState(
    initial === "document" ? fixture.mode : initial === emptyScannerOperationStates && fixture.states ? fixture.states : initial,
  ) };
});

describe("scanner operation feedback ownership", () => {
  beforeEach(() => { fixture.mode = "document"; fixture.states = emptyScannerOperationStates(); });

  it.each(["single", "batch", "split"] as const)("does not present a completed document %s as a merged PDF with zero input files", (resultKind) => {
    fixture.states = updateScannerOperationState(fixture.states!, "document", {
      resultPath: "/tmp/document-result.pdf", resultKind,
      progress: { stage: "Документ готов", percent: 100, currentPage: 2, totalPages: 2 },
      warnings: ["Предупреждение документа"], error: "Ошибка только документа",
    });
    fixture.mode = "merge";
    const html = renderToStaticMarkup(<Scanner />);
    expect(html).not.toContain("Объединённый PDF готов");
    expect(html).not.toContain("Сохранить ещё одну копию");
    expect(html).not.toContain("document-result.pdf");
    expect(html).not.toContain("Документ готов");
    expect(html).not.toContain("Предупреждение документа");
    expect(html).not.toContain("Ошибка только документа");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Объединить 0 стр. из 0 файлов<\/button>/);
  });

  it("does not present a completed merge as the single-document result", () => {
    fixture.states = updateScannerOperationState(fixture.states!, "merge", {
      resultPath: "/tmp/merged-result.pdf", resultKind: "single",
      progress: { stage: "Документы объединены", percent: 100, currentPage: 4, totalPages: 4 },
      error: "Ошибка только объединения", warnings: ["Предупреждение объединения"],
    });
    const html = renderToStaticMarkup(<Scanner />);
    expect(html).not.toContain("merged-result.pdf");
    expect(html).not.toContain("PDF готов");
    expect(html).not.toContain("Сохранить ещё одну версию");
    expect(html).not.toContain("Документы объединены");
    expect(html).not.toContain("Ошибка только объединения");
    expect(html).not.toContain("Предупреждение объединения");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Сохранить PDF<\/button>/);
  });

  it("keeps each saved result on return to its own mode", () => {
    fixture.states = updateScannerOperationState(fixture.states!, "document", { resultPath: "/tmp/single.pdf", resultKind: "single" });
    fixture.states = updateScannerOperationState(fixture.states, "merge", { resultPath: "/tmp/merged.pdf", resultKind: "single" });
    fixture.mode = "merge";
    const mergeHtml = renderToStaticMarkup(<Scanner />);
    expect(mergeHtml).toContain("✓ Объединённый PDF готов");
    expect(mergeHtml).toContain("/tmp/merged.pdf");
    expect(mergeHtml).not.toContain("/tmp/single.pdf");
    fixture.mode = "document";
    const documentHtml = renderToStaticMarkup(<Scanner />);
    expect(documentHtml).toContain("✓ PDF готов");
    expect(documentHtml).toContain("/tmp/single.pdf");
    expect(documentHtml).not.toContain("/tmp/merged.pdf");
  });

  it("routes late progress, preview errors and warnings to the originating operation only", () => {
    const states = emptyScannerOperationStates();
    const document = Object.freeze({ ...states.document, resultPath: "/tmp/single.pdf", resultKind: "single" as const });
    let next: ScannerOperationStates = { ...states, document };
    const progress = { stage: "Объединение", percent: 60, currentPage: 3, totalPages: 5 };
    next = updateScannerOperationState(next, "merge", { progress });
    next = updateScannerOperationState(next, "merge", { error: "Ошибка просмотра", warnings: ["Проверьте шрифты"] });
    expect(next.document).toBe(document);
    expect(next.merge).toMatchObject({ progress, error: "Ошибка просмотра", warnings: ["Проверьте шрифты"] });
    const cleared = updateScannerOperationState(next, "merge", { resultPath: "", resultKind: "", progress: null, error: "", warnings: [] });
    expect(cleared.document).toBe(document);
    expect(cleared.merge).toEqual(states.merge);
  });

  it("does not leak a late opening failure to another operation even when output paths match", () => {
    const failure = { mode: "document" as const, path: "/tmp/ready.pdf" };
    expect(belongsToScannerResult(failure, "document", failure.path)).toBe(true);
    expect(belongsToScannerResult(failure, "merge", failure.path)).toBe(false);
    expect(belongsToScannerResult(failure, "document", "/tmp/new-result.pdf")).toBe(false);
    expect(belongsToScannerResult(failure, "document", "")).toBe(false);
    expect(belongsToScannerResult(null, "document", failure.path)).toBe(false);
  });
});
