import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContractEditor, ContractsRegistry } from "../contracts/Contracts";
import { CounterpartiesRegistry } from "../contracts/Counterparties";
import { CompanyEditor } from "../contracts/CompanyDirectory";
import { StaffEditor, StaffRegistry } from "../staff/Staff";
import { ProcurementEditor, ProcurementRegistry } from "../procurement/Procurement";
import { buildIntelligenceHandoff, emptyIntelligenceItem } from "./workbenchModel";
import type { IntelligenceDestination, IntelligenceHandoff } from "./workbenchTypes";

// Real receiving components and effects; DOM mounting and child editor rendering
// are independent boundaries. The state harness keeps refs across each render.
const runtime = vi.hoisted(() => ({ cursor: 0, changed: false, editor: true, slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>, effects: [] as Array<() => void>, store: { records: [] as unknown[], loading: false, error: null as string | null, cacheNotice: "", save: vi.fn(), reload: vi.fn(), archive: vi.fn(), archiveMany: vi.fn() }, directory: { companies: [] as unknown[], loading: false, error: null as string | null, cacheNotice: "", save: vi.fn(), reload: vi.fn(), persistContractThenDirectory: vi.fn() }, write: vi.fn(), getWorkspace: vi.fn(), staged: vi.fn() }));

vi.mock("react", async (original) => {
  const same = (left?: readonly unknown[], right?: readonly unknown[]) => left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => { const index = runtime.cursor++; const previous = runtime.slots[index]; if (!previous || !same(previous.deps, deps)) runtime.slots[index] = { value: factory(), deps }; return runtime.slots[index].value; };
  return { ...await original<typeof import("react")>(),
    useState: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: typeof initial === "function" ? initial() : initial }; return [runtime.slots[index].value, (next: unknown) => { const value = typeof next === "function" ? next(runtime.slots[index].value) : next; if (!Object.is(value, runtime.slots[index].value)) { runtime.slots[index].value = value; runtime.changed = true; } }]; },
    useRef: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: { current: initial } }; return runtime.slots[index].value; },
    useMemo: memo, useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useId: () => memo(() => `test-id-${runtime.cursor}`, []),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = runtime.cursor++; const previous = runtime.slots[index]; if (previous && same(previous.deps, deps)) return; runtime.slots[index] = { ...previous, deps }; runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; }); },
  };
});
vi.mock("react-dom", async (original) => ({ ...await original<typeof import("react-dom")>(), createPortal: (children: ReactNode) => children }));
vi.mock("../../hooks/useRecords", () => ({ useRecords: () => runtime.store }));
vi.mock("../../lib/workspaceAccess", () => ({ useWorkspaceAccess: () => ({ editor: runtime.editor, message: "Тестовый доступ" }) }));
vi.mock("../contracts/CompanyDirectory", () => ({ useCompanyDirectory: () => ({ ...runtime.directory, editor: runtime.editor }), CompanyEditor: () => null, CompanyNameField: () => null }));
vi.mock("../../lib/storage", async (original) => ({ ...await original<typeof import("../../lib/storage")>(), saveRecord: runtime.write, saveDraft: runtime.write, importRecordsAtomic: runtime.write, updateRecordsAtomic: runtime.write, copyAttachment: runtime.write, getWorkspaceInfo: runtime.getWorkspace, discardStagedAttachments: runtime.staged }));

type NodeProps = { children?: ReactNode; onClick?: () => unknown; onClose?: () => void; initialValue?: unknown; record?: unknown; company?: unknown; value?: unknown; readOnly?: boolean; onSave?: (value: unknown, id?: string) => Promise<void> };
type RegistryProps = { intelligenceHandoff?: IntelligenceHandoff; onIntelligenceHandoffConsumed?: () => void };
type Registry = (props?: RegistryProps) => ReactNode;
const registries = [
  { destination: "contracts", registry: ContractsRegistry, editor: ContractEditor, button: "Добавить договор", fields: { subject: "Предмет из ИИ", customer: "Клиент" } },
  { destination: "staff", registry: StaffRegistry, editor: StaffEditor, button: "Добавить человека", fields: { fullName: "Иванов Иван", skills: ["Аудит"] } },
  { destination: "procurement", registry: ProcurementRegistry, editor: ProcurementEditor, button: "Добавить закупку", fields: { name: "Закупка из ИИ", requirements: ["Требование"] } },
  { destination: "counterparties", registry: CounterpartiesRegistry, editor: CompanyEditor, button: "Добавить компанию", fields: { name: "Компания из ИИ", inn: "1234567890" } },
] as const;
let tree: ReactNode;
let component: Registry;
let props: RegistryProps;
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("") : isValidElement<NodeProps>(node) ? text(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "";
const nodes = (node: ReactNode = tree): ReactElement<NodeProps>[] => Array.isArray(node) ? node.flatMap((child) => nodes(child ?? null)) : isValidElement<NodeProps>(node) ? [node, ...nodes(node.props.children ?? null)] : [];
function render(next = props) { props = next; runtime.cursor = 0; runtime.changed = false; tree = component(props); for (const effect of runtime.effects.splice(0)) effect(); }
async function flush() { for (let turn = 0; turn < 30; turn++) { await Promise.resolve(); if (runtime.changed) render(); } }
function editorNode(editor: unknown) { return nodes().find((node) => node.type === editor); }
function click(label: string) { const button = nodes().find((node) => node.type === "button" && text(node.props.children) === label); if (!button) throw new Error(`Missing button: ${label}`); button.props.onClick?.(); }
function handoff(test: typeof registries[number]): IntelligenceHandoff {
  const value = { ...emptyIntelligenceItem(test.destination as IntelligenceDestination), fields: Object.fromEntries(Object.entries(test.fields).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])), selectedFields: Object.keys(test.fields) };
  return buildIntelligenceHandoff(value, [], "/test/workspace");
}
const assertNoWrites = () => {
  expect(runtime.store.save).not.toHaveBeenCalled(); expect(runtime.store.archive).not.toHaveBeenCalled(); expect(runtime.store.archiveMany).not.toHaveBeenCalled();
  expect(runtime.directory.save).not.toHaveBeenCalled(); expect(runtime.directory.persistContractThenDirectory).not.toHaveBeenCalled(); expect(runtime.write).not.toHaveBeenCalled();
};

beforeEach(() => {
  runtime.cursor = 0; runtime.changed = false; runtime.editor = true; runtime.slots = []; runtime.effects = [];
  runtime.store.records = []; runtime.store.loading = false; runtime.store.error = null;
  runtime.directory.companies = []; runtime.directory.loading = false; runtime.directory.error = null;
  props = {};
  for (const mock of [runtime.store.save, runtime.store.reload, runtime.store.archive, runtime.store.archiveMany, runtime.directory.save, runtime.directory.reload, runtime.directory.persistContractThenDirectory, runtime.write, runtime.getWorkspace, runtime.staged]) mock.mockReset();
  runtime.getWorkspace.mockResolvedValue({ root: "/test/workspace", editor: true }); runtime.staged.mockResolvedValue(undefined);
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { runtime.slots.forEach((slot) => slot.cleanup?.()); vi.unstubAllGlobals(); });

describe.each(registries)("$destination receives AI drafts", (test) => {
  beforeEach(() => { component = test.registry as Registry; });

  it("consumes a handoff exactly once and opens a cloned unsaved seed without database writes", async () => {
    const incoming = handoff(test); const consumed = vi.fn();
    render({ intelligenceHandoff: incoming, onIntelligenceHandoffConsumed: consumed }); await flush();
    const editor = editorNode(test.editor)!;
    expect(editor).toBeTruthy(); expect(consumed).toHaveBeenCalledOnce();
    const seeded = test.destination === "counterparties" ? editor.props.company : editor.props.initialValue;
    expect(seeded).toEqual(incoming.data); expect(seeded).not.toBe(incoming.data); expect(editor.props.record).toBeUndefined();
    render(); await flush(); expect(consumed).toHaveBeenCalledOnce();
    editorNode(test.editor)!.props.onClose?.(); await flush();
    expect(editorNode(test.editor)).toBeUndefined(); expect(consumed).toHaveBeenCalledOnce(); assertNoWrites();
  });

  it("waits for editor access without consuming or writing", async () => {
    runtime.editor = false; const incoming = handoff(test); const consumed = vi.fn();
    render({ intelligenceHandoff: incoming, onIntelligenceHandoffConsumed: consumed }); await flush();
    expect(editorNode(test.editor)).toBeUndefined(); expect(consumed).not.toHaveBeenCalled(); assertNoWrites();
    runtime.editor = true; render(); await flush();
    expect(editorNode(test.editor)).toBeTruthy(); expect(consumed).toHaveBeenCalledOnce(); assertNoWrites();
  });

  it("keeps an already open new editor until explicitly closed, then accepts the pending handoff", async () => {
    render(); click(test.button); await flush();
    const original = editorNode(test.editor)!; expect(original).toBeTruthy();
    const incoming = handoff(test); const consumed = vi.fn();
    render({ intelligenceHandoff: incoming, onIntelligenceHandoffConsumed: consumed }); await flush();
    const current = editorNode(test.editor)!;
    if (test.destination === "counterparties") expect(current.props.company).toEqual(original.props.company);
    else expect(current.props.initialValue).toBeUndefined();
    expect(consumed).not.toHaveBeenCalled(); assertNoWrites();
    current.props.onClose?.(); await flush();
    expect(consumed).toHaveBeenCalledOnce();
    const next = editorNode(test.editor)!;
    expect(test.destination === "counterparties" ? next.props.company : next.props.initialValue).toEqual(incoming.data); assertNoWrites();
  });
});

describe("editor initial values", () => {
  it("ContractEditor uses the transferred payload rather than an empty or current database record", async () => {
    component = ContractEditor as unknown as Registry;
    const value = handoff(registries[0]).data;
    const onSave = vi.fn();
    render({ initialValue: value, companies: [], onSave, onClose: vi.fn() } as RegistryProps); await flush();
    expect(nodes().some((node) => node.type === "textarea" && node.props.value === "Предмет из ИИ")).toBe(true);
    expect(onSave).not.toHaveBeenCalled(); assertNoWrites();
  });

  it("StaffEditor and ProcurementEditor retain incoming data without implicit saving", async () => {
    for (const test of [registries[1], registries[2]]) {
      runtime.slots.forEach((slot) => slot.cleanup?.()); runtime.slots = []; runtime.effects = [];
      component = test.editor as unknown as Registry;
      const value = handoff(test).data; const onSave = vi.fn();
      render({ initialValue: value, onSave, onClose: vi.fn() } as RegistryProps); await flush();
      const expected = test.destination === "staff" ? "Иванов Иван" : "Закупка из ИИ";
      expect(nodes().some((node) => node.type === "input" && node.props.value === expected)).toBe(true);
      expect(onSave).not.toHaveBeenCalled(); assertNoWrites();
    }
  });
});
