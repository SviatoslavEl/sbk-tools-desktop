import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { useRecords } from "./useRecords";
import { useCompanyDirectory } from "../modules/contracts/CompanyDirectory";
import { emptyContract, type ContractData } from "../modules/contracts/types";
import { emptyCompany, type CompanyDirectoryData } from "../modules/contracts/companies";
import { applyNetworkAccessStatus } from "../lib/networkDiagnostics";
import { archiveRecords, clearDraft, importRecordsAtomic, listRecords, restoreBackup, restoreEncryptedBackup, restoreHistoryVersion, saveDraft, saveRecord, updateRecordsAtomic, type StoredRecord } from "../lib/storage";
import { resetUiListCacheForTests } from "../lib/uiListCache";

const hooks = vi.hoisted(() => ({ cursor: 0, changed: false, editor: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>, effects: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => { const i = hooks.cursor++; if (!hooks.slots[i] || !same(hooks.slots[i].deps, deps)) hooks.slots[i] = { value: factory(), deps }; return hooks.slots[i].value; };
  return { ...await original<typeof import("react")>(),
    useState: (initial: unknown) => { const i = hooks.cursor++; if (!hooks.slots[i]) hooks.slots[i] = { value: typeof initial === "function" ? initial() : initial }; return [hooks.slots[i].value, (next: unknown) => { const value = typeof next === "function" ? next(hooks.slots[i].value) : next; if (!Object.is(value, hooks.slots[i].value)) { hooks.slots[i].value = value; hooks.changed = true; } }]; },
    useRef: (initial: unknown) => { const i = hooks.cursor++; if (!hooks.slots[i]) hooks.slots[i] = { value: { current: initial } }; return hooks.slots[i].value; },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const i = hooks.cursor++; const previous = hooks.slots[i]; if (previous && same(previous.deps, deps)) return; hooks.slots[i] = { ...previous, deps }; hooks.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.slots[i].cleanup = typeof cleanup === "function" ? cleanup : undefined; }); },
  };
});
vi.mock("../lib/workspaceAccess", async (original) => ({ ...await original<typeof import("../lib/workspaceAccess")>(), useWorkspaceAccess: () => ({ editor: hooks.editor, message: hooks.editor ? "Редактор" : "Просмотр" }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

let records!: ReturnType<typeof useRecords<ContractData>>;
let directory!: ReturnType<typeof useCompanyDirectory>;
let current: { records: StoredRecord<ContractData>[]; directory: CompanyDirectoryData | null };
const record = (id: string, payload = emptyContract()): StoredRecord<ContractData> => ({ id, title: payload.number, payload, archived: false, createdAt: "2026-10-02", updatedAt: "2026-10-02" });
function render() { hooks.cursor = 0; hooks.changed = false; records = useRecords<ContractData>("contract-experience"); directory = useCompanyDirectory(records.records); for (const effect of hooks.effects.splice(0)) effect(); }
async function flush() { for (let i = 0; i < 40; i++) { await Promise.resolve(); if (hooks.changed) render(); } }
function unmount() { hooks.slots.forEach((slot) => slot.cleanup?.()); hooks.slots = []; hooks.effects = []; hooks.cursor = 0; hooks.changed = false; }
const commands = () => vi.mocked(nativeInvoke).mock.calls.map(([command]) => command);

beforeEach(() => {
  hooks.editor = false; unmount(); resetUiListCacheForTests();
  const events = new EventTarget();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) });
  applyNetworkAccessStatus({ phase: "connected", activeOperations: 0, changedAt: "", error: null, restartRequired: false });
  current = { records: [record("old", { ...emptyContract(), number: "OLD", performingLegalEntity: "Наша компания", customer: "Заказчик", subject: "Исходная работа" })], directory: null };
  vi.mocked(nativeInvoke).mockReset();
  vi.mocked(nativeInvoke).mockImplementation(async (command, args) => {
    if (command === "read_contract_workspace") return structuredClone(current);
    if (command === "list_records") return structuredClone(current.records);
    if (command === "update_contracts_and_company_directory_atomic") {
      const patch = args as { records: Array<{ id: string; payload: ContractData }>; directory: CompanyDirectoryData };
      current.directory = patch.directory;
      current.records = current.records.map((item) => ({ ...item, payload: patch.records.find((change) => change.id === item.id)?.payload || item.payload }));
      return patch.records.length;
    }
    if (command === "save_contract_with_company_directory_atomic") {
      const patch = args as { payload: ContractData; directory: CompanyDirectoryData };
      current.directory = patch.directory;
      const saved = record("saved", patch.payload); current.records.push(saved); return saved;
    }
    if (command === "import_contracts_with_company_directory_atomic") {
      const patch = args as { records: Array<{ id: string; payload: ContractData }>; directory: CompanyDirectoryData };
      current.directory = patch.directory;
      current.records.push(...patch.records.map((item) => record(item.id, item.payload))); return patch.records.length;
    }
    return undefined;
  });
});
afterEach(() => { unmount(); resetUiListCacheForTests(); vi.unstubAllGlobals(); });

describe("shared UI registry snapshots", () => {
  it("loads records and directory once, opens read-only without migration writes, and reuses RAM on navigation", async () => {
    render(); await flush();
    expect(commands()).toEqual(["read_contract_workspace"]);
    expect(records.records).toHaveLength(1); expect(directory.companies).toHaveLength(2);
    expect(directory.editor).toBe(false); expect(directory.accessMessage).toBe("Просмотр");
    const ids = directory.companies.map((company) => company.id);
    unmount(); render(); await flush();
    expect(records.loading).toBe(false); expect(commands()).toEqual(["read_contract_workspace"]);
    expect(directory.companies.map((company) => company.id)).toEqual(ids);
    hooks.editor = true; render(); await flush();
    expect(directory.editor).toBe(true); expect(commands()).toEqual(["read_contract_workspace"]);
  });
  it("keeps visible rows and exposes the background refresh failure and stale notice", async () => {
    render(); await flush();
    vi.mocked(nativeInvoke).mockRejectedValueOnce(new Error("Общая папка недоступна"));
    window.dispatchEvent(new Event("sbk-workspace-refresh")); await flush();
    expect(records.records[0].id).toBe("old"); expect(records.loading).toBe(false);
    expect(records.error).toContain("Общая папка недоступна"); expect(directory.error).toContain("Общая папка недоступна");
    expect(records.stale).toBe(true); expect(records.cacheNotice).toContain("неактуальны");
    expect(directory.editor).toBe(false);
  });
  it("does not cache fresh storage validation or archived-list reads", async () => {
    render(); await flush();
    await listRecords("contract-experience", true); await listRecords("contract-experience", true);
    expect(commands().filter((command) => command === "list_records")).toHaveLength(2);
    expect(vi.mocked(nativeInvoke).mock.calls.filter(([command]) => command === "list_records").every(([, args]) => (args as { includeArchived?: boolean })?.includeArchived === true)).toBe(true);
  });
  it.each([
    ["upsert_record", () => saveRecord("contract-experience", "Saved", emptyContract())],
    ["archive_records", () => archiveRecords("contract-experience", ["old"])],
    ["import_records_atomic", () => importRecordsAtomic("contract-experience", [])],
    ["update_records_atomic", () => updateRecordsAtomic("contract-experience", [])],
    ["restore_history_version", () => restoreHistoryVersion("contract-experience", "old", 1)],
    ["save_draft", () => saveDraft("contract-experience", { schemaVersion: 3, companies: [] }, "company-directory-v1")],
    ["clear_draft", () => clearDraft("contract-experience", "company-directory-v1")],
    ["restore_backup", () => restoreBackup("/synthetic/backup.zip")],
    ["restore_encrypted_backup", () => restoreEncryptedBackup("/synthetic/backup.enc", "synthetic-password")],
  ] as const)("refreshes the shared UI snapshot after %s without caching the mutation", async (command, action) => {
    render(); await flush();
    current.records[0].payload.subject = "После явной операции";
    await action(); await flush();
    expect(commands().filter((name) => name === command)).toHaveLength(1);
    expect(commands().filter((name) => name === "read_contract_workspace")).toHaveLength(2);
    expect(records.records[0].payload.subject).toBe("После явной операции");
    expect(records.stale).toBe(false);
  });
  it("uses fresh contracts and preserves unrelated fresh companies when explicitly renaming a company", async () => {
    hooks.editor = true; render(); await flush();
    const old = directory.companies.find((company) => company.name === "Заказчик")!;
    current.records[0].payload.subject = "Свежая работа другого окна";
    current.directory = { schemaVersion: 3, companies: [{ ...emptyCompany("2026-10-02", "external-new"), name: "Новая независимая компания" }] };
    await directory.save({ ...old, name: "Новое имя заказчика" }, old, []); await flush();
    expect(current.directory.companies.some((company) => company.id === "external-new")).toBe(true);
    expect(current.records[0].payload).toMatchObject({ subject: "Свежая работа другого окна", customer: "Новое имя заказчика", customerCompanyId: old.id });
    expect(current.records[0].payload.performingLegalEntityId).not.toBe("");
    expect(commands().filter((command) => command === "update_contracts_and_company_directory_atomic")).toHaveLength(1);
  });
  it.each(["save", "import"] as const)("persists full legacy links only during explicit contract %s", async (kind) => {
    hooks.editor = true; render(); await flush();
    expect(commands()).toEqual(["read_contract_workspace"]);
    const item = { ...emptyContract(), number: "NEW", performingLegalEntity: "Наша компания", customer: "Новый заказчик" };
    if (kind === "save") await directory.persistContractThenDirectory(item);
    else await directory.persistContractsThenDirectory([item]);
    await flush();
    for (const item of current.records) {
      expect(item.payload.performingLegalEntityId).not.toBe(""); expect(item.payload.customerCompanyId).not.toBe("");
      expect(current.directory!.companies.some((company) => company.id === item.payload.customerCompanyId)).toBe(true);
    }
    const command = kind === "save" ? "save_contract_with_company_directory_atomic" : "import_contracts_with_company_directory_atomic";
    expect(commands().indexOf("update_contracts_and_company_directory_atomic")).toBeLessThan(commands().indexOf(command));
  });
  it("checks fresh archived references before deletion instead of trusting the cached visible list", async () => {
    const archived = { ...emptyCompany("2026-10-02", "archived-company"), name: "Архивная компания", archived: true };
    current = { records: [], directory: { schemaVersion: 3, companies: [archived] } };
    hooks.editor = true; render(); await flush();
    const archivedContract = { ...record("archived-contract", { ...emptyContract(), customerCompanyId: archived.id }), archived: true };
    vi.mocked(nativeInvoke).mockImplementation(async (command) => command === "list_records" ? [archivedContract] : structuredClone(current));
    await expect(directory.deleteArchivedCompanies([archived.id], [])).rejects.toThrow("Нельзя удалить связанные");
    expect(commands()).toContain("list_records");
    expect(commands()).not.toContain("update_contracts_and_company_directory_atomic");
  });
});
