import type { WorkspaceInfo } from "./storage";

export const editorStatusUnavailable = "Не удалось проверить доступ к общей папке. До восстановления связи доступен только просмотр.";

export function unavailableWorkspaceInfo(workspace: WorkspaceInfo): WorkspaceInfo {
  return { ...workspace, editor: false, editorBusy: true, editorOwner: undefined, editorStateMessage: editorStatusUnavailable, accessMessage: editorStatusUnavailable };
}

export function editorStatus(workspace: Pick<WorkspaceInfo, "editor" | "editorBusy" | "editorOwner" | "editorStateMessage" | "writable"> | null) {
  const unknown = !workspace || typeof workspace.editorBusy !== "boolean" || Boolean(workspace.editorStateMessage);
  const occupied = Boolean(workspace?.editorBusy || workspace?.editorOwner || workspace?.editor);
  const owner = workspace?.editorOwner;
  const name = owner?.displayName || owner?.userName || "Имя редактора недоступно";
  return {
    unknown,
    occupied,
    canAcquire: Boolean(workspace?.writable && !unknown && !occupied && !workspace.editor),
    text: unknown ? (workspace?.editorStateMessage || "Проверяем, кто редактирует базу…") : occupied ? name : "Редактор свободен",
    device: owner?.deviceName || "",
  };
}
