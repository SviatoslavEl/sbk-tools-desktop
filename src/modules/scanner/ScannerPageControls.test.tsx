import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ScannerPageControls } from "./ScannerPageControls";
import { applyPreviewPanelHeight, availablePreviewPanelHeight, observePreviewPanelArea } from "./usePreviewPanelHeight";

describe("compact scanner page settings", () => {
  it("starts collapsed with the export mode in its accessible summary", () => {
    const html = renderToStaticMarkup(<ScannerPageControls summary="12 стр. · один PDF" error="" disabled={false}><button>Удалить страницу</button><select aria-label="Сохранение страниц"><option>Один PDF</option></select></ScannerPageControls>);
    expect(html).toContain('<details class="scanner-pages-panel">');
    expect(html).toMatch(/<summary>.*Страницы и сохранение.*12 стр. · один PDF.*<\/summary>/);
    expect(html).toContain("Удалить страницу");
    expect(html).toContain('aria-label="Сохранение страниц"');
    expect(html).not.toContain("disabled=");
  });

  it.each(["Выберите хотя бы одну страницу", "Блок 2: страница 15 вне диапазона"])('opens invalid settings and keeps "%s" outside their collapsible body', (error) => {
    const html = renderToStaticMarkup(<ScannerPageControls summary="Блоки страниц" error={error} disabled={false}><input aria-invalid="true" value="15" readOnly /></ScannerPageControls>);
    expect(html).toContain('<details class="scanner-pages-panel" open="">');
    const summary = html.slice(html.indexOf("<summary>"), html.indexOf("</summary>"));
    expect(summary).toContain(error);
    expect(summary).toContain('role="status"');
    expect(html).toContain('aria-invalid="true"');
  });

  it("preserves the disabled fieldset guard while the preview is unavailable", () => {
    const html = renderToStaticMarkup(<ScannerPageControls summary="3 стр. · выбранный диапазон" error="" disabled><button>Повернуть страницу</button><input aria-label="Страницы" /></ScannerPageControls>);
    expect(html).toMatch(/<fieldset disabled=""[^>]*><button>Повернуть страницу<\/button><input aria-label="Страницы"/);
  });
});

describe("scanner panel uses the available window height", () => {
  const normal = { viewportHeight: 768, contentTop: 78, contentBottom: 768, panelTop: 100, paddingTop: 22, paddingBottom: 28, stacked: false };

  it("fits the native 1215×768 workspace without pushing the footer below the window", () => {
    expect(availablePreviewPanelHeight(normal)).toBe(640);
  });

  it("accounts for notices above the scanner and an app area shorter than the screen", () => {
    expect(availablePreviewPanelHeight({ ...normal, panelTop: 154 })).toBe(586);
    expect(availablePreviewPanelHeight({ ...normal, contentBottom: 700 })).toBe(572);
  });

  it("keeps the full panel available below stacked settings in a narrow window", () => {
    expect(availablePreviewPanelHeight({ ...normal, stacked: true, panelTop: 1500 })).toBe(640);
  });

  it("does not grow beyond the work area when the settings column has scrolled", () => {
    expect(availablePreviewPanelHeight({ ...normal, panelTop: 78 })).toBe(640);
    expect(availablePreviewPanelHeight({ ...normal, viewportHeight: 400, contentBottom: 400 })).toBe(272);
  });

  it("observes notices added/resized later, stops observing removed children and disconnects on leave", () => {
    let resized = () => undefined as void;
    let changed = () => undefined as void;
    const resize = { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    const mutation = { observe: vi.fn(), disconnect: vi.fn() };
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resized = callback; return resize; } });
    vi.stubGlobal("MutationObserver", class { constructor(callback: () => void) { changed = callback; return mutation; } });
    try {
      const scanner = {} as Element;
      const notice = {} as Element;
      const content = { children: [scanner] } as unknown as HTMLElement;
      const measure = vi.fn();
      const stop = observePreviewPanelArea(content, measure);
      expect(resize.observe.mock.calls.map(([node]) => node)).toEqual([content, scanner]);
      expect(mutation.observe).toHaveBeenCalledWith(content, { childList: true });
      Object.assign(content, { children: [notice, scanner] });
      changed();
      expect(resize.observe).toHaveBeenLastCalledWith(notice);
      resized();
      expect(measure).toHaveBeenCalledTimes(2);
      Object.assign(content, { children: [scanner] });
      changed();
      expect(resize.unobserve).toHaveBeenCalledWith(notice);
      stop();
      expect(resize.disconnect).toHaveBeenCalledOnce();
      expect(mutation.disconnect).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it("does not write the same height again after its own resize notification", () => {
    let height = "";
    const setProperty = vi.fn((_name: string, value: string) => { height = value; });
    const panel = { style: { getPropertyValue: () => height, setProperty } } as unknown as HTMLElement;
    applyPreviewPanelHeight(panel, 640);
    applyPreviewPanelHeight(panel, 640);
    expect(setProperty).toHaveBeenCalledOnce();
    applyPreviewPanelHeight(panel, 586);
    expect(setProperty).toHaveBeenCalledTimes(2);
    expect(setProperty).toHaveBeenLastCalledWith("--scanner-panel-height", "586px");
  });
});
