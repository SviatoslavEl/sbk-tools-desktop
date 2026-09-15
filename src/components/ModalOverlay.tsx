import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ReadOnlyWorkspaceBoundary, useWorkspaceBoundaryPolicy } from "../lib/workspaceAccess";
import { registerModalOverlay, type ModalRegistration } from "./modalStack";

interface WorkspaceMarkers {
  mutation: boolean;
  viewerAllowed: boolean;
  componentManaged: boolean;
}

/** DOM annotations outside a portal still govern the controls inside it. */
export function readModalWorkspaceMarkers(origin: Pick<HTMLElement, "closest">): WorkspaceMarkers {
  return {
    mutation: Boolean(origin.closest("[data-workspace-mutation]")),
    viewerAllowed: Boolean(origin.closest("[data-workspace-viewer-allowed]")),
    componentManaged: Boolean(origin.closest('[data-workspace-managed-disabled="true"]')),
  };
}

function OverlaySurface({ className, onClose, children }: { className: string; onClose: () => void; children: ReactNode }) {
  const element = useRef<HTMLDivElement>(null);
  const registration = useRef<ModalRegistration | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    if (!element.current) return;
    registration.current = registerModalOverlay(element.current, () => close.current());
    return () => { registration.current?.dispose(); registration.current = null; };
  }, []);
  return <div ref={element} className={className} role="presentation" onMouseDown={(event) => {
    if (event.currentTarget === event.target) registration.current?.requestClose();
  }}>{children}</div>;
}

/** Shared body portal prevents a nested editor being trapped below its parent dialog. */
export function ModalOverlay({ className, onClose, children }: { className: string; onClose: () => void; children: ReactNode }) {
  const origin = useRef<HTMLSpanElement>(null);
  const inherited = useWorkspaceBoundaryPolicy();
  const [markers, setMarkers] = useState<WorkspaceMarkers | null>(null);
  useLayoutEffect(() => {
    if (!origin.current) return;
    const next = readModalWorkspaceMarkers(origin.current);
    setMarkers((previous) => previous && previous.mutation === next.mutation
      && previous.viewerAllowed === next.viewerAllowed && previous.componentManaged === next.componentManaged ? previous : next);
  });
  const surface = <OverlaySurface className={className} onClose={onClose}>{children}</OverlaySurface>;
  // Node-only rendering is used for semantic/accessible-markup tests, not hydration.
  if (typeof document === "undefined") return surface;
  return <>
    <span ref={origin} hidden aria-hidden="true" data-modal-origin />
    {markers && createPortal(
      <ReadOnlyWorkspaceBoundary {...inherited}>
        <div
          data-workspace-mutation={markers.mutation || undefined}
          data-workspace-viewer-allowed={markers.viewerAllowed || undefined}
          data-workspace-managed-disabled={markers.componentManaged ? "true" : undefined}
        >{surface}</div>
      </ReadOnlyWorkspaceBoundary>,
      document.body,
    )}
  </>;
}
