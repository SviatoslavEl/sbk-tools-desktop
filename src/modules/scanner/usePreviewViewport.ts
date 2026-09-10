import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { clampPreviewZoom, previewPointAtViewport, previewScrollForAnchor, previewViewportLayout, previewWheelAction, wheelPreviewZoom, type PreviewAnchor, type PreviewPoint } from "./previewViewport";

export function usePreviewViewport({ active, documentKey, aspect, drawing, isEditingPage }: { active: boolean; documentKey: string; aspect: number; drawing: boolean; isEditingPage: () => boolean }) {
  const stageElement = useRef<HTMLDivElement | null>(null);
  const pageElement = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 610 });
  const [zoom, setZoomState] = useState(1);
  const zoomRef = useRef(1);
  const center = useRef<PreviewPoint>({ x: .5, y: .5 });
  const pendingAnchor = useRef<PreviewAnchor | null>(null);
  const previousDocument = useRef(documentKey);
  const pan = useRef<{ id: number; x: number; y: number; scrollX: number; scrollY: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const editingPage = useRef(isEditingPage);
  editingPage.current = isEditingPage;
  const layout = useMemo(() => previewViewportLayout(size, zoom, aspect), [size, zoom, aspect]);

  const rememberCenter = () => {
    const stage = stageElement.current;
    if (!stage?.clientWidth || !stage.clientHeight) return;
    center.current = previewPointAtViewport(layout, { x: stage.scrollLeft, y: stage.scrollTop }, { x: stage.clientWidth / 2, y: stage.clientHeight / 2 });
  };

  const setZoom = (value: number) => {
    const next = clampPreviewZoom(value);
    if (next === zoomRef.current) return;
    zoomRef.current = next;
    setZoomState(next);
  };

  const resetView = () => {
    center.current = { x: .5, y: .5 };
    pendingAnchor.current = null;
    setZoom(1);
    const stage = stageElement.current;
    if (stage && zoomRef.current === zoom) {
      const scroll = previewScrollForAnchor(layout, { page: center.current, viewport: { x: stage.clientWidth / 2, y: stage.clientHeight / 2 } });
      stage.scrollLeft = scroll.x;
      stage.scrollTop = scroll.y;
    }
  };

  useLayoutEffect(() => {
    if (previousDocument.current !== documentKey) {
      previousDocument.current = documentKey;
      center.current = { x: .5, y: .5 };
      pendingAnchor.current = null;
      zoomRef.current = 1;
      setZoomState(1);
    }
    const stage = stageElement.current;
    if (!stage || !active) { pan.current = null; setPanning(false); return; }
    const measure = () => {
      if (!stage.clientWidth || !stage.clientHeight) return;
      setSize((current) => current.width === stage.clientWidth && current.height === stage.clientHeight ? current : { width: stage.clientWidth, height: stage.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    const wheel = (event: WheelEvent) => {
      const action = previewWheelAction({ deltaY: event.deltaY, shiftKey: event.shiftKey, panning: !!pan.current, editing: editingPage.current() });
      if (action === "block") { event.preventDefault(); return; }
      if (action === "scroll") return;
      const page = pageElement.current;
      if (!page) return;
      event.preventDefault();
      const next = wheelPreviewZoom(zoomRef.current, event.deltaY, event.deltaMode);
      if (next === zoomRef.current) return;
      const pageBounds = page.getBoundingClientRect();
      const stageBounds = stage.getBoundingClientRect();
      pendingAnchor.current = {
        page: { x: (event.clientX - pageBounds.left) / pageBounds.width, y: (event.clientY - pageBounds.top) / pageBounds.height },
        viewport: { x: event.clientX - stageBounds.left - stage.clientLeft, y: event.clientY - stageBounds.top - stage.clientTop },
      };
      // Keep accumulating rapid wheel events even when React batches a frame.
      zoomRef.current = next;
      setZoomState(next);
    };
    stage.addEventListener("wheel", wheel, { passive: false });
    return () => { observer.disconnect(); stage.removeEventListener("wheel", wheel); };
  }, [active, documentKey]);

  useLayoutEffect(() => {
    const stage = stageElement.current;
    if (!active || !stage?.clientWidth || !stage.clientHeight) return;
    const anchor = pendingAnchor.current ?? { page: center.current, viewport: { x: stage.clientWidth / 2, y: stage.clientHeight / 2 } };
    const scroll = previewScrollForAnchor(layout, anchor);
    // Apply after layout, before paint. No rAF race with the old page geometry.
    stage.scrollLeft = scroll.x;
    stage.scrollTop = scroll.y;
    pendingAnchor.current = null;
    center.current = previewPointAtViewport(layout, { x: stage.scrollLeft, y: stage.scrollTop }, { x: stage.clientWidth / 2, y: stage.clientHeight / 2 });
  }, [active, documentKey, layout]);

  const startPan = (event: PointerEvent<HTMLDivElement>) => {
    const stage = stageElement.current;
    const target = event.target as Element;
    const background = target === stage || target.classList.contains("document-canvas");
    const plainPage = pageElement.current?.contains(target) && !target.closest(".editable-geometry, .facsimile, button, [role='button']");
    if (!stage || (event.button !== 1 && !(event.button === 0 && (background || (!drawing && plainPage))))) return;
    event.preventDefault(); event.stopPropagation();
    stage.focus({ preventScroll: true });
    stage.setPointerCapture(event.pointerId);
    pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, scrollX: stage.scrollLeft, scrollY: stage.scrollTop };
    setPanning(true);
  };
  const movePan = (event: PointerEvent<HTMLDivElement>) => {
    const current = pan.current;
    const stage = stageElement.current;
    if (!current || !stage || current.id !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    stage.scrollLeft = current.scrollX - (event.clientX - current.x);
    stage.scrollTop = current.scrollY - (event.clientY - current.y);
    rememberCenter();
  };
  const stopPan = (event: PointerEvent<HTMLDivElement>) => {
    if (pan.current?.id !== event.pointerId) return;
    event.stopPropagation();
    pan.current = null;
    setPanning(false);
    if (stageElement.current?.hasPointerCapture(event.pointerId)) stageElement.current.releasePointerCapture(event.pointerId);
    rememberCenter();
  };
  const panFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const step = event.shiftKey ? 120 : 40;
    const delta = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, number[]>)[event.key];
    if (!delta) return;
    event.preventDefault();
    event.currentTarget.scrollLeft += delta[0];
    event.currentTarget.scrollTop += delta[1];
    rememberCenter();
  };

  return { stageElement, pageElement, zoom, setZoom, resetView, layout, panning, rememberCenter, startPan, movePan, stopPan, panFromKeyboard };
}
