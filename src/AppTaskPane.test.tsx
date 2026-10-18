import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { Proposals } from "./modules/proposals/Proposals";
import { Settings } from "./modules/settings/Settings";
import { Calculator } from "./modules/calculator/Calculator";
import { ContractsRegistry } from "./modules/contracts/Contracts";
import { StaffRegistry } from "./modules/staff/Staff";
import { CounterpartiesRegistry } from "./modules/contracts/Counterparties";
import { ProcurementRegistry } from "./modules/procurement/Procurement";
import { createProposal as defaultProposal } from "./modules/proposals/defaults";
import { createTaskDocumentSession, reduceTaskDocumentSession, type TaskDocumentOrigin } from "./modules/intelligence/taskDocumentSession";
import { proposalTaskFingerprint, type ProposalTaskSessionChange } from "./modules/proposals/proposalTaskBridge";
import type { IntelligenceHandoff } from "./modules/intelligence/workbenchTypes";
import type { WorkspaceInfo } from "./lib/storage";

// Real App routing/hooks; native IO and child editors are controlled boundaries.
// Receiver lifecycle and data persistence have separate real-component tests.
const runtime = vi.hoisted(() => ({ cursor: 0, changed: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>,
  effects: [] as Array<() => void>, workspace: vi.fn(), phase: "connected",
  Workbench: function Workbench() { return null; },
}));
vi.mock("react", async (original) => {
  const same = (a?: readonly unknown[], b?: readonly unknown[]) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  return { ...await original<typeof import("react")>(), lazy: () => runtime.Workbench,
    useState: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: typeof initial === "function" ? initial() : initial }; return [runtime.slots[index].value, (next: unknown) => { const value = typeof next === "function" ? next(runtime.slots[index].value) : next; if (!Object.is(value, runtime.slots[index].value)) { runtime.slots[index].value = value; runtime.changed = true; } }]; },
    useRef: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: { current: initial } }; return runtime.slots[index].value; },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => { const index = runtime.cursor++, previous = runtime.slots[index]; if (previous && same(previous.deps, deps)) return; runtime.slots[index] = { ...previous, deps }; runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; }); },
  };
});
vi.mock("./lib/networkDiagnostics", () => ({ useNetworkAccess: () => ({ phase: runtime.phase }), networkAccessIsPaused: () => runtime.phase !== "connected", startNetworkAccessMonitor: () => () => {}, subscribeNetworkDiagnosticsShortcut: () => () => {}, networkDiagnosticsShortcutLabel: "Test", openNetworkDiagnosticsEvent: "test-network", networkPausedMessage: "offline" }));
vi.mock("./lib/storage", () => ({ getWorkspaceInfo: runtime.workspace, getStartupStatus: vi.fn(), quitApplication: vi.fn(), reportStartupUiVisible: vi.fn(), retryWorkspaceInitialization: vi.fn(), setWorkspaceLocation: vi.fn(), workspaceAccessInvalidatedEvent: "test-invalidated" }));
vi.mock("./lib/sharedWorkspace", () => ({ accessTimerEvent: "test-timers", readAccessTimers: () => ({ refreshSeconds: 0 }) }));
vi.mock("./hooks/useAutomaticBackup", () => ({ useAutomaticBackup: () => {} }));
vi.mock("./hooks/useViewState", () => ({ setViewStateWorkspace: () => {} }));
vi.mock("./lib/activity", () => ({ clearActivities: () => {} }));
vi.mock("./lib/files", () => ({ chooseDirectory: vi.fn() }));
vi.mock("./lib/workspaceAccess", () => ({ ReadOnlyWorkspaceBoundary: () => null, WorkspaceAccessProvider: () => null }));
vi.mock("./modules/proposals/Proposals", () => ({ Proposals: () => null }));
vi.mock("./modules/settings/Settings", () => ({ Settings: () => null, About: () => null }));
vi.mock("./modules/calculator/Calculator", () => ({ Calculator: () => null }));
vi.mock("./modules/contracts/Contracts", () => ({ ContractsRegistry: () => null }));
vi.mock("./modules/contracts/Counterparties", () => ({ CounterpartiesRegistry: () => null }));
vi.mock("./modules/staff/Staff", () => ({ StaffRegistry: () => null }));
vi.mock("./modules/procurement/Procurement", () => ({ ProcurementRegistry: () => null }));
vi.mock("./modules/scanner/Scanner", () => ({ Scanner: () => null }));
vi.mock("./modules/archive/Archive", () => ({ Archive: () => null }));
vi.mock("./modules/dashboard/Dashboard", () => ({ Dashboard: () => null }));
vi.mock("./modules/tender-calendar/TenderCalendar", () => ({ TenderCalendar: () => null }));
vi.mock("./modules/search/GlobalSearch", () => ({ GlobalSearch: () => null }));
vi.mock("./modules/status/StatusCenter", () => ({ StatusCenter: () => null }));
vi.mock("./modules/status/StatusIndicator", () => ({ StatusIndicator: () => null }));
vi.mock("./modules/settings/NetworkDiagnosticsPanel", () => ({ NetworkDiagnosticsPanel: () => null, NetworkOfflineNotice: () => null }));
vi.mock("./components/AdministrationNotice", () => ({ AdministrationNotice: () => null }));

type Props = Record<string, unknown> & { children?: ReactNode; hidden?: boolean; onClick?: () => void };
let tree: ReactNode;
const workspace = (root = "/test/ProductData"): WorkspaceInfo => ({ root, portable: false, configured: true, writable: true, editor: true, editorBusy: true, accessControlled: false, accessMessage: "test", schemaVersion: 3, freeSpaceBytes: 100000 });
function render() { runtime.cursor = 0; runtime.changed = false; tree = App(); for (const effect of runtime.effects.splice(0)) effect(); }
async function flush() { for (let index = 0; index < 35; index++) { await Promise.resolve(); if (runtime.changed) render(); } }
function nodes(node: ReactNode = tree): ReactElement<Props>[] { if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null)); if (!isValidElement<Props>(node)) return []; return [node, ...nodes(node.props.children ?? null)]; }
function text(node: ReactNode): string { if (Array.isArray(node)) return node.map(text).join(""); if (isValidElement<Props>(node)) return text(node.props.children); return typeof node === "string" || typeof node === "number" ? String(node) : ""; }
function child<T>(component: unknown): ReactElement<NonNullable<T>> { const found = nodes().find((node) => node.type === component); if (!found) throw new Error("Missing component"); return found as unknown as ReactElement<NonNullable<T>>; }
const workbench = () => child<Parameters<typeof import("./modules/intelligence/IntelligenceWorkbench").IntelligenceWorkbench>[0]>(runtime.Workbench);
const proposal = () => child<Parameters<typeof Proposals>[0]>(Proposals);
function wrapper(component: unknown) { return nodes().find((node) => Array.isArray(node.props.children) ? node.props.children.some((value) => isValidElement(value) && value.type === component) : isValidElement(node.props.children) && node.props.children.type === component)!; }
async function navigate(label: string) { const node = nodes().find((entry) => entry.type === "button" && text(entry.props.children) === label); if (!node?.props.onClick) throw new Error(`Missing navigation ${label}`); node.props.onClick(); await flush(); }
function handoff(resultId = "resultA", root = "/test/ProductData"): Extract<IntelligenceHandoff, { destination: "proposals" }> {
  const taskOrigin: TaskDocumentOrigin = { taskId: "taskA", resultId, workspaceRoot: root, sourceSnapshotKey: `sha256:${"a".repeat(64)}`, baseResultRevision: 1 };
  return { id: `handoff-${resultId}`, workspaceRoot: root, provenance: "test", destination: "proposals", taskOrigin, data: defaultProposal() };
}
function accepted(request: ReturnType<typeof handoff>): ProposalTaskSessionChange {
  const origin = request.taskOrigin!; let session = createTaskDocumentSession(origin, proposalTaskFingerprint(request.data));
  const attempt = { origin, workspaceRoot: origin.workspaceRoot, attempt: 1, snapshot: session.current };
  session = reduceTaskDocumentSession(session, { type: "queued", operation: "open", ...attempt });
  session = reduceTaskDocumentSession(session, { type: "accepted", ...attempt });
  return { session, data: request.data, writeId: "writeA" };
}

beforeEach(async () => {
  runtime.slots = []; runtime.effects = []; runtime.phase = "connected"; runtime.workspace.mockResolvedValue(workspace());
  const storage = new Map([["sbk-tools:last-tool", "intelligence"]]);
  const events = new EventTarget();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal("window", { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events), setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {} });
  vi.stubGlobal("document", { querySelector: () => null });
  render(); await flush();
});
afterEach(() => { for (const slot of runtime.slots) slot.cleanup?.(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("App task document routing", () => {
  it("opens an origin-bound proposal inside AI, with one stable receiver and no invented acceptance", async () => {
    const initialWorkbench = workbench(); const request = handoff(); initialWorkbench.props.onTransfer(request); await flush();
    expect(nodes().filter((node) => node.type === Proposals)).toHaveLength(1);
    expect(proposal().props.handoff?.taskOrigin).toEqual(request.taskOrigin);
    expect(proposal().props.presentation).toBe("ai-task"); expect(proposal().props.active).toBe(true);
    expect(workbench().key).toBe(initialWorkbench.key); expect(workbench().props.active).toBe(false);
    expect(workbench().props.taskDocumentSessions).toEqual([]);
    expect(text(tree)).toContain("Открываем выбранный результат задачи");
    const receiverKey = wrapper(Proposals).key;
    proposal().props.onHandoffConsumed!(); await flush();
    expect(workbench().props.taskDocumentSessions).toEqual([]);
    proposal().props.onTaskSessionChange!(accepted(request)); await flush();
    expect(text(tree)).not.toContain("Открываем выбранный результат задачи");
    expect(workbench().props.taskDocumentSessions).toHaveLength(1);
    proposal().props.onReturnToTask!(); await flush();
    expect(workbench().props.active).toBe(true); expect(proposal().props.active).toBe(false);
    expect(wrapper(Proposals).key).toBe(receiverKey); expect(nodes().filter((node) => node.type === Proposals)).toHaveLength(1);
    expect(wrapper(Proposals).props.hidden).toBe(true);
  });

  it("keeps task session projections while visiting other tools and reuses the same receiver", async () => {
    const request = handoff(); workbench().props.onTransfer(request); await flush();
    proposal().props.onTaskSessionChange!(accepted(request)); await flush(); const receiverKey = wrapper(Proposals).key;
    await navigate("Кадры"); expect(proposal().props.active).toBe(false);
    await navigate("Рабочее окно ИИ"); expect(proposal().props.presentation).toBe("ai-task"); expect(proposal().props.active).toBe(true);
    expect(wrapper(Proposals).key).toBe(receiverKey); expect(workbench().props.taskDocumentSessions).toHaveLength(1);
    proposal().props.onReturnToTask!(); await flush(); workbench().props.onTransfer(request); await flush();
    expect(wrapper(Proposals).key).toBe(receiverKey); expect(text(tree)).not.toContain("Открываем выбранный результат задачи");
  });

  it("does not let consumed A clear a later B handoff", async () => {
    workbench().props.onTransfer(handoff()); await flush(); const consumedA = proposal().props.onHandoffConsumed!;
    workbench().props.onTransfer(handoff("resultB")); await flush(); consumedA(); await flush();
    expect(proposal().props.handoff?.id).toBe("handoff-resultB");
  });

  it.each([
    ["contracts", ContractsRegistry], ["staff", StaffRegistry],
    ["counterparties", CounterpartiesRegistry], ["procurement", ProcurementRegistry],
  ] as const)("preserves the existing %s receiver route", async (destination, component) => {
    // App routes an opaque DTO; the destination's component tests validate it.
    const request = { ...handoff(), destination, taskOrigin: undefined } as unknown as IntelligenceHandoff;
    workbench().props.onTransfer(request); await flush();
    expect(child<{ intelligenceHandoff: IntelligenceHandoff }>(component).props.intelligenceHandoff).toBe(request);
    expect(nodes().filter((node) => node.type === Proposals)).toHaveLength(0);
    expect(workbench().props.active).toBe(false);
  });

  it("does not route a handoff when edit access was revoked", async () => {
    await navigate("Настройки"); child<Parameters<typeof Settings>[0]>(Settings).props.onWorkspaceChange({ ...workspace(), editor: false }); await flush();
    expect(() => workbench().props.onTransfer(handoff())).toThrow(/режим редактора/);
    expect(nodes().filter((node) => node.type === Proposals)).toHaveLength(0);
  });

  it("keeps legacy calculator and origin-less proposal routes in the ordinary registry", async () => {
    const request = handoff(); delete request.taskOrigin; workbench().props.onTransfer(request); await flush();
    expect(proposal().props.presentation).toBe("registry"); expect(proposal().props.active).toBe(true);
    await navigate("Тендерный калькулятор"); child<Parameters<typeof Calculator>[0]>(Calculator).props.onCreateProposal!(defaultProposal()); await flush();
    expect(proposal().props.presentation).toBe("registry"); expect(proposal().props.handoff?.taskOrigin).toBeUndefined();
  });

  it("rejects wrong-root origins and clears task projections on workspace change", async () => {
    const wrong = handoff(); wrong.taskOrigin = { ...wrong.taskOrigin!, workspaceRoot: "/other/ProductData" };
    expect(() => workbench().props.onTransfer(wrong)).toThrow(/Происхождение/);
    const request = handoff(); workbench().props.onTransfer(request); await flush(); const late = proposal().props.onTaskSessionChange!;
    await navigate("Настройки"); child<Parameters<typeof Settings>[0]>(Settings).props.onWorkspaceChange(workspace("/other/ProductData")); await flush();
    late(accepted(request)); await flush(); await navigate("Рабочее окно ИИ");
    expect(workbench().props.taskDocumentSessions).toEqual([]); expect(proposal().props.active).toBe(false); expect(proposal().props.handoff).toBeUndefined();
  });
});
