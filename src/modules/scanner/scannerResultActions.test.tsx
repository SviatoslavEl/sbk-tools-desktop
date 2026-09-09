import { renderToStaticMarkup } from "react-dom/server";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openScannerResult, ScannerResultActionNotice } from "./Scanner";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("opening saved scanner results", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    { action: "pdf" as const, path: "/private/tmp/Сканер QA/готовый.pdf", reveal: false },
    { action: "folder" as const, path: "Z:\\Общая папка\\PDF блоки", reveal: false },
    { action: "reveal" as const, path: "/private/tmp/Сканер QA/готовый.pdf", reveal: true },
  ])("uses the authorized backend opener for $action", async ({ action, path, reveal }) => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    expect(await openScannerResult(path, action)).toBeNull();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_scanner_output", { path, reveal });
  });

  it("reports an opening failure without changing the saved result or launching processing", async () => {
    const savedResult = Object.freeze({ path: "/private/tmp/Сканер QA/готовый.pdf", status: "completed" });
    vi.mocked(invoke).mockRejectedValue(new Error("Нет приложения для открытия PDF"));
    const failure = await openScannerResult(savedResult.path, "pdf");
    expect(failure).toEqual({ path: savedResult.path, action: "pdf", message: "Error: Нет приложения для открытия PDF" });
    expect(savedResult).toEqual({ path: "/private/tmp/Сканер QA/готовый.pdf", status: "completed" });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_scanner_output", { path: savedResult.path, reveal: false });
    if (!failure) throw new Error("Expected an opening error");
    const html = renderToStaticMarkup(<ScannerResultActionNotice failure={failure} onDismiss={vi.fn()} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Не удалось открыть готовый PDF");
    expect(html).toContain("Результат был сохранён");
    expect(html).toContain("Повторно обрабатывать документ не нужно");
    expect(html).toContain(savedResult.path);
    expect(html).not.toContain("Не удалось обработать документ");
    expect(html).not.toMatch(/>Повторить<|>Сохранить PDF<|>Другой файл</);
    expect(html).toContain("Закрыть сообщение");
  });

  it("labels a reveal error as a folder-opening problem and clears it after a successful retry", async () => {
    const path = "Z:\\Общая папка\\готовый.pdf";
    vi.mocked(invoke).mockRejectedValueOnce("Сетевая папка недоступна").mockResolvedValueOnce(undefined);
    const failure = await openScannerResult(path, "reveal");
    if (!failure) throw new Error("Expected a folder-opening error");
    const html = renderToStaticMarkup(<ScannerResultActionNotice failure={failure} onDismiss={vi.fn()} />);
    expect(html).toContain("Не удалось открыть папку с результатом");
    expect(html).not.toContain("Не удалось открыть готовый PDF");
    expect(await openScannerResult(path, "reveal")).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
