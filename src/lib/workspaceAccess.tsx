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

type WorkspaceControl = Pick<
  HTMLInputElement,
  "disabled" | "dataset" | "getAttribute" | "setAttribute" | "removeAttribute"
>;

export function applyWorkspaceControlAccess(
  control: WorkspaceControl,
  blocked: boolean,
  message: string,
): void {
  if (blocked) {
    if (control.dataset.workspaceDisabled !== "true") {
      const originalTitle = control.getAttribute("title");
      control.dataset.workspaceWasDisabled = String(control.disabled);
      control.dataset.workspaceHadTitle = String(originalTitle !== null);
      if (originalTitle !== null) control.dataset.workspaceOriginalTitle = originalTitle;
      control.dataset.workspaceDisabled = "true";
    }
    control.disabled = true;
    control.setAttribute("aria-disabled", "true");
    // The current editor can change while the control stays blocked.
    control.setAttribute("title", message || "Общая база открыта только для просмотра");
  } else if (control.dataset.workspaceDisabled === "true") {
    control.disabled = control.dataset.workspaceWasDisabled === "true";
    control.removeAttribute("aria-disabled");
    if (control.dataset.workspaceHadTitle === "true") {
      control.setAttribute("title", control.dataset.workspaceOriginalTitle || "");
    } else {
      control.removeAttribute("title");
    }
    delete control.dataset.workspaceDisabled;
    delete control.dataset.workspaceWasDisabled;
    delete control.dataset.workspaceHadTitle;
    delete control.dataset.workspaceOriginalTitle;
  }
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
          applyWorkspaceControlAccess(control, blocked, access.message);
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
