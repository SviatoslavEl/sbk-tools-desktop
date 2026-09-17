import { isValidElement, type ReactElement, type ReactNode } from "react";
// @ts-expect-error Node built-ins are provided by the test runner.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "./Settings";
import type { BackupListItem, WorkspaceInfo } from "../../lib/storage";

const hooks = vi.hoisted(() => ({
  cursor: 0, changed: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>,
  effects: [] as Array<() => void>,
  list: vi.fn(), verify: vi.fn(), backup: vi.fn(), intelligence: vi.fn(), save: vi.fn(), reload: vi.fn(),
  loading: false, error: null as string | null,
  timers: { refreshSeconds: 30, backupHours: 0, retentionCount: 10, retentionDays: 180 },
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!hooks.slots[index]) hooks.slots[index] = { value: typeof initial === "function" ? initial() : initial };
    return [hooks.slots[index].value, (next: unknown) => { const value = typeof next === "function" ? next(hooks.slots[index].value) : next; if (!Object.is(value, hooks.slots[index].value)) { hooks.slots[index].value = value; hooks.changed = true; } }];
  },
  useRef: (value: unknown) => { const index = hooks.cursor++; if (!hooks.slots[index]) hooks.slots[index] = { value: { current: value } }; return hooks.slots[index].value; },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = hooks.cursor++, previous = hooks.slots[index];
    if (previous?.deps && deps && previous.deps.length === deps.length && previous.deps.every((value, i) => Object.is(value, deps[i]))) return;
    hooks.slots[index] = { ...previous, deps };
    hooks.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; });
  },
}));
vi.mock("../../hooks/useRecords", () => ({ useRecords: () => ({ records: [], loading: hooks.loading, error: hooks.error, save: hooks.save, reload: hooks.reload }) }));
vi.mock("../../lib/workspaceAccess", () => ({ useWorkspaceAccess: () => ({ editor: true, message: "Редактор" }) }));
vi.mock("../../lib/storage", async (original) => ({ ...await original<typeof import("../../lib/storage")>(), listBackups: hooks.list, verifyBackup: hooks.verify, createBackup: hooks.backup }));
vi.mock("../intelligence/api", () => ({ getIntelligenceProviderStatus: hooks.intelligence }));
vi.mock("../../lib/sharedWorkspace", () => ({ readAccessTimers: () => hooks.timers, saveAccessTimers: (value: unknown) => value }));

type Props = { children?: ReactNode; hidden?: boolean; disabled?: boolean; className?: string; onClick?: () => unknown; role?: string };
let tree: ReactNode;
const workspace: WorkspaceInfo = { root: "/tmp/sbk-settings-test", portable: false, configured: true, writable: true, editor: true, editorBusy: false, accessControlled: false, accessMessage: "Редактор", schemaVersion: 1, freeSpaceBytes: 1_000_000 };

function render() {
  hooks.cursor = 0; hooks.changed = false;
  tree = Settings({ collapsed: false, onCollapsed: vi.fn(), workspace, onWorkspaceChange: vi.fn() });
  for (const effect of hooks.effects.splice(0)) effect();
}
async function flush() { for (let i = 0; i < 20; i += 1) { await Promise.resolve(); if (hooks.changed) render(); } }
function nodes(node: ReactNode = tree): ReactElement<Props>[] { if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null)); if (!isValidElement<Props>(node)) return []; return [node, ...nodes(node.props.children ?? null)]; }
function text(node: ReactNode = tree): string { if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join(""); if (isValidElement<Props>(node)) return text(node.props.children ?? null); return typeof node === "string" || typeof node === "number" ? String(node) : ""; }
function button(label: string, within: ReactNode = tree) { const found = nodes(within).find((node) => node.type === "button" && text(node.props.children) === label); if (!found) throw new Error(`Button missing: ${label}`); return found; }
function section(title: string) { const found = nodes().find((node) => node.type === "section" && nodes(node).some((child) => child.type === "h2" && text(child) === title)); if (!found) throw new Error(`Section missing: ${title}`); return found; }
const interfaceFieldset = () => nodes().find((node) => node.type === "fieldset" && node.props.className?.includes("settings-interface-fields"))!;
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const copy: BackupListItem = { path: "/tmp/qa-copy.sbkbackup", fileName: "qa-copy.sbkbackup", sizeBytes: 1024, modifiedAt: "2026-09-17T09:00:00Z", pinned: false };

beforeEach(() => {
  hooks.cursor = 0; hooks.changed = false; hooks.slots = []; hooks.effects = []; hooks.loading = false; hooks.error = null;
  for (const fn of [hooks.list, hooks.verify, hooks.backup, hooks.intelligence, hooks.save, hooks.reload]) fn.mockReset();
  hooks.list.mockResolvedValue([]); hooks.intelligence.mockResolvedValue(null); hooks.save.mockResolvedValue(undefined);
  hooks.verify.mockResolvedValue({ files: 3, unpackedBytes: 1024, sha256: "synthetic" });
  hooks.backup.mockResolvedValue(copy);
  vi.stubGlobal("window", { confirm: vi.fn(() => true), dispatchEvent: vi.fn(), setTimeout, clearTimeout });
});
afterEach(() => { for (const slot of hooks.slots) slot.cleanup?.(); vi.unstubAllGlobals(); });

describe("settings navigation and backup confidence", () => {
  it("shows only the selected one of four groups and enforces hidden in scoped CSS", async () => {
    render(); await flush();
    const groups: Array<[string, string[]]> = [
      ["Рабочая папка", ["Общая рабочая папка", "Обновление данных"]],
      ["Резервные копии", ["Создание и защита копий", "Резервное копирование"]],
      ["Интерфейс", ["Интерфейс и история"]],
      ["Обслуживание", ["Локальный AI-сервер", "Изоляция данных", "Контроль вложений"]],
    ];
    for (const [label, expected] of groups) {
      button(label).props.onClick?.(); await flush();
      const visible = nodes().filter((node) => node.type === "section" && node.props.hidden === false).map((node) => text(nodes(node).find((child) => child.type === "h2")));
      expect(visible).toEqual(expected);
    }
    const css = readFileSync(new URL("./settings.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.settings-module \[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  it("does not call a loading or failed backup list empty; explicit retry can confirm emptiness", async () => {
    const listing = deferred<BackupListItem[]>();
    hooks.list.mockReturnValueOnce(listing.promise).mockResolvedValueOnce([]);
    render(); await flush();
    expect(text(section("Резервное копирование"))).toContain("Проверяем список копий");
    expect(text()).not.toContain("Резервных копий пока нет");
    listing.reject(new Error("Нет сети")); await flush();
    expect(text()).toContain("Состояние резервных копий не подтверждено");
    expect(text()).not.toContain("Резервных копий пока нет");
    button("Повторить загрузку").props.onClick?.(); await flush();
    expect(text()).toContain("Резервных копий пока нет");
    expect(text()).not.toContain("Состояние резервных копий не подтверждено");
  });

  it("reports the latest known backup and limits verification claims to the current session", async () => {
    const listed = [{ ...copy, modifiedAt: "2026-01-01T10:00:00Z" }, { ...copy, path: "/tmp/new.sbkbackup", fileName: "new.sbkbackup" }];
    hooks.list.mockResolvedValue(listed);
    render(); await flush();
    expect(text()).toContain(`Последняя копия: ${new Date(copy.modifiedAt).toLocaleString("ru-RU")}`);
    expect(text()).toContain("Целостность существующих копий в этом сеансе не проверялась");
    expect(listed[0].modifiedAt).toBe("2026-01-01T10:00:00Z");
    button("Проверить", section("Резервное копирование")).props.onClick?.(); await flush();
    expect(hooks.verify).toHaveBeenCalledWith(copy.path);
    expect(text()).toContain("Проверена в этом сеансе: qa-copy.sbkbackup");
    expect(text()).toContain("Повреждений не обнаружено");
    hooks.verify.mockRejectedValueOnce(new Error("Нарушена целостность"));
    button("Проверить", section("Резервное копирование")).props.onClick?.(); await flush();
    expect(text()).not.toContain("Проверена в этом сеансе:");
    expect(text()).toContain("Ошибка проверки");
  });

  it("disables interface writes while maintenance runs and serializes repeated backup clicks", async () => {
    const work = deferred<BackupListItem>();
    hooks.backup.mockReturnValueOnce(work.promise);
    render(); await flush();
    const create = button("Создать резервную копию").props.onClick!;
    create(); create(); await flush();
    expect(hooks.backup).toHaveBeenCalledOnce();
    button("Интерфейс").props.onClick?.(); await flush();
    expect(interfaceFieldset().props.disabled).toBe(true);
    work.resolve(copy); await flush();
    expect(interfaceFieldset().props.disabled).toBe(false);
  });

  it("waits for settings to load before permitting a default-value overwrite", async () => {
    hooks.loading = true;
    render(); await flush();
    expect(interfaceFieldset().props.disabled).toBe(true);
    expect(hooks.save).not.toHaveBeenCalled();
    hooks.loading = false; render(); await flush();
    expect(interfaceFieldset().props.disabled).toBe(false);
  });

  it("keeps interface writes disabled after a read failure until a retry establishes saved settings", async () => {
    hooks.error = "Папка недоступна";
    render(); await flush();
    expect(interfaceFieldset().props.disabled).toBe(true);
    expect(text()).toContain("Настройки не прочитаны: Папка недоступна");
    expect(hooks.save).not.toHaveBeenCalled();
    button("Повторить загрузку настроек").props.onClick?.(); await flush();
    expect(hooks.reload).toHaveBeenCalledOnce();
    expect(interfaceFieldset().props.disabled).toBe(true);
    hooks.error = null; render(); await flush();
    expect(interfaceFieldset().props.disabled).toBe(false);
  });

  it("returns controls after a failed maintenance operation without claiming success", async () => {
    hooks.backup.mockRejectedValueOnce(new Error("Папка недоступна"));
    render(); await flush();
    button("Создать резервную копию").props.onClick?.(); await flush();
    expect(text()).toContain("Ошибка: Error: Папка недоступна");
    expect(text()).not.toContain("Резервная копия создана");
    expect(interfaceFieldset().props.disabled).toBe(false);
  });
});
