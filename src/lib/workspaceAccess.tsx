import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
} from "react";

interface WorkspaceAccessValue {
  editor: boolean;
  message: string;
}
const WorkspaceAccessContext = createContext<WorkspaceAccessValue>({
  editor: true,
  message: "",
});

export function WorkspaceAccessProvider({
  editor,
  message,
  children,
}: WorkspaceAccessValue & { children: ReactNode }) {
  return (
    <WorkspaceAccessContext.Provider value={{ editor, message }}>
      {children}
    </WorkspaceAccessContext.Provider>
  );
}

export function useWorkspaceAccess(): WorkspaceAccessValue {
  return useContext(WorkspaceAccessContext);
}

export function workspaceControlIsBlocked(
  editor: boolean,
  allowMutations: boolean,
  explicitMutation: boolean,
  disableFormControls: boolean,
  viewerAllowed: boolean,
): boolean {
  return (
    !editor &&
    !allowMutations &&
    !viewerAllowed &&
    (explicitMutation || disableFormControls)
  );
}

export function ReadOnlyWorkspaceBoundary({
  children,
  allowMutations = false,
  disableFormControls = false,
}: {
  children: ReactNode;
  allowMutations?: boolean;
  disableFormControls?: boolean;
}) {
  const access = useWorkspaceAccess();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    const update = () =>
      container
        .querySelectorAll<
          | HTMLInputElement
          | HTMLSelectElement
          | HTMLTextAreaElement
          | HTMLButtonElement
        >("button, input, select, textarea")
        .forEach((control) => {
          const explicitMutation = Boolean(
            control.closest("[data-workspace-mutation]"),
          );
          const viewerAllowed = Boolean(
            control.closest("[data-workspace-viewer-allowed]"),
          );
          const formControl =
            control instanceof HTMLInputElement ||
            control instanceof HTMLSelectElement ||
            control instanceof HTMLTextAreaElement;
          const blocked = workspaceControlIsBlocked(
            access.editor,
            allowMutations,
            explicitMutation,
            disableFormControls && formControl,
            viewerAllowed,
          );
          if (blocked && control.dataset.workspaceDisabled !== "true") {
            control.dataset.workspaceWasDisabled = String(control.disabled);
            control.dataset.workspaceDisabled = "true";
            control.disabled = true;
            control.setAttribute("aria-disabled", "true");
            control.title =
              access.message || "Общая база открыта только для просмотра";
          } else if (!blocked && control.dataset.workspaceDisabled === "true") {
            control.disabled = control.dataset.workspaceWasDisabled === "true";
            control.removeAttribute("aria-disabled");
            delete control.dataset.workspaceDisabled;
            delete control.dataset.workspaceWasDisabled;
          }
        });
    update();
    const observer = new MutationObserver(update);
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [
    access.editor,
    access.message,
    allowMutations,
    disableFormControls,
    children,
  ]);
  return (
    <div
      ref={root}
      data-workspace-access={
        access.editor || allowMutations ? "editor" : "viewer"
      }
    >
      {children}
    </div>
  );
}
