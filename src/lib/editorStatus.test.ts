import { describe, expect, it } from "vitest";
import { editorStatus, editorStatusUnavailable, unavailableWorkspaceInfo } from "./editorStatus";
import type { WorkspaceInfo } from "./storage";

const owner: NonNullable<WorkspaceInfo["editorOwner"]> = {
  displayName: "Иван Петров · OFFICE-PC-02",
  userName: "Иван Петров",
  deviceName: "OFFICE-PC-02",
  startedAt: "2026-09-09T10:00:00Z",
};

const workspace = (patch: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  root: "/shared/ProductData",
  portable: false,
  configured: true,
  writable: true,
  editor: false,
  editorBusy: false,
  accessControlled: true,
  accessMessage: "Режим просмотра",
  schemaVersion: 1,
  freeSpaceBytes: 1024,
  ...patch,
});

describe("shared-folder editor status", () => {
  it("shows the occupied editor identity and computer without allowing acquisition", () => {
    expect(editorStatus(workspace({ editorBusy: true, editorOwner: owner }))).toEqual({
      unknown: false,
      occupied: true,
      canAcquire: false,
      text: owner.displayName,
      device: "OFFICE-PC-02",
    });
  });

  it("keeps a known lock occupied when its owner metadata is unavailable", () => {
    const status = editorStatus(workspace({ editorBusy: true }));
    expect(status).toMatchObject({ unknown: false, occupied: true, canAcquire: false, device: "" });
    expect(status.text).toBe("Имя редактора недоступно");
    expect(status.text).not.toBe("Редактор свободен");
  });

  it("does not offer acquisition before the workspace has loaded", () => {
    expect(editorStatus(null)).toMatchObject({ unknown: true, canAcquire: false });
    expect(editorStatus(null).text).toBe("Проверяем, кто редактирует базу…");
  });

  it.each([undefined, null, "false", 0])("fails closed for invalid or missing editorBusy: %s", (editorBusy) => {
    // Older clients and failed IPC decoding can omit the independent lock state.
    const snapshot = { ...workspace(), editorBusy } as unknown as WorkspaceInfo;
    expect(editorStatus(snapshot)).toMatchObject({ unknown: true, canAcquire: false });
    expect(editorStatus(snapshot).text).not.toBe("Редактор свободен");
  });

  it("treats a reported read error as unknown even when busy is false", () => {
    expect(editorStatus(workspace({ editorStateMessage: "Не удалось прочитать состояние блокировки" }))).toMatchObject({
      unknown: true,
      canAcquire: false,
      text: "Не удалось прочитать состояние блокировки",
    });
  });

  it("offers acquisition only for a known free writable workspace", () => {
    expect(editorStatus(workspace())).toMatchObject({
      unknown: false,
      occupied: false,
      canAcquire: true,
      text: "Редактор свободен",
    });
    expect(editorStatus(workspace({ writable: false }))).toMatchObject({
      unknown: false,
      occupied: false,
      canAcquire: false,
      text: "Редактор свободен",
    });
  });

  it("does not reacquire while this client is already the editor", () => {
    expect(editorStatus(workspace({ editor: true, editorBusy: true, editorOwner: owner }))).toMatchObject({
      occupied: true,
      canAcquire: false,
    });
    expect(editorStatus(workspace({ editor: true, editorBusy: false }))).toMatchObject({
      occupied: true,
      canAcquire: false,
    });
  });

  it("fails closed for contradictory free state with a current owner", () => {
    expect(editorStatus(workspace({ editorBusy: false, editorOwner: owner }))).toMatchObject({
      occupied: true,
      canAcquire: false,
      text: owner.displayName,
    });
  });

  it("falls back to user name while keeping the computer separately identifiable", () => {
    expect(editorStatus(workspace({ editorBusy: true, editorOwner: { ...owner, displayName: "" } }))).toMatchObject({
      text: "Иван Петров",
      device: "OFFICE-PC-02",
      canAcquire: false,
    });
  });

  it("accepts an empty optional status message as a successful check", () => {
    for (const editorStateMessage of [undefined, null, ""]) {
      expect(editorStatus(workspace({ editorStateMessage }))).toMatchObject({ unknown: false, canAcquire: true });
    }
  });
});

describe("unavailable workspace snapshot", () => {
  it("clears stale rights and identity without mutating the last known snapshot", () => {
    const previous = workspace({ editor: true, editorBusy: true, editorOwner: owner, ownerConfigured: true });
    const unavailable = unavailableWorkspaceInfo(previous);

    expect(unavailable).not.toBe(previous);
    expect(unavailable).toMatchObject({
      root: previous.root,
      ownerConfigured: true,
      accessControlled: true,
      editor: false,
      editorBusy: true,
      editorOwner: undefined,
      editorStateMessage: editorStatusUnavailable,
      accessMessage: editorStatusUnavailable,
    });
    expect(editorStatus(unavailable)).toMatchObject({ unknown: true, occupied: true, canAcquire: false });
    expect(previous.editor).toBe(true);
    expect(previous.editorOwner).toBe(owner);
    expect(previous.accessMessage).toBe("Режим просмотра");
  });
});
