import { useLayoutEffect, useRef } from "react";

export function availablePreviewPanelHeight({ viewportHeight, contentTop, contentBottom, panelTop, paddingTop, paddingBottom, stacked }: {
  viewportHeight: number; contentTop: number; contentBottom: number; panelTop: number;
  paddingTop: number; paddingBottom: number; stacked: boolean;
}): number {
  // On narrow windows the settings column comes before the preview. Reserve a
  // full workspace-height panel there, rather than measuring it below the fold.
  const top = stacked ? contentTop + paddingTop : Math.max(contentTop + paddingTop, panelTop);
  return Math.max(240, Math.floor(Math.min(viewportHeight, contentBottom) - top - paddingBottom));
}

export function applyPreviewPanelHeight(panel: HTMLElement, height: number) {
  const value = `${height}px`;
  // A child resize can follow our own layout write. Do not write again when the
  // available area is unchanged, and never observe style/attribute mutations.
  if (panel.style.getPropertyValue("--scanner-panel-height") !== value) panel.style.setProperty("--scanner-panel-height", value);
}

/** Pixel budgets share one measured panel; no percentage-height flex cycle. */
export function scannerPreviewSpaceBudget(panelHeight: number, headerNaturalHeight: number) {
  if (!Number.isFinite(panelHeight) || panelHeight <= 0) return null;
  const headerMax = Math.floor(panelHeight * .2);
  const header = Math.min(Math.max(0, Number.isFinite(headerNaturalHeight) ? headerNaturalHeight : 0), headerMax);
  const remaining = Math.max(0, panelHeight - header);
  const requestMax = Math.floor(remaining * .1);
  const toolsMax = Math.floor(remaining * .25);
  const summaryMax = Math.floor(remaining * .4);
  return { headerMax, requestMax, toolsMax, summaryMax, canvasReserve: remaining - requestMax - toolsMax - summaryMax };
}

export function applyMeasuredPreviewSpace(panel: HTMLElement) {
  const header = panel.querySelector<HTMLElement>(":scope > .scanner-workspace-header");
  const budget = scannerPreviewSpaceBudget(panel.clientHeight, header?.scrollHeight || 0);
  if (!budget) return;
  for (const [name, height] of Object.entries({
    "--scanner-header-max-height": budget.headerMax,
    "--scanner-request-max-height": budget.requestMax,
    "--scanner-tools-max-height": budget.toolsMax,
    "--scanner-summary-max-height": budget.summaryMax,
  })) {
    const value = `${height}px`;
    if (panel.style.getPropertyValue(name) !== value) panel.style.setProperty(name, value);
  }
}

export function observeMeasuredPreviewSpace(panel: HTMLElement) {
  const measure = () => applyMeasuredPreviewSpace(panel);
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(panel);
  const header = panel.querySelector<HTMLElement>(":scope > .scanner-workspace-header");
  if (header) observer.observe(header);
  return () => observer.disconnect();
}

export function observePreviewPanelArea(content: HTMLElement, measure: () => void) {
  const observer = new ResizeObserver(measure);
  const observed = new Set<Element>();
  const syncChildren = () => {
    const current = new Set<Element>([content, ...content.children]);
    for (const child of observed) if (!current.has(child)) { observer.unobserve(child); observed.delete(child); }
    for (const child of current) if (!observed.has(child)) { observer.observe(child); observed.add(child); }
  };
  syncChildren();
  // A notice may appear later without changing the scroll container's own size.
  const childrenObserver = new MutationObserver(() => { syncChildren(); measure(); });
  childrenObserver.observe(content, { childList: true });
  return () => { observer.disconnect(); childrenObserver.disconnect(); };
}

export function usePreviewPanelHeight(active: boolean, fullscreen: boolean) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!active || !ref.current) return;
    return observeMeasuredPreviewSpace(ref.current);
  }, [active, fullscreen]);
  useLayoutEffect(() => {
    const panel = ref.current;
    const content = panel?.closest<HTMLElement>(".tool-content");
    if (!active || !panel || !content || fullscreen) return;
    const measure = () => {
      const bounds = content.getBoundingClientRect();
      const style = getComputedStyle(content);
      const height = availablePreviewPanelHeight({
        viewportHeight: window.innerHeight,
        contentTop: bounds.top, contentBottom: bounds.bottom,
        panelTop: panel.getBoundingClientRect().top,
        paddingTop: parseFloat(style.paddingTop) || 0,
        paddingBottom: parseFloat(style.paddingBottom) || 0,
        stacked: window.matchMedia("(max-width: 1000px)").matches,
      });
      applyPreviewPanelHeight(panel, height);
      applyMeasuredPreviewSpace(panel);
    };
    measure();
    const stopObserving = observePreviewPanelArea(content, measure);
    window.addEventListener("resize", measure);
    return () => { stopObserving(); window.removeEventListener("resize", measure); };
  }, [active, fullscreen]);
  return ref;
}
