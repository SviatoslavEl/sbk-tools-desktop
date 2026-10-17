import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../../components/Dialog";
import { Scanner } from "./Scanner";

const runtime = vi.hoisted(() => ({
  cursor: 0, changed: false, paused: false, sourceValid: true, outputRevision: "output-revision-a",
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void; effect?: () => void | (() => void) }>, effects: [] as Array<() => void>,
  invoke: vi.fn(), preview: vi.fn(), chooseOpen: vi.fn(), chooseSave: vi.fn(), journalSave: vi.fn(),
}));
vi.mock("react", async (original) => {
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = runtime.cursor++, old = runtime.slots[index];
    if (!old || !old.deps || !deps || old.deps.length !== deps.length || old.deps.some((value, i) => !Object.is(value, deps[i]))) runtime.slots[index] = { value: factory(), deps };
    return runtime.slots[index].value;
  };
  return { ...await original<typeof import("react")>(),
    useState: (initial: unknown) => {
      const index = runtime.cursor++;
      if (!runtime.slots[index]) runtime.slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [runtime.slots[index].value, (next: unknown) => { const value = typeof next === "function" ? next(runtime.slots[index].value) : next; if (!Object.is(value, runtime.slots[index].value)) { runtime.slots[index].value = value; runtime.changed = true; } }];
    },
    useRef: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: { current: initial } }; return runtime.slots[index].value; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = runtime.cursor++, old = runtime.slots[index];
      if (old?.deps && deps && old.deps.length === deps.length && old.deps.every((value, i) => Object.is(value, deps[i]))) return;
      runtime.slots[index] = { ...old, deps, effect }; runtime.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); runtime.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; });
    },
  };
});
vi.mock("../../lib/networkDiagnostics", () => ({ invoke: runtime.invoke, networkAccessIsPaused: () => runtime.paused, useNetworkAccess: () => ({ phase: runtime.paused ? "paused" : "connected" }) }));
vi.mock("../../hooks/useRecords", () => ({ useRecords: () => ({ records: [], loading: false, error: null, save: runtime.journalSave }) }));
vi.mock("../../lib/workspaceAccess", () => ({ useWorkspaceAccess: () => ({ editor: false, message: "Просмотр" }) }));
vi.mock("../../lib/files", () => ({ chooseOpenPath: runtime.chooseOpen, chooseOpenPaths: vi.fn(), chooseSavePath: runtime.chooseSave, chooseDirectory: vi.fn() }));
vi.mock("../../lib/activity", () => ({ trackedOperation: (_label: string, action: () => unknown) => action() }));
vi.mock("./usePreviewPanelHeight", () => ({ usePreviewPanelHeight: () => ({ current: null }) }));
vi.mock("./usePreviewViewport", () => ({ usePreviewViewport: () => ({ pageElement: { current: null }, stageElement: { current: null }, zoom: 1, layout: { canvasWidth: 800, canvasHeight: 1100, pageWidth: 600, pageHeight: 800, pageLeft: 100, pageTop: 100 }, resetView: vi.fn(), setZoom: vi.fn(), startPan: vi.fn(), movePan: vi.fn(), stopPan: vi.fn(), panFromKeyboard: vi.fn(), rememberCenter: vi.fn() }) }));
vi.mock("./scannerPreviewSession", () => ({ SOURCE_CHANGED_MESSAGE: "Исходник изменился", ScannerPreviewSession: class {
  sourceGeneration = 0; sourceFingerprint: string | undefined;
  clear() { this.sourceGeneration += 1; this.sourceFingerprint = undefined; }
  pause() { /* No real worker in component tests. */ }
  schedule() { /* No speculative work in component tests. */ }
  confirmDisplayed() { /* Image readiness is driven explicitly below. */ }
  isCached() { return false; }
  async verifySource() { return runtime.sourceValid; }
  async request(settings: { inputPath: string }) { await runtime.preview(settings.inputPath); this.sourceFingerprint = `fingerprint:${settings.inputPath}`; return { previewUrl: "data:image/png;base64,c3ludGhldGlj", originalUrl: "", pageCount: 2, warnings: [], estimatedOutputBytes: 900, originalBytes: 1000, sourceFingerprint: this.sourceFingerprint }; }
} }));

type Props = { children?: ReactNode; disabled?: boolean; checked?: boolean; value?: string; src?: string; className?: string; title?: string; "aria-label"?: string;
  onClick?: () => unknown; onClose?: () => void; onChange?: (event: { target: { checked: boolean } }) => void;
  onLoad?: (event: { currentTarget: { naturalWidth: number; naturalHeight: number; getAttribute: (name: string) => string } }) => void };
let props: Parameters<typeof Scanner>[0];
let tree: ReactNode;
const ready = vi.fn();
function nodes(node: ReactNode = tree): ReactElement<Props>[] { if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null)); if (!isValidElement<Props>(node)) return []; return [node, ...nodes(node.props.children ?? null)]; }
function text(node: ReactNode = tree): string { if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join(""); if (isValidElement<Props>(node)) return text(node.props.children ?? null); return typeof node === "string" || typeof node === "number" ? String(node) : ""; }
function render() { runtime.cursor = 0; runtime.changed = false; tree = Scanner(props); for (const effect of runtime.effects.splice(0)) effect(); }
function strictReplay() { for (const slot of runtime.slots) slot.cleanup?.(); for (const slot of runtime.slots) if (slot.effect) { const cleanup = slot.effect(); slot.cleanup = typeof cleanup === "function" ? cleanup : undefined; } }
async function flush() { for (let i = 0; i < 48; i += 1) { await Promise.resolve(); if (runtime.changed) render(); } }
function findButton(label: string) { return nodes().find((node) => node.type === "button" && text(node) === label); }
function button(label: string) { const result = findButton(label); if (!result) throw new Error(`Button not found: ${label}`); return result; }
function ocrToggle() { const label = nodes().find((node) => node.type === "label" && text(node).includes("Поисковый OCR"))!; return nodes(label).find((node) => node.type === "input")!; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
async function loadRequest() {
  await flush();
  if (findButton("Загрузить для OCR")) {
    button("Загрузить для OCR").props.onClick!(); await flush(); button("Загрузить и включить OCR").props.onClick!(); await flush();
  }
  const image = nodes().find((node) => node.type === "img" && node.props.className === "page-image")!;
  image.props.onLoad!({ currentTarget: { naturalWidth: 600, naturalHeight: 800, getAttribute: () => image.props.src! } }); await flush();
}
async function saveOcr() { expect(button("Сохранить PDF").props.disabled).toBe(false); button("Сохранить PDF").props.onClick!(); await flush(); }

beforeEach(() => {
  runtime.cursor = 0; runtime.changed = false; runtime.paused = false; runtime.sourceValid = true; runtime.outputRevision = "output-revision-a";
  runtime.slots = []; runtime.effects = []; runtime.preview.mockReset(); runtime.invoke.mockReset(); runtime.chooseOpen.mockReset().mockResolvedValue("/synthetic/unrelated.pdf"); runtime.chooseSave.mockReset().mockResolvedValue("/synthetic/ocr.pdf"); runtime.journalSave.mockReset().mockResolvedValue(undefined); ready.mockReset();
  runtime.invoke.mockImplementation(async (command: string) => {
    if (command === "scanner_source_revision") return runtime.outputRevision;
    if (command === "scanner_run") return { outputPath: "/synthetic/ocr.pdf", outputSha256: "c".repeat(64), ocrText: "Распознанный синтетический текст", outputBytes: 900, originalBytes: 1000 };
    if (command === "scanner_cancel" || command === "delete_runtime_file") return;
    throw new Error(`Unexpected test invocation: ${command}`);
  });
  const target = new EventTarget();
  vi.stubGlobal("window", { addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), setTimeout: () => 1, clearTimeout: () => undefined, confirm: vi.fn(() => false) });
  vi.stubGlobal("sessionStorage", { getItem: () => null, removeItem: vi.fn() });
  props = { intelligenceOcrRequest: { id: "request-a", inputPath: "/synthetic/scan-a.pdf" }, onIntelligenceOcrReady: ready };
});
afterEach(() => { for (const slot of runtime.slots) slot.cleanup?.(); vi.unstubAllGlobals(); });

describe("scanner explicit OCR round trip", () => {
  it("starts the explicit AI OCR request in a genuinely empty scanner without a redundant replacement prompt", async () => {
    render(); await flush(); expect(text()).toContain("scan-a.pdf"); expect(runtime.preview).toHaveBeenCalledExactlyOnceWith("/synthetic/scan-a.pdf");
    expect(nodes().some((node) => node.type === Dialog)).toBe(false);
    expect(findButton("Загрузить для OCR")).toBeUndefined(); expect(ocrToggle().props.checked).toBe(true); expect(ready).not.toHaveBeenCalled();
  });
  it("starts one live automatic OCR load after StrictMode effect cleanup and replay", async () => {
    render(); strictReplay(); await flush();
    expect(runtime.preview).toHaveBeenCalledExactlyOnceWith("/synthetic/scan-a.pdf"); expect(ocrToggle().props.checked).toBe(true);
    expect(findButton("Загрузить для OCR")).toBeUndefined(); expect(ready).not.toHaveBeenCalled();
  });
  it("shows a single main file action, without presets, output tools or saving before a document is selected", async () => {
    props = {}; render(); await flush();
    expect(button("Выбрать файл")).toBeDefined(); expect(findButton("Выбрать PDF или DOCX")).toBeUndefined();
    expect(findButton("Сохранить PDF")).toBeUndefined(); expect(findButton("КонтрастныйВыраженный текст")).toBeUndefined();
    expect(nodes().some((node) => node.props["aria-label"] === "Инструменты документа")).toBe(false); expect(runtime.preview).not.toHaveBeenCalled();
  });
  it("does not start loading a hidden or network-paused scanner", async () => {
    props = { ...props, active: false }; render(); await flush(); expect(runtime.preview).not.toHaveBeenCalled();
    props = { ...props, active: true }; runtime.paused = true; render(); await flush(); expect(runtime.preview).not.toHaveBeenCalled();
    runtime.paused = false; render(); await flush(); expect(runtime.preview).toHaveBeenCalledOnce();
  });
  it("does not repeatedly retry a failed automatic load", async () => {
    runtime.preview.mockImplementation(() => { throw new Error("Синтетический отказ чтения"); });
    render(); await flush(); render(); await flush();
    expect(runtime.preview).toHaveBeenCalledOnce(); expect(findButton("Загрузить для OCR")).toBeDefined(); expect(ready).not.toHaveBeenCalled();
  });
  it("does not start a regular file replacement while the requested OCR document is loading", async () => {
    const loading = deferred<void>(); runtime.preview.mockReturnValueOnce(loading.promise);
    render(); await flush(); expect(text()).toContain("Загружаем файл для OCR");
    const replace = button("Заменить файл"); expect(replace.props.disabled).toBe(true);
    replace.props.onClick!(); await flush(); expect(runtime.chooseOpen).not.toHaveBeenCalled();
    loading.resolve(); await flush(); expect(ocrToggle().props.checked).toBe(true); expect(ready).not.toHaveBeenCalled();
  });
  it("protects a recoverable draft instead of silently discarding it for an AI request", async () => {
    const removeItem = vi.fn();
    vi.stubGlobal("sessionStorage", { getItem: () => JSON.stringify({ version: 1, inputPath: "/synthetic/draft.pdf", revision: "a".repeat(64), savedAt: Date.now(), settings: { pageOrder: [0] } }), removeItem });
    render(); await flush(); expect(runtime.preview).not.toHaveBeenCalled(); expect(button("Восстановить черновик")).toBeDefined();
    button("Загрузить для OCR").props.onClick!(); await flush(); button("Отмена").props.onClick!(); await flush();
    expect(runtime.preview).not.toHaveBeenCalled(); expect(removeItem).not.toHaveBeenCalled(); expect(button("Восстановить черновик")).toBeDefined();
  });
  it("protects retained nondefault settings even after the previous document was cleared", async () => {
    render(); await flush(); await loadRequest(); await saveOcr(); button("Другой файл").props.onClick!(); await flush();
    props = { ...props, intelligenceOcrRequest: { id: "request-b", inputPath: "/synthetic/scan-b.pdf" } }; render(); await flush();
    expect(runtime.preview.mock.calls.map((call) => call[0])).toEqual(["/synthetic/scan-a.pdf"]);
    button("Загрузить для OCR").props.onClick!(); await flush(); expect(nodes().some((node) => node.type === Dialog)).toBe(true);
    button("Отмена").props.onClick!(); await flush(); expect(runtime.preview).toHaveBeenCalledOnce();
  });
  it("allows local viewer OCR but only returns the saved complete result by a separate one-shot action", async () => {
    render(); await flush(); await loadRequest(); expect(ocrToggle().props.checked).toBe(true); expect(ready).not.toHaveBeenCalled();
    await saveOcr(); expect(runtime.journalSave).not.toHaveBeenCalled(); expect(ready).not.toHaveBeenCalled();
    expect(runtime.invoke).toHaveBeenCalledWith("scanner_run", expect.objectContaining({ operation: "process", config: expect.objectContaining({ inputPath: "/synthetic/scan-a.pdf", ocrEnabled: true, pageOrder: [0, 1], expectedSourceFingerprint: "fingerprint:/synthetic/scan-a.pdf" }) }));
    const returnAction = button("Вернуть распознанный текст в ИИ").props.onClick!; returnAction(); returnAction(); await flush();
    expect(ready).toHaveBeenCalledExactlyOnceWith({ id: "request-a", outputPath: "/synthetic/ocr.pdf", sha256: "c".repeat(64) });
    expect(findButton("Вернуть распознанный текст в ИИ")).toBeUndefined(); returnAction(); await flush(); expect(ready).toHaveBeenCalledOnce();
  });
  it("keeps PDF-ready and the unconsumed OCR-return action in one bounded footer outside the measured canvas body", async () => {
    render(); await flush(); await loadRequest();
    const footer = () => nodes().find((node) => node.type === "div" && node.props.className === "scanner-result-footer")!;
    expect(text(footer())).toContain("Сохранить PDF");
    expect(text(footer())).not.toContain("Вернуть распознанный текст в ИИ");
    await saveOcr();
    expect(text(footer())).toContain("✓ PDF готов");
    expect(text(footer())).toContain("Вернуть распознанный текст в ИИ");
    const scrollBody = nodes().find((node) => node.type === "div" && node.props.className === "scanner-preview-scroll scanner-document-body")!;
    expect(nodes(scrollBody).some((node) => node.props.className === "preview-workspace ")).toBe(true);
    expect(text(scrollBody)).not.toContain("Вернуть распознанный текст в ИИ");
    expect(text(scrollBody)).not.toContain("✓ PDF готов");
    expect(nodes(scrollBody).some((node) => node.props.className === "ocr-result")).toBe(false);
    expect(nodes(footer()).some((node) => node.props.className === "ocr-result")).toBe(true);
    expect(nodes(footer()).some((node) => node.props.className === "scanner-result-details")).toBe(true);
    const returnNotice = nodes(footer()).find((node) => node.props.className === "notice scanner-ocr-return")!;
    expect(nodes(returnNotice).some((node) => node.type === "button" && text(node) === "Вернуть распознанный текст в ИИ")).toBe(true);
    button("Вернуть распознанный текст в ИИ").props.onClick!(); await flush();
    expect(text(footer())).toContain("✓ PDF готов");
    expect(text(footer())).not.toContain("Вернуть распознанный текст в ИИ");
    expect(ready).toHaveBeenCalledOnce();
  });
  it("preserves the current document when the user cancels replacement", async () => {
    render(); await flush(); await loadRequest();
    props = { ...props, intelligenceOcrRequest: { id: "request-b", inputPath: "/synthetic/scan-b.pdf" } }; render(); await flush();
    button("Загрузить для OCR").props.onClick!(); await flush(); button("Отмена").props.onClick!(); await flush();
    expect(runtime.preview.mock.calls.map((call) => call[0])).toEqual(["/synthetic/scan-a.pdf"]); expect(text()).toContain("scan-a.pdf"); expect(ready).not.toHaveBeenCalled();
  });
  it("does not bypass the ordinary dirty-document confirmation for a regular file chooser", async () => {
    render(); await flush(); await loadRequest();
    ocrToggle().props.onChange!({ target: { checked: false } }); await flush();
    button("КонтрастныйВыраженный текст").props.onClick!(); await flush();
    const previewsBeforeChooser = runtime.preview.mock.calls.length;
    expect(text()).toContain("Есть несохранённые изменения");
    button("Заменить файл").props.onClick!(); await flush();
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(runtime.preview).toHaveBeenCalledTimes(previewsBeforeChooser);
    expect(runtime.preview.mock.calls.every((call) => call[0] === "/synthetic/scan-a.pdf")).toBe(true);
    expect(ocrToggle().props.checked).toBe(false); expect(ready).not.toHaveBeenCalled();
  });
  it("does not restore return eligibility after OCR settings are toggled away and back", async () => {
    render(); await flush(); await loadRequest(); await saveOcr(); expect(findButton("Вернуть распознанный текст в ИИ")).toBeDefined();
    const staleReturn = button("Вернуть распознанный текст в ИИ").props.onClick!;
    ocrToggle().props.onChange!({ target: { checked: false } }); await flush(); ocrToggle().props.onChange!({ target: { checked: true } }); await flush();
    expect(findButton("Вернуть распознанный текст в ИИ")).toBeUndefined(); staleReturn(); await flush(); expect(ready).not.toHaveBeenCalled();
  });
  it("does not let a captured old result action return a later request's valid output", async () => {
    render(); await flush(); await loadRequest(); await saveOcr(); const oldReturn = button("Вернуть распознанный текст в ИИ").props.onClick!;
    props = { ...props, intelligenceOcrRequest: { id: "request-b", inputPath: "/synthetic/scan-b.pdf" } }; render(); await flush();
    await loadRequest(); await saveOcr(); oldReturn(); await flush(); expect(ready).not.toHaveBeenCalled();
    button("Вернуть распознанный текст в ИИ").props.onClick!(); await flush(); expect(ready).toHaveBeenCalledExactlyOnceWith({ id: "request-b", outputPath: "/synthetic/ocr.pdf", sha256: "c".repeat(64) });
  });
  it.each(["source", "output"] as const)("rechecks the saved %s snapshot before returning", async (changed) => {
    render(); await flush(); await loadRequest(); await saveOcr(); if (changed === "source") runtime.sourceValid = false; else runtime.outputRevision = "replacement-revision";
    button("Вернуть распознанный текст в ИИ").props.onClick!(); await flush(); expect(ready).not.toHaveBeenCalled(); expect(text()).toContain("Результат не передан в ИИ"); expect(text()).toContain("PDF готов");
    expect(findButton("Вернуть распознанный текст в ИИ")).toBeUndefined();
  });
  it("ignores a late completed OCR process after the AI request changed", async () => {
    render(); await flush(); await loadRequest(); const pending = deferred<{ outputPath: string; ocrText: string }>();
    runtime.invoke.mockImplementation((command: string) => command === "scanner_run" ? pending.promise : Promise.resolve(runtime.outputRevision));
    button("Сохранить PDF").props.onClick!(); await flush();
    props = { ...props, intelligenceOcrRequest: { id: "request-b", inputPath: "/synthetic/scan-b.pdf" } }; render(); await flush();
    pending.resolve({ outputPath: "/synthetic/ocr.pdf", ocrText: "Старый результат OCR" }); await flush();
    expect(findButton("Вернуть распознанный текст в ИИ")).toBeUndefined(); expect(ready).not.toHaveBeenCalled();
  });
  it("blocks an already captured return action when file access is paused", async () => {
    render(); await flush(); await loadRequest(); await saveOcr(); const staleReturn = button("Вернуть распознанный текст в ИИ").props.onClick!;
    runtime.paused = true; render(); await flush(); staleReturn(); await flush(); expect(ready).not.toHaveBeenCalled(); expect(findButton("Вернуть распознанный текст в ИИ")).toBeUndefined();
    runtime.paused = false; render(); await flush(); expect(findButton("Вернуть распознанный текст в ИИ")).toBeUndefined();
  });
  it("does not offer an OCR return for a successful process with no recognized text", async () => {
    render(); await flush(); await loadRequest(); runtime.invoke.mockImplementation(async (command: string) => command === "scanner_run" ? { outputPath: "/synthetic/ocr.pdf", ocrText: "" } : runtime.outputRevision);
    await saveOcr(); expect(text()).toContain("OCR не вернул текст"); expect(findButton("Вернуть распознанный текст в ИИ")).toBeUndefined(); expect(ready).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "not-a-sha256", "c".repeat(63)])("explains why a saved OCR PDF without a valid process digest cannot return (%s)", async (outputSha256) => {
    render(); await flush(); await loadRequest(); runtime.invoke.mockImplementation(async (command: string) => command === "scanner_run" ? { outputPath: "/synthetic/ocr.pdf", outputSha256, ocrText: "Распознанный синтетический текст" } : runtime.outputRevision);
    await saveOcr(); expect(text()).toContain("PDF сохранён, но обработчик не вернул корректный SHA-256"); expect(text()).toContain("PDF готов");
    expect(findButton("Вернуть распознанный текст в ИИ")).toBeUndefined(); expect(ready).not.toHaveBeenCalled();
    expect(runtime.invoke.mock.calls.some((call) => call[0] === "scanner_source_revision")).toBe(false);
    expect(runtime.journalSave).not.toHaveBeenCalled();
  });
  it("does not attempt a journal mutation after a viewer's process failure", async () => {
    render(); await flush(); await loadRequest(); runtime.invoke.mockImplementation(async (command: string) => { if (command === "scanner_run") throw new Error("Синтетический отказ OCR"); return runtime.outputRevision; });
    await saveOcr(); expect(text()).toContain("Синтетический отказ OCR"); expect(runtime.journalSave).not.toHaveBeenCalled();
    expect(findButton("Вернуть распознанный текст в ИИ")).toBeUndefined(); expect(ready).not.toHaveBeenCalled();
  });

  it.each(["worker", "image"] as const)("retires a late final preview after leaving and returning to the scanner (%s pending)", async (pendingStage) => {
    render(); await flush(); await loadRequest();
    const worker = deferred<{ outputPath: string; originalPath: string }>(), image = deferred<string>();
    runtime.invoke.mockImplementation(async (command: string) => {
      if (command === "scanner_run") return pendingStage === "worker" ? worker.promise : { outputPath: "/synthetic/final.png", originalPath: "/synthetic/final-original.png" };
      if (command === "read_binary_file") return pendingStage === "image" ? image.promise : "data:image/png;base64,final-preview";
      if (command === "scanner_cancel" || command === "delete_runtime_file") return;
      if (command === "scanner_source_revision") return runtime.outputRevision;
      throw new Error(`Unexpected final-preview invocation: ${command}`);
    });
    button("Проверить итоговый вид").props.onClick!(); await flush();
    expect(findButton("Рассчитываем итоговый вид…")).toBeDefined();
    props = { ...props, active: false }; render(); await flush();
    expect(runtime.invoke).toHaveBeenCalledWith("scanner_cancel", expect.objectContaining({ jobId: expect.any(String) }));
    expect(findButton("Рассчитываем итоговый вид…")).toBeUndefined();
    props = { ...props, active: true }; render(); await flush();
    worker.resolve({ outputPath: "/synthetic/final.png", originalPath: "/synthetic/final-original.png" });
    image.resolve("data:image/png;base64,old-final-preview"); await flush();
    expect(nodes().some((node) => node.type === Dialog && node.props.title?.startsWith("Итоговый просмотр"))).toBe(false);
    expect(findButton("Рассчитываем итоговый вид…")).toBeUndefined();
    expect(button("Проверить итоговый вид").props.disabled).toBe(false);
    expect(runtime.invoke).toHaveBeenCalledWith("delete_runtime_file", { path: "/synthetic/final.png" });
    expect(runtime.invoke).toHaveBeenCalledWith("delete_runtime_file", { path: "/synthetic/final-original.png" });
    if (pendingStage === "worker") expect(runtime.invoke.mock.calls.some(([command]) => command === "read_binary_file")).toBe(false);
    // A fresh visit can explicitly request a new preview; the retired job did
    // not leave a stuck busy flag or permanently disable this scanner action.
    button("Проверить итоговый вид").props.onClick!(); await flush();
    expect(nodes().some((node) => node.type === Dialog && node.props.title?.startsWith("Итоговый просмотр"))).toBe(true);
  });

  it("retires a document's final preview when switching to merge and back without blocking navigation", async () => {
    render(); await flush(); await loadRequest();
    const worker = deferred<{ outputPath: string; originalPath: string }>();
    runtime.invoke.mockImplementation(async (command: string) => {
      if (command === "scanner_run") return worker.promise;
      if (command === "read_binary_file") return "data:image/png;base64,late-final-preview";
      if (command === "scanner_cancel" || command === "delete_runtime_file") return;
      throw new Error(`Unexpected final-preview invocation: ${command}`);
    });
    button("Проверить итоговый вид").props.onClick!(); await flush();
    button("Объединение файлов").props.onClick!(); await flush();
    expect(button("Выбрать несколько файлов")).toBeDefined();
    button("Обработка документа").props.onClick!(); await flush();
    worker.resolve({ outputPath: "/synthetic/final.png", originalPath: "/synthetic/final-original.png" }); await flush();
    expect(nodes().some((node) => node.type === Dialog && node.props.title?.startsWith("Итоговый просмотр"))).toBe(false);
    expect(findButton("Рассчитываем итоговый вид…")).toBeUndefined();
    expect(runtime.invoke.mock.calls.some(([command]) => command === "read_binary_file")).toBe(false);
    expect(runtime.invoke).toHaveBeenCalledWith("delete_runtime_file", { path: "/synthetic/final.png" });
    expect(runtime.invoke).toHaveBeenCalledWith("delete_runtime_file", { path: "/synthetic/final-original.png" });
  });
});
