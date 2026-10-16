import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../../components/Dialog";
import type { StoredRecord } from "../../lib/storage";
import { ProcurementEditor } from "./Procurement";
import { Stage2Workspace } from "./Stage2Workspace";
import { emptyProcurement, type ProcurementData, type SnapshotLink } from "./types";

const runtime = vi.hoisted(() => ({
  cursor: 0, changed: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>,
  effects: [] as Array<() => void>,
}));
vi.mock("react", async (original) => {
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = runtime.cursor++, old = runtime.slots[index];
    if (!old || !old.deps || !deps || old.deps.length !== deps.length || old.deps.some((value, i) => !Object.is(value, deps[i]))) runtime.slots[index] = { value: factory(), deps };
    return runtime.slots[index].value;
  };
  return {
    ...await original<typeof import("react")>(),
    useState: (initial: unknown) => {
      const index = runtime.cursor++;
      if (!runtime.slots[index]) runtime.slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [runtime.slots[index].value, (next: unknown) => {
        const value = typeof next === "function" ? next(runtime.slots[index].value) : next;
        if (!Object.is(value, runtime.slots[index].value)) { runtime.slots[index].value = value; runtime.changed = true; }
      }];
    },
    useRef: (initial: unknown) => { const index = runtime.cursor++; if (!runtime.slots[index]) runtime.slots[index] = { value: { current: initial } }; return runtime.slots[index].value; },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = runtime.cursor++, old = runtime.slots[index];
      if (old?.deps && deps && old.deps.length === deps.length && old.deps.every((value, i) => Object.is(value, deps[i]))) return;
      runtime.slots[index] = { ...old, deps };
      runtime.effects.push(() => { old?.cleanup?.(); const cleanup = effect(); runtime.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; });
    },
  };
});
vi.mock("../../hooks/useRecords", () => ({ useRecords: () => ({ records: [], loading: false, error: null }) }));

type Props = {
  children?: ReactNode; disabled?: boolean; value?: string; className?: string; id?: string; role?: string;
  "aria-label"?: string; "aria-invalid"?: boolean; "aria-required"?: string; "aria-describedby"?: string;
  ref?: ((element: unknown) => void) | { current: unknown };
  onClick?: () => unknown; onChange?: (event: { target: { value: string } }) => void;
  onConfirm?: () => unknown; onClose?: () => void;
};
type EditorProps = Parameters<typeof ProcurementEditor>[0];
let props: EditorProps;
let tree: ReactNode;
let target: EventTarget;
const saved = vi.fn(), closed = vi.fn();
const hostElements = new Map<string, { focus: ReturnType<typeof vi.fn>; scrollIntoView: ReturnType<typeof vi.fn> }>();
function render() {
  runtime.cursor = 0; runtime.changed = false; tree = ProcurementEditor(props);
  for (const node of nodes()) {
    const key = node.props.id || node.props["aria-label"];
    if (!node.props.ref || !key) continue;
    if (!hostElements.has(key)) hostElements.set(key, { focus: vi.fn(), scrollIntoView: vi.fn() });
    if (typeof node.props.ref === "function") node.props.ref(hostElements.get(key));
    else node.props.ref.current = hostElements.get(key);
  }
  for (const effect of runtime.effects.splice(0)) effect();
}
async function flush() { for (let i = 0; i < 24; i += 1) { await Promise.resolve(); if (runtime.changed) render(); } }
function nodes(node: ReactNode = tree): ReactElement<Props>[] { if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null)); if (!isValidElement<Props>(node)) return []; return [node, ...nodes(node.props.children ?? null)]; }
function text(node: ReactNode = tree): string { if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join(""); if (isValidElement<Props>(node)) return text(node.props.children ?? null); return typeof node === "string" || typeof node === "number" ? String(node) : ""; }
function button(label: string) { const result = nodes().find((node) => node.type === "button" && text(node) === label); if (!result) throw new Error(`Button missing: ${label}`); return result; }
function fieldInput(labelText: string) { const label = nodes().find((node) => node.type === "label" && text(node).startsWith(labelText))!; return nodes(label).find((node) => node.type === "input" || node.type === "textarea")!; }
function nameInput() { return fieldInput("Название *"); }
function fieldHost(label: string) { return hostElements.get(fieldInput(label).props.id!)!; }
function validationSummary() { return nodes().find((node) => node.props["aria-label"] === "Ошибки сохранения закупки"); }
function recommendations() { return nodes().find((node) => node.props["aria-label"] === "Рекомендации по закупке"); }
function stage() { return nodes().find((node) => node.type === Stage2Workspace) as unknown as ReactElement<{ item: ProcurementData; onChange: (next: ProcurementData) => void }>; }
function confirm() { return nodes().find((node) => node.type === ConfirmDialog); }
function escape() { const event = new Event("keydown", { cancelable: true }); Object.defineProperty(event, "key", { value: "Escape" }); target.dispatchEvent(event); return event; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const link: SnapshotLink = { id: "snapshot", sourceModule: "calculator", sourceId: "calculation", title: "Зафиксированная цена", capturedAt: "2026-09-17T10:00:00Z", snapshot: { cost: 10 } };

beforeEach(() => {
  runtime.cursor = 0; runtime.changed = false; runtime.slots = []; runtime.effects = [];
  hostElements.clear();
  saved.mockReset().mockResolvedValue(undefined); closed.mockReset();
  const record: StoredRecord<ProcurementData> = { id: "procurement", title: "Закупка", archived: false, createdAt: "2026-09-17T10:00:00Z", updatedAt: "2026-09-17T10:00:00Z", payload: { ...emptyProcurement(), name: "Закупка", customer: "Заказчик", subject: "Работы", nmc: 100, calculations: [structuredClone(link)] } };
  props = { record, onSave: saved, onClose: closed, readOnly: false };
  target = new EventTarget();
  vi.stubGlobal("window", { addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target) });
});
afterEach(() => { for (const slot of runtime.slots) slot.cleanup?.(); vi.unstubAllGlobals(); });

describe("procurement save and close lifecycle", () => {
  it("saves an unknown-NMC draft without converting it to a known price", async () => {
    props = { initialValue: { ...emptyProcurement(), name: "Извещение без НМЦ", customer: "Заказчик", subject: "Аудит", notes: "НМЦ в источнике не указана" }, onSave: saved, onClose: closed };
    render(); await flush();
    const nmcLabel = nodes().find((node) => node.type === "label" && text(node).trim() === "НМЦ")!;
    expect(nodes(nmcLabel).find((node) => node.type === "input")!.props.value).toBe("");
    expect(text(recommendations())).toContain("в черновике её можно заполнить позже");
    expect(text(recommendations())).toContain("не блокируют сохранение");
    button("Сохранить закупку").props.onClick!(); await flush();
    expect(saved).toHaveBeenCalledOnce();
    expect(saved.mock.calls[0][0]).toMatchObject({ status: "Черновик", nmc: 0, notes: "НМЦ в источнике не указана" });
  });

  it.each([[-1, "Черновик"], [Number.NaN, "Черновик"], [0, "Подготовка"], [0, "Подана"]] as const)("does not waive invalid/required NMC for %s and %s", async (nmc, status) => {
    props = { initialValue: { ...emptyProcurement(), name: "Закупка", customer: "Заказчик", subject: "Аудит", nmc, status }, onSave: saved, onClose: closed };
    render(); await flush(); button("Сохранить закупку").props.onClick!(); await flush();
    expect(saved).not.toHaveBeenCalled(); expect(validationSummary()).toBeDefined();
    expect(text(validationSummary())).toContain("НМЦ должна быть больше нуля");
  });
  it("opens an intelligence result as an unsaved new card and saves only on the normal action", async () => {
    const seed = { ...emptyProcurement(), name: "Закупка из ИИ", customer: "Заказчик", subject: "Услуги", nmc: 250_000, notes: "Источник: тестовый документ" };
    props = { initialValue: seed, onSave: saved, onClose: closed };
    render(); await flush();
    expect(nameInput().props.value).toBe("Закупка из ИИ");
    expect(stage().props.item.notes).toBe("Источник: тестовый документ");
    expect(saved).not.toHaveBeenCalled();
    nameInput().props.onChange!({ target: { value: "Проверенная закупка" } }); await flush();
    expect(seed.name).toBe("Закупка из ИИ");
    button("Сохранить закупку").props.onClick!(); await flush();
    expect(saved).toHaveBeenCalledOnce();
    expect(saved.mock.calls[0][0]).toMatchObject({ name: "Проверенная закупка", nmc: 250_000, notes: seed.notes });
    expect(saved.mock.calls[0][1]).toBeUndefined();
  });

  it("does not let an intelligence seed replace the payload of an existing record", async () => {
    props = { ...props, initialValue: { ...emptyProcurement(), name: "Чужой ответ ИИ", nmc: 999 } };
    render(); await flush();
    expect(nameInput().props.value).toBe("Закупка");
    expect(stage().props.item.nmc).toBe(100);
    expect(saved).not.toHaveBeenCalled();
  });

  it("blocks same-tick duplicate saves and stale mutation handlers until the write finishes", async () => {
    const writing = deferred<void>(); saved.mockReturnValueOnce(writing.promise);
    render();
    const save = button("Сохранить закупку").props.onClick!;
    const changeName = nameInput().props.onChange!;
    const previousStage = stage().props;
    save(); save();
    changeName({ target: { value: "Не должно попасть в запись" } });
    previousStage.onChange({ ...previousStage.item, notes: "Отложенный результат" });
    await flush();
    expect(saved).toHaveBeenCalledOnce();
    expect(nameInput().props.value).toBe("Закупка");
    expect(stage().props.item.notes).toBe("");
    expect(button("Сохраняем…").props.disabled).toBe(true);
    writing.resolve(); await flush();
    expect(text()).toContain("Закупка сохранена в рабочей папке");
    expect(button("Сохранить закупку").props.disabled).toBe(false);
  });

  it("preserves dirty form data after a failure and permits one explicit retry", async () => {
    saved.mockRejectedValueOnce(new Error("Сеть недоступна"));
    render(); nameInput().props.onChange!({ target: { value: "Исправленная закупка" } }); await flush();
    button("Сохранить закупку").props.onClick!(); await flush();
    expect(text()).toContain("Закупка не сохранена");
    expect(text()).toContain("Сеть недоступна");
    expect(text()).toContain("есть несохранённые изменения");
    expect(nameInput().props.value).toBe("Исправленная закупка");
    expect(closed).not.toHaveBeenCalled();
    button("Сохранить закупку").props.onClick!(); await flush();
    expect(saved).toHaveBeenCalledTimes(2);
    expect(saved.mock.calls[1][0].name).toBe("Исправленная закупка");
    expect(saved.mock.calls[1][0].calculations).toEqual([link]);
    expect(text()).not.toContain("есть несохранённые изменения");
  });

  it("does not let the hook's internal Escape close a clean form during a pending save", async () => {
    const writing = deferred<void>(); saved.mockReturnValueOnce(writing.promise);
    render(); button("Сохранить закупку").props.onClick!();
    expect(escape().defaultPrevented).toBe(true); await flush();
    escape(); button("Закрыть").props.onClick!(); await flush();
    expect(closed).not.toHaveBeenCalled();
    writing.resolve(); await flush(); escape();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("protects an already-open discard callback if saving starts before confirmation", async () => {
    const writing = deferred<void>(); saved.mockReturnValueOnce(writing.promise);
    render(); nameInput().props.onChange!({ target: { value: "Несохранённое" } }); await flush();
    escape(); await flush();
    const discard = confirm()!.props.onConfirm!;
    button("Сохранить закупку").props.onClick!();
    discard(); await flush(); escape();
    expect(closed).not.toHaveBeenCalled();
    const unload = new Event("beforeunload", { cancelable: true });
    target.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    writing.reject(new Error("Сеть недоступна")); await flush();
    escape(); await flush();
    expect(confirm()).toBeDefined();
    confirm()!.props.onConfirm!();
    expect(closed).toHaveBeenCalledOnce();
  });

  it("rejects stale field, snapshot, expert and save callbacks after edit rights are lost", async () => {
    render();
    const changeName = nameInput().props.onChange!;
    const save = button("Сохранить закупку").props.onClick!;
    const expert = stage().props;
    button("3 Цена").props.onClick!(); await flush();
    const selection = nodes().find((node) => typeof node.type === "function" && node.type.name === "LinkSelection") as ReactElement<{
      addLink: (key: "calculations", value: SnapshotLink) => void;
      remove: (key: "calculations", id: string) => void;
    }>;
    props = { ...props, readOnly: true }; render();
    changeName({ target: { value: "Запрещённая правка" } });
    selection.props.addLink("calculations", { ...link, id: "new", sourceId: "new" });
    selection.props.remove("calculations", link.id);
    expert.onChange({ ...expert.item, notes: "Запоздалая обработка документа" });
    save(); await flush();
    expect(saved).not.toHaveBeenCalled();
    expect(stage().props.item.name).toBe("Закупка");
    expect(stage().props.item.notes).toBe("");
    expect(stage().props.item.calculations).toEqual([link]);
    expect(text()).toContain("Режим просмотра");
  });
});

describe("procurement required-field feedback", () => {
  beforeEach(() => {
    props = { initialValue: emptyProcurement(), onSave: saved, onClose: closed };
  });

  it("marks each missing required field after Save and separates errors from optional NMC advice", async () => {
    render(); await flush();
    expect(nameInput().props["aria-invalid"]).toBe(false);
    expect(validationSummary()).toBeUndefined();
    expect(fieldHost("Название *").focus).not.toHaveBeenCalled();
    button("Сохранить закупку").props.onClick!(); await flush();
    for (const [label, message] of [["Название *", "Укажите название закупки."], ["Заказчик *", "Укажите заказчика."], ["Предмет *", "Укажите предмет закупки."]]) {
      const input = fieldInput(label);
      expect(input.props["aria-required"]).toBe("true");
      expect(input.props["aria-invalid"]).toBe(true);
      const hint = nodes().find((node) => node.props.id === input.props["aria-describedby"]);
      expect(text(hint)).toBe(message);
      expect(hint?.props.className).toContain("procurement-field-error");
    }
    expect(validationSummary()?.props.role).toBe("alert");
    expect(text(validationSummary())).toContain("Укажите название закупки.");
    expect(text(validationSummary())).not.toContain("НМЦ");
    expect(text(recommendations())).toContain("НМЦ не указана");
    expect(text(recommendations())).not.toContain("Укажите название");
    expect(text()).not.toContain("Черновик можно сохранить");
    expect(fieldHost("Название *").focus).toHaveBeenCalledOnce();
    expect(fieldHost("Название *").scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(saved).not.toHaveBeenCalled();
  });

  it.each(["name", "customer", "subject"] as const)("focuses the first missing %s field, including whitespace-only input", async (missing) => {
    const labels = { name: "Название *", customer: "Заказчик *", subject: "Предмет *" };
    props = { ...props, initialValue: { ...emptyProcurement(), name: "Закупка", customer: "Заказчик", subject: "Услуги", [missing]: " \n\t " } };
    render(); await flush(); button("Сохранить закупку").props.onClick!(); await flush();
    expect(fieldInput(labels[missing]).props["aria-invalid"]).toBe(true);
    expect(fieldHost(labels[missing]).focus).toHaveBeenCalledOnce();
    for (const key of ["name", "customer", "subject"] as const) {
      if (key !== missing) {
        expect(fieldInput(labels[key]).props["aria-invalid"]).toBe(false);
        expect(fieldHost(labels[key]).focus).not.toHaveBeenCalled();
      }
    }
    expect(saved).not.toHaveBeenCalled();
  });

  it("returns from another workflow stage before focusing the required card field", async () => {
    render(); await flush(); button("3 Цена").props.onClick!(); await flush();
    expect(nodes().some((node) => node.props.id?.endsWith("-name"))).toBe(false);
    button("Сохранить закупку").props.onClick!(); await flush();
    expect(nameInput()).toBeDefined();
    expect(fieldHost("Название *").focus).toHaveBeenCalledOnce();
    expect(saved).not.toHaveBeenCalled();
  });

  it("clears corrected field hints without stealing focus and permits a normal unknown-NMC draft save", async () => {
    render(); await flush(); button("Сохранить закупку").props.onClick!(); await flush();
    nameInput().props.onChange!({ target: { value: "Новая закупка" } }); await flush();
    expect(nameInput().props["aria-invalid"]).toBe(false);
    expect(nameInput().props["aria-describedby"]).toBeUndefined();
    expect(nodes().filter((node) => node.props.className?.includes("procurement-field-error"))).toHaveLength(2);
    expect(fieldHost("Заказчик *").focus).not.toHaveBeenCalled();
    button("Сохранить закупку").props.onClick!(); await flush();
    expect(fieldHost("Заказчик *").focus).toHaveBeenCalledOnce();
    fieldInput("Заказчик *").props.onChange!({ target: { value: "Заказчик" } }); await flush();
    fieldInput("Предмет *").props.onChange!({ target: { value: "Услуги" } }); await flush();
    expect(validationSummary()).toBeUndefined();
    expect(fieldInput("НМЦ").props["aria-required"]).toBeUndefined();
    button("Сохранить закупку").props.onClick!(); await flush();
    expect(saved).toHaveBeenCalledOnce();
    expect(saved.mock.calls[0][0]).toMatchObject({ name: "Новая закупка", customer: "Заказчик", subject: "Услуги", status: "Черновик", nmc: 0 });
    expect(text()).toContain("Закупка сохранена в рабочей папке");
  });

  it("keeps existing non-required validation blocking and focuses its error summary", async () => {
    props = { ...props, initialValue: { ...emptyProcurement(), name: "Закупка", customer: "Заказчик", subject: "Услуги", nmc: -1 } };
    render(); await flush(); button("Сохранить закупку").props.onClick!(); await flush();
    expect(text(validationSummary())).toContain("НМЦ должна быть больше нуля");
    expect(recommendations()).toBeUndefined();
    expect(hostElements.get("Ошибки сохранения закупки")?.focus).toHaveBeenCalledOnce();
    expect(nameInput().props["aria-invalid"]).toBe(false);
    expect(saved).not.toHaveBeenCalled();
  });

  it("does not focus or expose editor validation when a stale Save callback loses editing rights", async () => {
    render(); await flush(); const save = button("Сохранить закупку").props.onClick!;
    props = { ...props, readOnly: true }; render(); await flush(); save(); await flush();
    expect(validationSummary()).toBeUndefined();
    expect(nameInput().props["aria-invalid"]).toBe(false);
    expect(fieldHost("Название *").focus).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });
});
