import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContractsRegistry } from "./Contracts";
import { StaffRegistry } from "../staff/Staff";
import { RegistryTableView } from "./RegistryTableView";
import { SortableHeader } from "../../components/SortableHeader";
import { emptyContract } from "./types";
import { emptyStaff } from "../staff/types";

const state = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], storage: new Map<string, string>(), records: {} as Record<string, unknown[]> }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const i = state.cursor++; if (!(i in state.slots)) state.slots[i] = typeof initial === "function" ? initial() : initial; return [state.slots[i], (value: unknown) => { state.slots[i] = typeof value === "function" ? value(state.slots[i]) : value; }]; },
  useRef: (initial: unknown) => { const i = state.cursor++; if (!(i in state.slots)) state.slots[i] = { current: initial }; return state.slots[i]; },
  useMemo: (factory: () => unknown) => factory(), useEffect: () => undefined,
}));
vi.mock("../../hooks/useRecords", () => ({ useRecords: (module: string) => ({ records: state.records[module] || [], loading: false, error: null, reload: vi.fn() }) }));
vi.mock("../../hooks/useViewState", () => ({ useViewState: (_key: string, initial: unknown) => [initial, vi.fn()] }));
vi.mock("../../hooks/useUnsavedChanges", () => ({ useUnsavedChanges: () => undefined }));
vi.mock("../../lib/workspaceAccess", () => ({ useWorkspaceAccess: () => ({ editor: true, message: "QA" }) }));
vi.mock("./CompanyDirectory", async (original) => ({ ...await original<typeof import("./CompanyDirectory")>(), useCompanyDirectory: () => ({ companies: [], editor: true, loading: false, accessMessage: "QA" }) }));

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
let tree: ReactNode;
function nodes(value: ReactNode = tree): Node[] { if (Array.isArray(value)) return value.flatMap((entry) => nodes(entry ?? null)); if (!isValidElement<Record<string, unknown> & { children?: ReactNode }>(value)) return []; if (value.type === RegistryTableView) return nodes(RegistryTableView(value.props as Parameters<typeof RegistryTableView>[0])); return [value, ...nodes(value.props.children ?? null)]; }
function text(value: ReactNode): string { if (Array.isArray(value)) return value.map((entry) => text(entry ?? null)).join(""); if (isValidElement<{ children?: ReactNode }>(value)) return text(value.props.children ?? null); return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function render(component: typeof ContractsRegistry | typeof StaffRegistry) { state.cursor = 0; tree = component({}); }
const table = () => nodes().find((entry) => entry.type === "table" && String(entry.props.className).includes("registry-overview-table"))!;
const headings = () => nodes(table()).filter((entry) => entry.type === SortableHeader).map((entry) => entry.props.label);
const press = (label: string) => { const node = nodes().find((entry) => entry.type === "button" && text(entry) === label)!; (node.props.onClick as () => void)(); };
const fixture = <T,>(payload: T) => ({ id: "qa-record", title: "QA", payload, archived: false, createdAt: "2026-10-16", updatedAt: "2026-10-16" });
beforeEach(() => { state.cursor = 0; state.slots = []; state.storage.clear(); state.records = {}; vi.stubGlobal("localStorage", { getItem: (key: string) => state.storage.get(key) ?? null, setItem: (key: string, value: string) => state.storage.set(key, value) }); });

describe("registry column choices render actual cells without inline style injection", () => {
  it("contracts: compact → detailed → custom checkbox → remount keeps headers/cells/count in sync", () => {
    state.records["contract-experience"] = [fixture({ ...emptyContract(), number: "QA-COLUMN", performingLegalEntity: "QA performer" })];
    state.storage.set("sbk-registry-columns-contracts-v1", JSON.stringify(["number", "performer", "customer", "subject", "period", "payment"]));
    render(ContractsRegistry); expect(headings()).toHaveLength(6);
    press("Кратко"); render(ContractsRegistry);
    expect(headings()).toEqual(["Номер и дата", "Заказчик", "Сумма", "Стадия"]);
    expect(nodes(table()).filter((entry) => entry.type === "td")).toHaveLength(6);
    expect(nodes().some((entry) => entry.type === "style")).toBe(false);
    expect(nodes(table()).find((entry) => entry.type === "input" && entry.props["aria-label"] === "Выбрать договор QA-COLUMN")).toBeDefined();
    expect(nodes(table()).find((entry) => entry.type === "button" && entry.props["aria-label"] === "Архивировать QA-COLUMN")).toBeDefined();
    press("Подробно"); render(ContractsRegistry); expect(headings()).toHaveLength(11);
    const label = nodes().find((entry) => entry.type === "label" && text(entry) === "Оплата")!;
    const checkbox = nodes(label).find((entry) => entry.type === "input")!;
    (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: false } }); render(ContractsRegistry);
    expect(headings()).not.toContain("Оплата"); expect(headings()).toHaveLength(10);
    state.slots = []; render(ContractsRegistry); expect(headings()).not.toContain("Оплата"); expect(headings()).toHaveLength(10);
    const number = nodes().find((entry) => entry.type === "label" && text(entry) === "Номер и дата")!;
    expect(nodes(number).find((entry) => entry.type === "input")?.props.disabled).toBe(true);
  });

  it("staff: four columns really hide optional cells, but retain grouping, selection and actions", () => {
    state.records.staff = [fixture({ ...emptyStaff(), fullName: "QA сотрудник" })];
    render(StaffRegistry);
    expect(headings()).toEqual(["ФИО", "Должность / роль", "Основание", "Полнота карточки"]);
    expect(nodes(table()).filter((entry) => entry.type === "td" && !entry.props.colSpan)).toHaveLength(6);
    expect(nodes(table()).find((entry) => entry.type === "td" && entry.props.colSpan)?.props.colSpan).toBe(6);
    expect(nodes(table()).some((entry) => entry.type === "input" && entry.props["aria-label"] === "Выбрать сотрудника QA сотрудник")).toBe(true);
    press("Подробно"); render(StaffRegistry); expect(headings()).toHaveLength(9);
    expect(nodes(table()).find((entry) => entry.type === "td" && entry.props.colSpan)?.props.colSpan).toBe(11);
    press("Кратко"); render(StaffRegistry); expect(headings()).toHaveLength(4);
    expect(nodes().some((entry) => entry.type === "style")).toBe(false);
  });
});
