import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredRecord } from "../../lib/storage";
import { Calculator } from "./Calculator";
import { initialCalculatorData, type CalculatorData } from "./types";

// Run the real component's event handlers and effects, preserving hook slots
// across renders. This intentionally does not simulate DOM layout or children.
const runtime = vi.hoisted(() => ({
  cursor: 0,
  changed: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>,
  effects: [] as Array<() => void>,
  editor: true,
  store: { records: [] as StoredRecord<CalculatorData>[], loading: false, error: null as string | null, save: vi.fn(), archive: vi.fn(), reload: vi.fn() },
  readDraft: vi.fn(), saveDraft: vi.fn(), clearDraft: vi.fn(), importText: vi.fn(), exportText: vi.fn(), confirm: vi.fn(),
}));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const same = (left?: readonly unknown[], right?: readonly unknown[]) => left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const memo = (factory: () => unknown, deps?: readonly unknown[]) => {
    const index = runtime.cursor++;
    const slot = runtime.slots[index];
    if (!slot || !same(slot.deps, deps)) runtime.slots[index] = { value: factory(), deps };
    return runtime.slots[index].value;
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = runtime.cursor++;
      if (!runtime.slots[index]) runtime.slots[index] = { value: typeof initial === "function" ? initial() : initial };
      return [runtime.slots[index].value, (next: unknown) => {
        const value = typeof next === "function" ? next(runtime.slots[index].value) : next;
        if (!Object.is(value, runtime.slots[index].value)) { runtime.slots[index].value = value; runtime.changed = true; }
      }];
    },
    useRef: (initial: unknown) => {
      const index = runtime.cursor++;
      if (!runtime.slots[index]) runtime.slots[index] = { value: { current: initial } };
      return runtime.slots[index].value;
    },
    useMemo: memo,
    useCallback: (callback: unknown, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = runtime.cursor++;
      const previous = runtime.slots[index];
      if (previous && same(previous.deps, deps)) return;
      runtime.slots[index] = { ...previous, deps };
      runtime.effects.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        runtime.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined;
      });
    },
  };
});
vi.mock("../../hooks/useRecords", () => ({ useRecords: () => runtime.store }));
vi.mock("../../lib/workspaceAccess", () => ({ useWorkspaceAccess: () => ({ editor: runtime.editor, message: "Тестовый доступ" }) }));
vi.mock("../../lib/storage", () => ({ readDraft: runtime.readDraft, saveDraft: runtime.saveDraft, clearDraft: runtime.clearDraft }));
vi.mock("../../lib/files", () => ({ importText: runtime.importText, exportText: runtime.exportText }));

type Props = Parameters<typeof Calculator>[0];
type ElementProps = { children?: ReactNode; onClick?: () => unknown; onChange?: (event: { target: { value: string } }) => unknown; value?: unknown; disabled?: boolean; className?: string };
let tree: ReactNode;
let props: Props;

function render(next = props) {
  props = next;
  runtime.cursor = 0;
  runtime.changed = false;
  tree = Calculator(props);
  const effects = runtime.effects.splice(0);
  for (const effect of effects) effect();
}

async function flush() {
  // Chains include draft queue -> storage -> setState -> effect -> status.
  // Keep microtasks progressing even when an intermediate link has no update.
  for (let turn = 0; turn < 24; turn += 1) {
    await Promise.resolve();
    if (runtime.changed) render();
  }
}

function nodes(node: ReactNode = tree): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null));
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...nodes(node.props.children ?? null)];
}

function text(node: ReactNode = tree): string {
  if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join("");
  if (isValidElement<ElementProps>(node)) return text(node.props.children ?? null);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}

function button(label: string) {
  const value = nodes().find((node) => node.type === "button" && text(node.props.children) === label);
  if (!value) throw new Error(`Button missing: ${label}`);
  return value;
}

function nameInput() {
  const label = nodes().find((node) => node.type === "label" && text(node.props.children).startsWith("Название расчёта"));
  const input = nodes(label).find((node) => node.type === "input");
  if (!input) throw new Error("Calculation name input missing");
  return input;
}

function sessionDisabled() {
  return nodes().find((node) => node.type === "fieldset" && node.props.className?.includes("calculator-session"))?.props.disabled;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const payload = (name: string): CalculatorData => ({ ...structuredClone(initialCalculatorData), name });
const record = (id: string, name = id): StoredRecord<CalculatorData> => ({ id, title: name, payload: payload(name), archived: false, createdAt: "2026-09-17T10:00:00Z", updatedAt: "2026-09-17T10:00:00Z" });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-17T10:00:00Z"));
  runtime.cursor = 0; runtime.changed = false; runtime.slots = []; runtime.effects = []; runtime.editor = true;
  runtime.store.records = []; runtime.store.loading = false; runtime.store.error = null;
  for (const mock of [runtime.store.save, runtime.store.archive, runtime.store.reload, runtime.readDraft, runtime.saveDraft, runtime.clearDraft, runtime.importText, runtime.exportText, runtime.confirm]) mock.mockReset();
  runtime.readDraft.mockResolvedValue(null);
  runtime.saveDraft.mockResolvedValue(undefined);
  runtime.clearDraft.mockResolvedValue(undefined);
  runtime.store.save.mockImplementation(async (title: string, data: CalculatorData, id?: string) => ({ ...record(id || "created", title), payload: structuredClone(data) }));
  runtime.store.archive.mockResolvedValue(undefined);
  runtime.confirm.mockReturnValue(true);
  vi.stubGlobal("window", { confirm: runtime.confirm, setTimeout, clearTimeout });
  props = {};
});

afterEach(() => {
  for (const slot of runtime.slots) slot.cleanup?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("calculator session data safety", () => {
  it("never overwrites the new draft while a deep-linked registry loads slowly", async () => {
    runtime.store.loading = true;
    const consumed = vi.fn();
    render({ openRecordId: "linked", onRecordOpened: consumed });
    await flush();
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(sessionDisabled()).toBe(true);
    expect(runtime.readDraft).not.toHaveBeenCalled();
    expect(runtime.saveDraft).not.toHaveBeenCalled();
    runtime.store.records = [record("linked", "Запрошенный расчёт")];
    runtime.store.loading = false;
    render();
    await flush();
    expect(nameInput().props.value).toBe("Запрошенный расчёт");
    expect(runtime.readDraft).toHaveBeenCalledWith("calculator", "linked");
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(sessionDisabled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.saveDraft).not.toHaveBeenCalled();
  });

  it("blocks writes after an initial draft read failure and recovers only by explicit retry", async () => {
    runtime.readDraft.mockRejectedValueOnce(new Error("Сеть недоступна")).mockResolvedValueOnce(payload("Не потерять"));
    render(); await flush();
    expect(sessionDisabled()).toBe(true);
    expect(text()).toContain("Запись поверх него остановлена");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.saveDraft).not.toHaveBeenCalled();
    button("Повторить загрузку черновика").props.onClick?.();
    await flush();
    expect(nameInput().props.value).toBe("Не потерять");
    expect(sessionDisabled()).toBe(false);
    await vi.advanceTimersByTimeAsync(450); await flush();
    expect(runtime.saveDraft).toHaveBeenCalledWith("calculator", expect.objectContaining({ name: "Не потерять" }), "new");
  });

  it("does not let a late initial new-draft read replace a newly requested saved record", async () => {
    const oldRead = deferred<CalculatorData | null>();
    runtime.readDraft.mockImplementation((_module: string, id: string) => id === "new" ? oldRead.promise : Promise.resolve(null));
    runtime.store.records = [record("linked", "Нужная сохранённая запись")];
    render(); await flush();
    expect(sessionDisabled()).toBe(true);
    // The app keeps Calculator mounted while another tool is visible; a later
    // dashboard task can therefore target it before its initial read returns.
    render({ active: false }); await flush();
    render({ active: true, openRecordId: "linked" }); await flush();
    expect(nameInput().props.value).toBe("Нужная сохранённая запись");
    oldRead.resolve(payload("Старый отдельный черновик")); await flush();
    expect(nameInput().props.value).toBe("Нужная сохранённая запись");
    await vi.advanceTimersByTimeAsync(450); await flush();
    expect(runtime.saveDraft).not.toHaveBeenCalled();
  });

  it("honours the latest record request when the previous record's draft is still loading", async () => {
    const firstRead = deferred<CalculatorData | null>();
    runtime.store.records = [record("first", "Первый расчёт"), record("second", "Второй расчёт")];
    runtime.readDraft.mockImplementation((_module: string, id: string) => id === "first" ? firstRead.promise : Promise.resolve(null));
    const firstConsumed = vi.fn();
    const secondConsumed = vi.fn();
    render({ openRecordId: "first", onRecordOpened: firstConsumed }); await flush();
    expect(sessionDisabled()).toBe(true);
    render({ openRecordId: "second", onRecordOpened: secondConsumed }); await flush();
    firstRead.resolve(null); await flush();
    expect(nameInput().props.value).toBe("Второй расчёт");
    expect(firstConsumed).not.toHaveBeenCalled();
    expect(secondConsumed).toHaveBeenCalledOnce();
    expect(runtime.readDraft).toHaveBeenLastCalledWith("calculator", "second");
  });

  it("does not consume a failed deep link and retries the same record without overwriting any draft", async () => {
    runtime.store.records = [record("linked", "Нужный расчёт")];
    runtime.readDraft.mockRejectedValueOnce(new Error("Не удалось прочитать файл")).mockResolvedValueOnce(null);
    const consumed = vi.fn();
    render({ openRecordId: "linked", onRecordOpened: consumed }); await flush();
    expect(sessionDisabled()).toBe(true);
    expect(consumed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.saveDraft).not.toHaveBeenCalled();
    button("Повторить загрузку черновика").props.onClick?.(); await flush();
    expect(nameInput().props.value).toBe("Нужный расчёт");
    expect(consumed).toHaveBeenCalledOnce();
    expect(runtime.readDraft).toHaveBeenNthCalledWith(2, "calculator", "linked");
  });

  it("retains the same typed session while hidden and resumes without reading an older draft", async () => {
    render(); await flush();
    nameInput().props.onChange?.({ target: { value: "Последнее изменение" } });
    await flush();
    render({ active: false }); await flush();
    expect(nameInput().props.value).toBe("Последнее изменение");
    await vi.advanceTimersByTimeAsync(450); await flush();
    expect(runtime.saveDraft).toHaveBeenLastCalledWith("calculator", expect.objectContaining({ name: "Последнее изменение" }), "new");
    render({ active: true }); await flush();
    expect(nameInput().props.value).toBe("Последнее изменение");
    expect(runtime.readDraft).toHaveBeenCalledTimes(1);
  });

  it("requires explicit replacement consent for New and Import and preserves data when cancelled", async () => {
    runtime.readDraft.mockResolvedValue(payload("Рабочий черновик"));
    runtime.confirm.mockReturnValue(false);
    runtime.importText.mockResolvedValue({ content: JSON.stringify({ data: payload("Импортированный") }) });
    render(); await flush();
    button("Новый").props.onClick?.(); await flush();
    expect(runtime.confirm).toHaveBeenCalledWith(expect.stringContaining("Его черновик будет заменён"));
    expect(nameInput().props.value).toBe("Рабочий черновик");
    button("Импорт").props.onClick?.(); await flush();
    expect(runtime.confirm).toHaveBeenCalledTimes(2);
    expect(nameInput().props.value).toBe("Рабочий черновик");
    expect(text()).toContain("Замена черновика отменена");
  });

  it("serializes manual save after an already running draft and clears the draft only after database success", async () => {
    const draft = deferred<void>();
    runtime.saveDraft.mockReturnValueOnce(draft.promise);
    render(); await flush();
    nameInput().props.onChange?.({ target: { value: "Сохранить точно это" } }); await flush();
    await vi.advanceTimersByTimeAsync(450); await flush();
    const save = button("Сохранить в базу").props.onClick!;
    save(); save(); await flush();
    expect(sessionDisabled()).toBe(true);
    expect(runtime.store.save).not.toHaveBeenCalled();
    expect(runtime.clearDraft).not.toHaveBeenCalled();
    draft.resolve(); await flush();
    expect(runtime.store.save).toHaveBeenCalledTimes(1);
    expect(runtime.store.save).toHaveBeenCalledWith("Сохранить точно это", expect.objectContaining({ name: "Сохранить точно это" }), undefined);
    expect(runtime.clearDraft).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Совпадает с сохранённой записью");
    expect(sessionDisabled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000); await flush();
    expect(runtime.saveDraft).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Все изменения сохранены в общей базе");
  });

  it("leaves entered data and its draft intact after a failed database write and allows retry", async () => {
    runtime.store.save.mockRejectedValueOnce(new Error("Отказ записи в общую папку")).mockImplementationOnce(async (title: string, data: CalculatorData) => ({ ...record("created", title), payload: data }));
    render(); await flush();
    nameInput().props.onChange?.({ target: { value: "Важные данные" } }); await flush();
    button("Сохранить в базу").props.onClick?.(); await flush();
    expect(text()).toContain("Отказ записи в общую папку");
    expect(nameInput().props.value).toBe("Важные данные");
    expect(runtime.clearDraft).not.toHaveBeenCalled();
    expect(sessionDisabled()).toBe(false);
    button("Сохранить в базу").props.onClick?.(); await flush();
    expect(runtime.store.save).toHaveBeenCalledTimes(2);
    expect(runtime.clearDraft).toHaveBeenCalledOnce();
  });

  it("preserves the previous named draft before loading another saved calculation", async () => {
    runtime.store.records = [record("first"), record("second")];
    render({ openRecordId: "first" }); await flush();
    render({}); await flush();
    nameInput().props.onChange?.({ target: { value: "Изменения первого" } }); await flush();
    const switcher = nodes().find((node) => node.type === "select" && node.props.value === "first");
    switcher?.props.onChange?.({ target: { value: "second" } }); await flush();
    expect(runtime.saveDraft).toHaveBeenCalledWith("calculator", expect.objectContaining({ name: "Изменения первого" }), "first");
    expect(nameInput().props.value).toBe("second");
    expect(runtime.readDraft).toHaveBeenLastCalledWith("calculator", "second");
    expect(runtime.store.save).not.toHaveBeenCalled();
  });

  it("cancels a record switch if preserving the previous edited draft fails", async () => {
    runtime.store.records = [record("first"), record("second")];
    render({ openRecordId: "first" }); await flush();
    render({}); await flush();
    nameInput().props.onChange?.({ target: { value: "Несохранённая правка" } }); await flush();
    runtime.saveDraft.mockRejectedValueOnce(new Error("Черновик не записан"));
    const switcher = nodes().find((node) => node.type === "select" && node.props.value === "first");
    switcher?.props.onChange?.({ target: { value: "second" } }); await flush();
    expect(nameInput().props.value).toBe("Несохранённая правка");
    expect(text()).toContain("Черновик не записан");
    expect(runtime.readDraft).not.toHaveBeenCalledWith("calculator", "second");
    expect(sessionDisabled()).toBe(false);
  });

  it("keeps local viewer parameters and export available without any database or draft write", async () => {
    runtime.editor = false;
    runtime.exportText.mockResolvedValue(undefined);
    render(); await flush();
    nameInput().props.onChange?.({ target: { value: "Только локально" } }); await flush();
    render({ active: false }); await flush();
    await vi.advanceTimersByTimeAsync(1_000); await flush();
    expect(nameInput().props.value).toBe("Только локально");
    expect(button("Сохранить в базу").props.disabled).toBe(true);
    expect(button("Экспорт").props.disabled).toBe(false);
    button("Экспорт").props.onClick?.(); await flush();
    expect(runtime.exportText).toHaveBeenCalledOnce();
    expect(runtime.saveDraft).not.toHaveBeenCalled();
    expect(runtime.store.save).not.toHaveBeenCalled();
    expect(runtime.clearDraft).not.toHaveBeenCalled();
  });
});
