import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceInfo } from "../../lib/storage";
import { WorkspaceAccessProvider } from "../../lib/workspaceAccess";
import { Settings } from "./Settings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../hooks/useRecords", () => ({
  useRecords: () => ({ records: [], loading: false, error: null, save: vi.fn() }),
}));
vi.mock("../../lib/sharedWorkspace", () => ({
  readAccessTimers: () => ({ refreshSeconds: 30, backupHours: 0, retentionCount: 10, retentionDays: 180 }),
  saveAccessTimers: vi.fn(),
}));

const workspace = (patch: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  root: "/shared/ProductData",
  portable: false,
  configured: true,
  writable: true,
  editor: false,
  editorBusy: false,
  accessControlled: true,
  accessMessage: "Режим просмотра",
  ownerConfigured: true,
  schemaVersion: 1,
  freeSpaceBytes: 1024,
  ...patch,
});

const owner: NonNullable<WorkspaceInfo["editorOwner"]> = {
  displayName: "Иван Петров · OFFICE-PC-02",
  userName: "Иван Петров",
  deviceName: "OFFICE-PC-02",
  startedAt: "2026-09-09T10:00:00Z",
};

function renderSettings(snapshot: WorkspaceInfo) {
  return renderToStaticMarkup(
    <WorkspaceAccessProvider editor={snapshot.editor} message={snapshot.accessMessage}>
      <Settings collapsed={false} onCollapsed={vi.fn()} workspace={snapshot} onWorkspaceChange={vi.fn()} />
    </WorkspaceAccessProvider>,
  );
}

function accessControls(html: string) {
  const match = html.match(/(<fieldset\b[^>]*class="[^"]*\bworkspace-password-controls\b[^"]*"[^>]*>)([\s\S]*?)<\/fieldset>/);
  if (!match) throw new Error("The rendered settings must contain the workspace access fieldset");
  return { attributes: match[1], content: match[2] };
}

function buttonAttributes(content: string, label: string) {
  const button = [...content.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)].find((match) => match[2] === label);
  if (!button) throw new Error(`Expected a rendered button labelled ${label}`);
  return button[1];
}

describe("settings workspace access rendered UI", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows another editor and computer while disabling the whole password fieldset", () => {
    const html = renderSettings(workspace({ editorBusy: true, editorOwner: owner }));
    expect(html).toContain(owner.displayName);
    expect(html).toContain(`Компьютер: ${owner.deviceName}`);
    expect(html).toContain("Права заняты:");
    expect(html).toContain("Ввод пароля не освобождает чужой сеанс");
    expect(accessControls(html).attributes).toContain('disabled=""');
    expect(html).not.toContain("Редактор свободен");
  });

  it("keeps password entry disabled when the lock is occupied but identity is missing", () => {
    const html = renderSettings(workspace({ editorBusy: true }));
    expect(html).toContain("Имя редактора недоступно");
    expect(accessControls(html).attributes).toContain('disabled=""');
    expect(html).not.toContain("Редактор свободен");
  });

  it("shows the read error instead of a free editor and blocks password entry", () => {
    const error = "Не удалось проверить доступ к общей папке";
    const html = renderSettings(workspace({ editorStateMessage: error }));
    expect(html).toContain(error);
    expect(accessControls(html).attributes).toContain('disabled=""');
    expect(html).not.toContain("Редактор свободен");
  });

  it("does not treat a missing independent lock state as free", () => {
    const snapshot = { ...workspace(), editorBusy: undefined } as unknown as WorkspaceInfo;
    const html = renderSettings(snapshot);
    expect(html).toContain("Проверяем, кто редактирует базу…");
    expect(accessControls(html).attributes).toContain('disabled=""');
    expect(html).not.toContain("Редактор свободен");
  });

  it("allows password input for a confirmed free protected folder, but not an empty-password login", () => {
    const html = renderSettings(workspace());
    const controls = accessControls(html);
    expect(html).toContain("Редактор свободен");
    expect(controls.attributes).not.toContain('disabled=""');
    expect(controls.content).toContain('autoComplete="current-password"');
    expect(buttonAttributes(controls.content, "Войти в режим редактирования")).toContain('disabled=""');
  });

  it("allows entering a confirmed free unprotected folder", () => {
    const controls = accessControls(renderSettings(workspace({ accessControlled: false })));
    expect(controls.attributes).not.toContain('disabled=""');
    expect(buttonAttributes(controls.content, "Войти в режим редактирования")).not.toContain('disabled=""');
    expect(controls.content).not.toContain('type="password"');
  });

  it("keeps controls disabled without filesystem write permission even if the editor is free", () => {
    const html = renderSettings(workspace({ accessControlled: false, writable: false }));
    const controls = accessControls(html);
    expect(controls.attributes).toContain('disabled=""');
    expect(buttonAttributes(controls.content, "Войти в режим редактирования")).toContain('disabled=""');
  });

  it("lets the current editor release an unprotected folder without setting a password first", () => {
    const controls = accessControls(renderSettings(workspace({ editor: true, editorBusy: true, editorOwner: owner, accessControlled: false })));
    expect(controls.attributes).not.toContain('disabled=""');
    expect(buttonAttributes(controls.content, "Перейти в режим просмотра")).not.toContain('disabled=""');
    expect(controls.content).not.toContain('autoComplete="current-password"');
    expect(controls.content).not.toContain("Войти в режим редактирования");
  });

  it("renders the supplied current status without reading files or invoking native actions", () => {
    renderSettings(workspace({ editorBusy: true, editorOwner: owner }));
    const next = renderSettings(workspace({ accessControlled: false }));
    expect(next).toContain("Редактор свободен");
    expect(next).not.toContain(owner.displayName);
    expect(invoke).not.toHaveBeenCalled();
  });
});
