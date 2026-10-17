import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scanner } from "./Scanner";

const runtime = vi.hoisted(() => ({
  cursor: 0, changed: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>, effects: [] as Array<() => void>,
  invoke: vi.fn(), chooseOpen: vi.fn(), dimensions: vi.fn(), fitPage: vi.fn(), setZoom: vi.fn(), viewportZoom: 1, document: "/synthetic/a.pdf",
  loadedDocuments: [] as string[],
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
      return [runtime.slots[index].value, (next: unknown) => {
        const value = typeof next === "function" ? next(runtime.slots[index].value) : next;
        if (!Object.is(value, runtime.slots[index].value)) { runtime.slots[index].value = value; runtime.changed = true; }
      }];
    },
    useRef: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: { current: initial } }; return runtime.slots[index].value; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = runtime.cursor++, old = runtime.slots[index];
      if (old?.deps && deps && old.deps.length === deps.length && old.deps.every((value, i) => Object.is(value, deps[i]))) return;
      runtime.slots[index] = { ...old, deps };
      runtime.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); runtime.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; });
    },
  };
});
vi.mock("../../lib/networkDiagnostics", () => ({ invoke: runtime.invoke, networkAccessIsPaused: () => false, useNetworkAccess: () => ({ phase: "connected" }) }));
vi.mock("../../hooks/useRecords", () => ({ useRecords: () => ({ records: [], loading: false, error: null, save: vi.fn() }) }));
vi.mock("../../lib/workspaceAccess", () => ({ useWorkspaceAccess: () => ({ editor: false, message: "Просмотр" }) }));
vi.mock("../../lib/files", () => ({ chooseOpenPath: runtime.chooseOpen, chooseOpenPaths: vi.fn(), chooseSavePath: vi.fn(), chooseDirectory: vi.fn() }));
vi.mock("../../lib/activity", () => ({ trackedOperation: (_label: string, action: () => unknown) => action() }));
vi.mock("./facsimileSize", async (original) => ({ ...await original<typeof import("./facsimileSize")>(), imageDimensions: runtime.dimensions }));
vi.mock("./usePreviewPanelHeight", () => ({ usePreviewPanelHeight: () => ({ current: null }) }));
vi.mock("./usePreviewViewport", () => ({ usePreviewViewport: () => ({ pageElement: { current: null }, stageElement: { current: null }, zoom: runtime.viewportZoom, fittingPage: false, fitPage: runtime.fitPage, layout: {}, resetView: vi.fn(), setZoom: runtime.setZoom, startPan: vi.fn(), movePan: vi.fn(), stopPan: vi.fn(), panFromKeyboard: vi.fn(), rememberCenter: vi.fn() }) }));
vi.mock("./scannerPreviewSession", () => ({ SOURCE_CHANGED_MESSAGE: "Исходник изменился", ScannerPreviewSession: class {
  sourceGeneration = 0; sourceFingerprint: string | undefined;
  clear() { this.sourceGeneration += 1; this.sourceFingerprint = undefined; }
  pause() { /* No speculative work. */ }
  schedule() { /* No worker launched. */ }
  confirmDisplayed() { /* Driven by explicit image onLoad below. */ }
  isCached() { return false; }
  async verifySource() { return true; }
  async request(settings: { inputPath: string }) {
    runtime.loadedDocuments.push(settings.inputPath);
    this.sourceFingerprint = `revision:${settings.inputPath}`;
    return { previewUrl: `data:image/png;base64,${settings.inputPath}`, originalUrl: "", pageCount: 2, warnings: [], estimatedOutputBytes: 900, originalBytes: 1000, sourceFingerprint: this.sourceFingerprint };
  }
} }));

type Props = { children?: ReactNode; disabled?: boolean; className?: string; src?: string; alt?: string;
  onClick?: () => unknown; onLoad?: (event: { currentTarget: { naturalWidth: number; naturalHeight: number; getAttribute: (name: string) => string } }) => void };
let tree: ReactNode;
function nodes(node: ReactNode = tree): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null));
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children ?? null)];
}
function text(node: ReactNode = tree): string {
  if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join("");
  if (isValidElement<Props>(node)) return text(node.props.children ?? null);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function render() { runtime.cursor = 0; runtime.changed = false; tree = Scanner({}); for (const effect of runtime.effects.splice(0)) effect(); }
async function flush() { for (let i = 0; i < 48; i += 1) { await Promise.resolve(); if (runtime.changed) render(); } }
function button(label: string) { const result = nodes().find((node) => node.type === "button" && text(node) === label); if (!result) throw new Error(`Button not found: ${label}`); return result; }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
async function openDocument(path: string, first = false) {
  runtime.document = path;
  button(first ? "Выбрать файл" : "Заменить файл").props.onClick!(); await flush();
  const image = nodes().find((node) => node.type === "img" && node.props.className === "page-image")!;
  image.props.onLoad!({ currentTarget: { naturalWidth: 600, naturalHeight: 800, getAttribute: () => image.props.src! } }); await flush();
}

beforeEach(async () => {
  runtime.cursor = 0; runtime.changed = false; runtime.slots = []; runtime.effects = []; runtime.document = "/synthetic/a.pdf";
  runtime.loadedDocuments = [];
  runtime.fitPage.mockReset();
  runtime.setZoom.mockReset(); runtime.viewportZoom = 1;
  runtime.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "read_binary_file") return "data:image/png;base64,synthetic-stamp";
    if (command === "scanner_cancel" || command === "delete_runtime_file") return;
    throw new Error(`Unexpected test invocation: ${command}`);
  });
  runtime.chooseOpen.mockReset().mockImplementation(async (label: string) => label === "Выберите факсимиле" ? "/synthetic/stamp.png" : runtime.document);
  runtime.dimensions.mockReset().mockResolvedValue([600, 300]);
  const target = new EventTarget();
  vi.stubGlobal("window", { addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), setTimeout: () => 1, clearTimeout: () => undefined, confirm: vi.fn(() => true) });
  vi.stubGlobal("sessionStorage", { getItem: () => null, removeItem: vi.fn() });
  vi.stubGlobal("HTMLElement", class HTMLElement {});
  render(); await flush(); await openDocument("/synthetic/a.pdf", true);
});
afterEach(() => { for (const slot of runtime.slots) slot.cleanup?.(); vi.unstubAllGlobals(); });

async function recoveryScreen() {
  for (const slot of runtime.slots) slot.cleanup?.();
  runtime.cursor = 0; runtime.changed = false; runtime.slots = []; runtime.effects = []; runtime.loadedDocuments = [];
  const draft = { version: 1, inputPath: "/synthetic/recovered-a.pdf", revision: "a".repeat(64), savedAt: Date.now(), settings: {
    preset: "Офисный скан", pageOrder: [0, 1], pageRotations: {}, outputPageMode: "all", outputPageRange: "", outputBlocks: [],
    facsimile: null, savedFacsimiles: [{ id: "draft-stamp", imagePath: "/synthetic/draft-stamp.png", fileName: "draft-stamp.png", imageAspect: 2,
      x: .5, y: .5, width: .2, rotation: 0, opacity: 1, removeLightBackground: true, pageGeometries: {}, applyTo: "current", pageRange: "" }],
    editingFacsimileId: "", activeFacsimilePage: null, redactions: [], annotations: [], dpi: 200, quality: 84,
    compressionMode: "balanced", ocrEnabled: false, ocrLanguages: "rus+eng", pdfaEnabled: false,
  } };
  vi.stubGlobal("sessionStorage", { getItem: () => JSON.stringify(draft), removeItem: vi.fn() });
  render(); await flush();
}

describe("facsimile asynchronous asset ownership", () => {
  it("rechecks the draft revision after initial opening before restoring its edits", async () => {
    await recoveryScreen();
    let checks = 0;
    runtime.invoke.mockImplementation(async (command: string) => {
      if (command === "scanner_source_revision") return (++checks === 1 ? "a" : "b").repeat(64);
      if (command === "read_binary_file") return "data:image/png;base64,draft-stamp";
      if (command === "scanner_cancel" || command === "delete_runtime_file") return;
      throw new Error(`Unexpected test invocation: ${command}`);
    });
    button("Восстановить черновик").props.onClick!(); await flush();
    expect(checks).toBe(2);
    expect(runtime.loadedDocuments).toEqual(["/synthetic/recovered-a.pdf"]);
    expect(text()).toContain("Настройки не применены");
    expect(text()).not.toContain("Черновик восстановлен");
    expect(text()).not.toContain("draft-stamp.png");
    expect(button("Восстановить черновик")).toBeDefined();
  });

  it("restores a draft only after both pre-open and post-open revision checks pass", async () => {
    await recoveryScreen();
    runtime.invoke.mockImplementation(async (command: string) => {
      if (command === "scanner_source_revision") return "a".repeat(64);
      if (command === "read_binary_file") return "data:image/png;base64,draft-stamp";
      if (command === "scanner_cancel" || command === "delete_runtime_file") return;
      throw new Error(`Unexpected test invocation: ${command}`);
    });
    button("Восстановить черновик").props.onClick!(); await flush();
    expect(runtime.invoke.mock.calls.filter(([command]) => command === "scanner_source_revision")).toHaveLength(2);
    expect(text()).toContain("Черновик восстановлен");
    expect(text()).toContain("draft-stamp.png");
  });

  it("keeps toolbar minus disabled below its manual minimum rather than increasing a tiny fit scale", async () => {
    runtime.viewportZoom = .001; render(); await flush();
    expect(button("−").props.disabled).toBe(true); expect(button("+").props.disabled).toBe(false);
    button("+").props.onClick!(); expect(runtime.setZoom).toHaveBeenCalledWith(.251);
  });
  it("offers explicit fit-page and compact help in ordinary and fullscreen document workspaces", async () => {
    expect(button("Страница целиком").props.disabled).toBe(false);
    button("Страница целиком").props.onClick!(); expect(runtime.fitPage).toHaveBeenCalledOnce();
    expect(nodes().some((node) => node.type === "div" && node.props.className === "scanner-canvas-controls")).toBe(true);
    const help = nodes().find((node) => node.type === "details" && node.props.className === "scanner-preview-help")!;
    expect(help).toBeDefined(); expect(text(help)).toContain("Размытие и качество сжатия проверяйте");
    button("На весь экран").props.onClick!(); await flush();
    button("Страница целиком").props.onClick!(); expect(runtime.fitPage).toHaveBeenCalledTimes(2);
    expect(button("Закрыть полный экран")).toBeDefined();
  });
  it("does not attach a delayed image read from document A to replacement B", async () => {
    const image = deferred<string>(); runtime.invoke.mockReturnValueOnce(image.promise);
    button("Добавить факсимиле").props.onClick!(); await flush();
    await openDocument("/synthetic/b.pdf");
    image.resolve("data:image/png;base64,old-stamp"); await flush();
    expect(text()).toContain("b.pdf"); expect(text()).not.toContain("stamp.png");
    expect(runtime.dimensions).not.toHaveBeenCalled();
    expect(nodes().some((node) => node.type === "img" && node.props.alt === "Факсимиле")).toBe(false);
    expect(button("Добавить факсимиле")).toBeDefined();
  });

  it("discards image dimensions resolved after the source generation changed", async () => {
    const dimensions = deferred<[number, number]>(); runtime.dimensions.mockReturnValueOnce(dimensions.promise);
    button("Добавить факсимиле").props.onClick!(); await flush();
    expect(runtime.dimensions).toHaveBeenCalledOnce();
    await openDocument("/synthetic/b.pdf");
    dimensions.resolve([600, 300]); await flush();
    expect(text()).not.toContain("stamp.png"); expect(button("Добавить факсимиле")).toBeDefined();
  });

  it("admits only one immediate image chooser and allows a fresh attempt after cancellation", async () => {
    const chosen = deferred<string | null>(); runtime.chooseOpen.mockReturnValueOnce(chosen.promise);
    const choose = button("Добавить факсимиле").props.onClick!;
    choose(); choose(); await flush();
    expect(runtime.chooseOpen.mock.calls.filter(([label]) => label === "Выберите факсимиле")).toHaveLength(1);
    chosen.resolve(null); await flush();
    button("Добавить факсимиле").props.onClick!(); await flush();
    expect(runtime.chooseOpen.mock.calls.filter(([label]) => label === "Выберите факсимиле")).toHaveLength(2);
    expect(text()).toContain("stamp.png"); expect(text()).not.toContain("Работаем с факсимиле…");
  });

  it("does not display a late old-document error over a new document", async () => {
    const image = deferred<string>(); runtime.invoke.mockReturnValueOnce(image.promise);
    button("Добавить факсимиле").props.onClick!(); await flush();
    await openDocument("/synthetic/b.pdf"); image.reject(new Error("old image read failed")); await flush();
    expect(text()).not.toContain("old image read failed"); expect(button("Добавить факсимиле")).toBeDefined();
  });

  it("does not read an image selected after replacement or after unmount", async () => {
    const chosen = deferred<string | null>(); runtime.chooseOpen.mockReturnValueOnce(chosen.promise);
    button("Добавить факсимиле").props.onClick!(); await flush();
    await openDocument("/synthetic/b.pdf");
    for (const slot of runtime.slots) slot.cleanup?.();
    chosen.resolve("/synthetic/old-stamp.png"); await flush();
    expect(runtime.invoke.mock.calls.some(([command]) => command === "read_binary_file")).toBe(false);
    expect(runtime.dimensions).not.toHaveBeenCalled();
  });

  it("does not reopen a recovery draft after another document replaces its pending image read", async () => {
    await recoveryScreen();
    const image = deferred<string>();
    runtime.invoke.mockImplementation((command: string) => {
      if (command === "scanner_source_revision") return Promise.resolve("a".repeat(64));
      if (command === "read_binary_file") return image.promise;
      return Promise.resolve();
    });
    button("Восстановить черновик").props.onClick!(); await flush();
    expect(text()).toContain("Восстанавливаем черновик…");
    await openDocument("/synthetic/b.pdf", true);
    image.resolve("data:image/png;base64,old-draft-stamp"); await flush();
    expect(runtime.loadedDocuments).toEqual(["/synthetic/b.pdf"]);
    expect(text()).toContain("b.pdf"); expect(text()).not.toContain("draft-stamp.png");
  });

  it("retains one recovery operation and respects deleting its draft before the image returns", async () => {
    await recoveryScreen();
    const image = deferred<string>();
    runtime.invoke.mockImplementation((command: string) => {
      if (command === "scanner_source_revision") return Promise.resolve("a".repeat(64));
      if (command === "read_binary_file") return image.promise;
      return Promise.resolve();
    });
    const recover = button("Восстановить черновик").props.onClick!;
    recover(); recover(); await flush();
    expect(runtime.invoke.mock.calls.filter(([command]) => command === "scanner_source_revision")).toHaveLength(1);
    button("Удалить черновик").props.onClick!(); await flush();
    image.resolve("data:image/png;base64,old-draft-stamp"); await flush();
    expect(runtime.loadedDocuments).toEqual([]);
    expect(button("Выбрать файл")).toBeDefined(); expect(text()).not.toContain("draft-stamp.png");
  });

  it("does not undo hidden document edits from the merge workspace keyboard shortcut", async () => {
    button("КонтрастныйВыраженный текст").props.onClick!(); await flush();
    expect(button("КонтрастныйВыраженный текст").props.className).toBe("selected");
    button("Объединение файлов").props.onClick!(); await flush();
    const before = runtime.loadedDocuments.length;
    const event = { metaKey: true, ctrlKey: false, shiftKey: false, key: "z", target: null, preventDefault: vi.fn() };
    (tree as ReactElement<{ onKeyDown: (event: unknown) => void }>).props.onKeyDown(event); await flush();
    expect(event.preventDefault).not.toHaveBeenCalled(); expect(runtime.loadedDocuments).toHaveLength(before);
    button("Обработка документа").props.onClick!(); await flush();
    expect(button("КонтрастныйВыраженный текст").props.className).toBe("selected");
    (tree as ReactElement<{ onKeyDown: (event: unknown) => void }>).props.onKeyDown(event); await flush();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(button("Офисный сканЕстественный офисный вид").props.className).toBe("selected");
  });
});
