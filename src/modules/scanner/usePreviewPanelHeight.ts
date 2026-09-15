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
    };
    measure();
    const stopObserving = observePreviewPanelArea(content, measure);
    window.addEventListener("resize", measure);
    return () => { stopObserving(); window.removeEventListener("resize", measure); };
  }, [active, fullscreen]);
  return ref;
}
