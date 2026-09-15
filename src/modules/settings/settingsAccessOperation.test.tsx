import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceInfo, switchWorkspaceMode, type WorkspaceInfo } from "../../lib/storage";
import { Settings } from "./Settings";

const state = vi.hoisted(() => ({ updates: [] as unknown[] }));

// Exercise the component's actual async click handler, without a browser or
// native calls. Effects are deliberately excluded; rendering is tested apart.
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (initial: unknown) => {
    let value = typeof initial === "function" ? initial() : initial;
    return [value, (next: unknown) => {
      value = typeof next === "function" ? next(value) : next;
      state.updates.push(value);
    }];
  },
}));
vi.mock("../../lib/storage", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/storage")>(),
  getWorkspaceInfo: vi.fn(),
  switchWorkspaceMode: vi.fn(),
}));
vi.mock("../../hooks/useRecords", () => ({
  useRecords: () => ({ records: [], loading: false, error: null, save: vi.fn() }),
}));
vi.mock("../../lib/workspaceAccess", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/workspaceAccess")>(),
  useWorkspaceAccess: () => ({ editor: false, message: "Режим просмотра" }),
}));
vi.mock("../../lib/sharedWorkspace", () => ({
  readAccessTimers: () => ({ refreshSeconds: 30, backupHours: 0, retentionCount: 10, retentionDays: 180 }),
  saveAccessTimers: vi.fn(),
}));

const workspace = (patch: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  root: "/synthetic-shared/ProductData",
  portable: false,
  configured: true,
  writable: true,
  editor: false,
  editorBusy: false,
  accessControlled: false,
  accessMessage: "Режим просмотра",
  ownerConfigured: true,
  schemaVersion: 1,
  freeSpaceBytes: 1024,
  ...patch,
});

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? nodeText(node.props.children) : "";
}

function buttonHandler(node: ReactNode, label: string): (() => void) | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = buttonHandler(child, label);
      if (found) return found;
    }
  }
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return undefined;
  if (node.type === "button" && nodeText(node.props.children) === label) return node.props.onClick;
  return buttonHandler(node.props.children, label);
}

function settingsAction(snapshot: WorkspaceInfo, label: string) {
  const onWorkspaceChange = vi.fn();
  const tree = Settings({ collapsed: false, onCollapsed: vi.fn(), workspace: snapshot, onWorkspaceChange });
  const click = buttonHandler(tree, label);
  if (!click) throw new Error(`Missing settings action: ${label}`);
  return { click, onWorkspaceChange };
}

describe("settings release retry async operation", () => {
  beforeEach(() => { vi.clearAllMocks(); state.updates.length = 0; });

  it("accepts cleanup completed by status refresh without a second release or password check", async () => {
    const pending = workspace({ editorCleanupPending: true, accessControlled: true });
    const cleaned = workspace({ accessControlled: true, accessMessage: "Свой сеанс освобождён" });
    vi.mocked(getWorkspaceInfo).mockResolvedValue(cleaned);
    const { click, onWorkspaceChange } = settingsAction(pending, "Повторить освобождение своего сеанса");
    click();
    await vi.waitFor(() => expect(state.updates[state.updates.length - 1]).toBe(false));
    expect(onWorkspaceChange).toHaveBeenCalledWith(cleaned);
    expect(getWorkspaceInfo).toHaveBeenCalledTimes(1);
    expect(switchWorkspaceMode).not.toHaveBeenCalled();
    expect(state.updates).toContain("Собственный сеанс больше не удерживается этим экземпляром. Свой сеанс освобождён");
    expect(state.updates.some((value) => String(value).includes("Ошибка доступа:"))).toBe(false);
  });

  it("retries release, never acquisition, while own cleanup remains pending", async () => {
    const pending = workspace({ editorCleanupPending: true, editorStateMessage: "Сеть недоступна" });
    const cleaned = workspace({ accessMessage: "Сеанс освобождён" });
    vi.mocked(getWorkspaceInfo).mockResolvedValueOnce(pending).mockResolvedValueOnce(cleaned);
    vi.mocked(switchWorkspaceMode).mockResolvedValue(undefined);
    const { click } = settingsAction(pending, "Повторить освобождение своего сеанса");
    click();
    await vi.waitFor(() => expect(state.updates[state.updates.length - 1]).toBe(false));
    expect(switchWorkspaceMode).toHaveBeenCalledExactlyOnceWith(false, "");
    expect(getWorkspaceInfo).toHaveBeenCalledTimes(2);
    expect(state.updates).toContain("Сеанс освобождён");
  });

  it("does not treat an ordinary stale editor snapshot as a successful cleanup retry", async () => {
    const otherEditor = workspace({ editorBusy: true });
    vi.mocked(getWorkspaceInfo).mockResolvedValue(otherEditor);
    const { click } = settingsAction(workspace({ editor: true }), "Перейти в режим просмотра");
    click();
    await vi.waitFor(() => expect(state.updates[state.updates.length - 1]).toBe(false));
    expect(switchWorkspaceMode).not.toHaveBeenCalled();
    expect(state.updates.some((value) => String(value).includes("Режим редактора уже занят или изменился"))).toBe(true);
    expect(state.updates.some((value) => String(value).includes("Собственный сеанс больше не удерживается"))).toBe(false);
  });

  it("serializes double clicks before React can render the disabled state", async () => {
    let finishRefresh!: (value: WorkspaceInfo) => void;
    vi.mocked(getWorkspaceInfo).mockImplementation(() => new Promise((resolve) => { finishRefresh = resolve; }));
    const { click } = settingsAction(workspace({ editorCleanupPending: true }), "Повторить освобождение своего сеанса");
    click();
    click();
    expect(getWorkspaceInfo).toHaveBeenCalledTimes(1);
    finishRefresh(workspace());
    await vi.waitFor(() => expect(state.updates[state.updates.length - 1]).toBe(false));
    expect(switchWorkspaceMode).not.toHaveBeenCalled();
  });
});
