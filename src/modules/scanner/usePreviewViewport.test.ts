import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviewViewport } from "./usePreviewViewport";
import { MIN_PREVIEW_ZOOM } from "./previewViewport";
import { scannerPreviewSpaceBudget } from "./usePreviewPanelHeight";

const runtime = vi.hoisted(() => ({ cursor: 0, changed: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>, effects: [] as Array<() => void>, resize: [] as Array<() => void>,
}));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = runtime.cursor++; if (!runtime.slots[i]) runtime.slots[i] = { value: typeof initial === "function" ? initial() : initial }; return [runtime.slots[i].value, (update: unknown) => { const value = typeof update === "function" ? update(runtime.slots[i].value) : update; if (!Object.is(value, runtime.slots[i].value)) { runtime.slots[i].value = value; runtime.changed = true; } }]; },
  useRef: (initial: unknown) => { const i = runtime.cursor++; if (!runtime.slots[i]) runtime.slots[i] = { value: { current: initial } }; return runtime.slots[i].value; },
  useMemo: (factory: () => unknown) => factory(),
  useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const i = runtime.cursor++, old = runtime.slots[i]; if (old?.deps && deps && old.deps.length === deps.length && deps.every((value, index) => Object.is(value, old.deps![index]))) return; runtime.slots[i] = { ...old, deps }; runtime.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); runtime.slots[i].cleanup = typeof cleanup === "function" ? cleanup : undefined; }); },
}));

let view: ReturnType<typeof usePreviewViewport>;
let stage: { clientWidth: number; clientHeight: number; clientLeft: number; clientTop: number; scrollLeft: number; scrollTop: number; getBoundingClientRect: () => { left: number; top: number }; addEventListener: (kind: string, handler: unknown) => void; removeEventListener: (kind: string) => void };
let handlers: Map<string, (event: unknown) => void>;
let aspect = .707;
function render() {
  runtime.cursor = 0; runtime.changed = false;
  view = usePreviewViewport({ active: true, documentKey: "qa-document", aspect, drawing: false, isEditingPage: () => false });
  view.stageElement.current = stage as unknown as HTMLDivElement;
  view.pageElement.current = { getBoundingClientRect: () => ({ left: view.layout.pageLeft - stage.scrollLeft, top: view.layout.pageTop - stage.scrollTop, width: view.layout.pageWidth, height: view.layout.pageHeight }) } as HTMLDivElement;
  for (const effect of runtime.effects.splice(0)) effect();
}
function flush() { for (let i = 0; i < 8 && runtime.changed; i++) render(); }
function expectFitted() {
  expect(view.layout.pageWidth).toBeLessThanOrEqual(stage.clientWidth - 32 + 1e-8);
  expect(view.layout.pageHeight).toBeLessThanOrEqual(stage.clientHeight - 32 + 1e-8);
  expect(view.layout.pageLeft - stage.scrollLeft).toBeCloseTo((stage.clientWidth - view.layout.pageWidth) / 2);
  expect(view.layout.pageTop - stage.scrollTop).toBeCloseTo((stage.clientHeight - view.layout.pageHeight) / 2);
}
beforeEach(() => {
  runtime.cursor = 0; runtime.changed = false; runtime.slots = []; runtime.effects = []; runtime.resize = []; aspect = .707; handlers = new Map();
  stage = { clientWidth: 740, clientHeight: 300, clientLeft: 0, clientTop: 0, scrollLeft: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener: (kind, handler) => handlers.set(kind, handler as (event: unknown) => void), removeEventListener: (kind) => { handlers.delete(kind); },
  };
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { runtime.resize.push(callback); } observe() {} disconnect() {} });
  render(); flush();
});
afterEach(() => { runtime.slots.forEach((slot) => slot.cleanup?.()); vi.unstubAllGlobals(); });

describe("fit-page viewport interaction", () => {
  it("retains all four page corners through Save with an 800px OCR-result summary, expanded tools, resize and consumed return", () => {
    view.fitPage(); flush();
    for (const [panelHeight, summaryNatural] of [[697, 800], [400, 800], [697, 120], [1100, 800]]) {
      const headerNatural = 94;
      const budget = scannerPreviewSpaceBudget(panelHeight, headerNatural)!;
      stage.clientHeight = panelHeight - Math.min(headerNatural, budget.headerMax)
        - Math.min(120, budget.requestMax) - Math.min(700, budget.toolsMax) - Math.min(summaryNatural, budget.summaryMax);
      runtime.resize.forEach((callback) => callback()); flush();
      expect(stage.clientHeight).toBeGreaterThan(0); expectFitted();
    }
  });
  it("remeasures the available canvas when Fit is requested before a result/footer ResizeObserver delivery", () => {
    view.fitPage(); flush(); expectFitted();
    const beforeSave = view.zoom;
    // OCR Save adds the ready/return panels in the same window. The user may
    // click Fit before the browser delivers the stage's resize notification.
    stage.clientHeight = 150;
    view.fitPage(); flush();
    expect(view.fittingPage).toBe(true); expect(view.zoom).toBeLessThan(beforeSave); expectFitted();
  });

  it("keeps the full page visible as OCR return/footer content grows and is consumed", () => {
    view.fitPage(); flush();
    for (const height of [190, 130, 85, 210, 300]) {
      stage.clientHeight = height;
      runtime.resize.forEach((callback) => callback()); flush();
      expect(view.fittingPage).toBe(true); expectFitted();
      expect(view.layout.pageTop - stage.scrollTop + view.layout.pageHeight).toBeLessThanOrEqual(height - 16 + 1e-8);
    }
  });

  it("fits a long receipt below the manual minimum, retains fit for wheel-out/zero/resize, and exits on zoom-in with the cursor anchored", () => {
    aspect = .01; render(); flush(); view.fitPage(); flush();
    expect(view.zoom).toBeLessThan(MIN_PREVIEW_ZOOM); expectFitted();
    const before = view.zoom, preventDefault = vi.fn();
    handlers.get("wheel")!({ deltaY: 100, deltaMode: 0, shiftKey: false, clientX: 370, clientY: 150, preventDefault }); flush();
    expect(view.zoom).toBe(before); expect(view.fittingPage).toBe(true);
    handlers.get("wheel")!({ deltaY: 0, deltaMode: 0, shiftKey: false, clientX: 370, clientY: 150, preventDefault }); flush();
    expect(view.zoom).toBe(before); expect(view.fittingPage).toBe(true);
    stage.clientWidth = 1100; stage.clientHeight = 600; runtime.resize.forEach((callback) => callback()); flush(); expectFitted();
    const point = { x: .7, y: .3 }, cursor = { x: view.layout.pageLeft + view.layout.pageWidth * point.x - stage.scrollLeft, y: view.layout.pageTop + view.layout.pageHeight * point.y - stage.scrollTop };
    handlers.get("wheel")!({ deltaY: -100, deltaMode: 0, shiftKey: false, clientX: cursor.x, clientY: cursor.y, preventDefault }); flush();
    expect(view.fittingPage).toBe(false); expect(view.zoom).toBe(MIN_PREVIEW_ZOOM);
    expect(view.layout.pageLeft + view.layout.pageWidth * point.x - stage.scrollLeft).toBeCloseTo(cursor.x);
    expect(view.layout.pageTop + view.layout.pageHeight * point.y - stage.scrollTop).toBeCloseTo(cursor.y);
    view.fitPage(); flush(); const fitted = view.zoom;
    view.setZoom(fitted + .25); flush(); expect(view.fittingPage).toBe(false); expect(view.zoom).toBeCloseTo(fitted + .25);
  });
  it("recenters a panned page, fits both axes, and retains fit after canvas resize and page orientation change", () => {
    stage.scrollLeft = 1100; stage.scrollTop = 1200; view.rememberCenter();
    view.fitPage(); flush(); expect(view.fittingPage).toBe(true); expectFitted();
    stage.clientWidth = 1100; stage.clientHeight = 700; runtime.resize.forEach((callback) => callback()); flush(); expectFitted();
    aspect = 1.414; render(); flush(); expectFitted();
    stage.scrollLeft += 100; stage.scrollTop += 30; view.rememberCenter(); view.fitPage(); flush(); expectFitted();
  });

  it("returns to ordinary zoom for toolbar/reset and cursor-anchored wheel changes", () => {
    view.fitPage(); flush(); const fittedZoom = view.zoom;
    view.setZoom(fittedZoom + .25); flush(); expect(view.fittingPage).toBe(false); expect(view.zoom).toBeCloseTo(fittedZoom + .25);
    view.fitPage(); flush();
    const pagePoint = { x: .73, y: .3 }, cursor = { x: view.layout.pageLeft + view.layout.pageWidth * pagePoint.x - stage.scrollLeft, y: view.layout.pageTop + view.layout.pageHeight * pagePoint.y - stage.scrollTop };
    const preventDefault = vi.fn();
    handlers.get("wheel")!({ deltaY: -100, deltaMode: 0, shiftKey: false, clientX: cursor.x, clientY: cursor.y, preventDefault }); flush();
    expect(preventDefault).toHaveBeenCalled(); expect(view.fittingPage).toBe(false); expect(view.zoom).toBeGreaterThan(fittedZoom);
    expect(view.layout.pageLeft + view.layout.pageWidth * pagePoint.x - stage.scrollLeft).toBeCloseTo(cursor.x);
    expect(view.layout.pageTop + view.layout.pageHeight * pagePoint.y - stage.scrollTop).toBeCloseTo(cursor.y);
    view.resetView(); flush(); expect(view.fittingPage).toBe(false); expect(view.zoom).toBe(1);
    view.fitPage(); flush(); const sameZoom = view.zoom;
    view.setZoom(sameZoom); flush(); expect(view.fittingPage).toBe(false); expect(view.zoom).toBe(sameZoom);
  });
});
