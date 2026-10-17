import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StaffOptionalDateField } from "./StaffOptionalDateField";

const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[] }>,
  effects: [] as Array<() => void>,
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!hooks.slots[index]) hooks.slots[index] = { value: typeof initial === "function" ? initial() : initial };
    return [hooks.slots[index].value, (next: unknown) => {
      hooks.slots[index].value = typeof next === "function" ? next(hooks.slots[index].value) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!hooks.slots[index]) hooks.slots[index] = { value: { current: initial } };
    return hooks.slots[index].value;
  },
  useId: () => {
    const index = hooks.cursor++;
    if (!hooks.slots[index]) hooks.slots[index] = { value: `optional-date-${index}` };
    return hooks.slots[index].value;
  },
  useEffect: (effect: () => void, deps: readonly unknown[]) => {
    const index = hooks.cursor++, old = hooks.slots[index];
    if (old?.deps && old.deps.length === deps.length && old.deps.every((value, i) => Object.is(value, deps[i]))) return;
    hooks.slots[index] = { ...old, deps };
    hooks.effects.push(effect);
  },
}));

type NodeProps = {
  children?: ReactNode; id?: string; htmlFor?: string; type?: string; value?: string;
  disabled?: boolean; readOnly?: boolean; "aria-label"?: string;
  ref?: { current: { focus: (options?: FocusOptions) => void } | null };
  onClick?: () => void;
  onChange?: (event: { target: { value: string } }) => void;
  onKeyDown?: (event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => void;
};
let props: Parameters<typeof StaffOptionalDateField>[0];
let tree: ReactNode;
let inputFocus: ReturnType<typeof vi.fn>;
let intentFocus: ReturnType<typeof vi.fn>;
function nodes(node: ReactNode = tree): ReactElement<NodeProps>[] {
  if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null));
  return isValidElement<NodeProps>(node) ? [node, ...nodes(node.props.children ?? null)] : [];
}
function text(node: ReactNode = tree): string {
  if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join("");
  return isValidElement<NodeProps>(node) ? text(node.props.children ?? null) : typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function render() {
  hooks.cursor = 0;
  tree = StaffOptionalDateField(props);
  for (const node of nodes()) {
    if (node.props.ref) node.props.ref.current = { focus: node.type === "input" ? inputFocus : intentFocus };
  }
  for (const effect of hooks.effects.splice(0)) effect();
  return tree;
}
function input() { return nodes().find((node) => node.type === "input"); }
function button(label: string) {
  const node = nodes().find((entry) => entry.type === "button" && entry.props["aria-label"] === `${label}: ${props.label}`);
  expect(node, label).toBeDefined();
  return node!;
}
function change(value: string) { input()!.props.onChange!({ target: { value } }); render(); }

beforeEach(() => {
  hooks.cursor = 0; hooks.slots = []; hooks.effects = [];
  inputFocus = vi.fn(); intentFocus = vi.fn();
  props = { label: "Дата экзамена", value: "", onChange: vi.fn((value: string) => { props = { ...props, value }; }) };
});

describe("StaffOptionalDateField", () => {
  it("shows an explicit unset value without mounting a native date or writing today's date", () => {
    render();
    expect(text()).toContain("Не указана");
    expect(input()).toBeUndefined();
    expect(button("Указать дату").props.type).toBe("button");
    expect(props.onChange).not.toHaveBeenCalled();
    expect(inputFocus).not.toHaveBeenCalled();
  });

  it("opens and focuses an empty controlled native date only after explicit intent", () => {
    render(); button("Указать дату").props.onClick!(); render();
    expect(input()!.props).toMatchObject({ type: "date", value: "", "aria-label": "Дата экзамена" });
    expect(nodes().find((node) => node.type === "label")!.props.htmlFor).toBe(input()!.props.id);
    expect(inputFocus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(props.onChange).not.toHaveBeenCalled();
    render(); expect(inputFocus).toHaveBeenCalledOnce();
  });

  it("forwards complete dates without re-focusing on each controlled update", () => {
    render(); button("Указать дату").props.onClick!(); render();
    change("2031-04-02");
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith("2031-04-02");
    expect(input()!.props.value).toBe("2031-04-02");
    expect(inputFocus).toHaveBeenCalledOnce();
    expect(nodes().some((node) => node.props["aria-label"] === "Оставить без даты: Дата экзамена")).toBe(false);
  });

  it("retains the empty native input while a partial date is being entered, then cancels without fabricating a value", () => {
    render(); button("Указать дату").props.onClick!(); render();
    change(""); change("");
    expect(input()!.props.value).toBe("");
    expect(props.onChange).toHaveBeenNthCalledWith(1, "");
    expect(props.onChange).toHaveBeenNthCalledWith(2, "");
    button("Оставить без даты").props.onClick!(); render();
    expect(input()).toBeUndefined(); expect(text()).toContain("Не указана");
    expect(props.onChange).toHaveBeenCalledTimes(2);
    expect(intentFocus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it("cancels an empty input on Escape without closing the surrounding editor", () => {
    render(); button("Указать дату").props.onClick!(); render();
    const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    input()!.props.onKeyDown!(event); render();
    expect(input()).toBeUndefined(); expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce(); expect(props.onChange).not.toHaveBeenCalled();
  });

  it("keeps filled native inputs and clears explicitly back to the unset state", () => {
    props = { ...props, label: "Дата выдачи", value: "2030-01-10" }; render();
    expect(input()!.props).toMatchObject({ type: "date", value: "2030-01-10", "aria-label": "Дата выдачи" });
    expect(inputFocus).not.toHaveBeenCalled();
    change("2030-01-11"); expect(input()!.props.value).toBe("2030-01-11");
    button("Очистить дату").props.onClick!(); render();
    expect(props.onChange).toHaveBeenLastCalledWith(""); expect(input()).toBeUndefined();
    expect(text()).toContain("Не указана");
  });

  it("does not unmount a filled native field when native clearing emits an empty value", () => {
    props = { ...props, value: "2031-04-02" }; render(); change("");
    expect(input()!.props.value).toBe(""); expect(text()).toContain("Не указана");
    button("Оставить без даты").props.onClick!(); render(); expect(input()).toBeUndefined();
  });

  it.each(["disabled", "readOnly"] as const)("does not allow opening or changing a %s field", (permission) => {
    props = { ...props, [permission]: true }; render();
    expect(button("Указать дату").props.disabled).toBe(true);
    button("Указать дату").props.onClick!(); render(); expect(input()).toBeUndefined();
    props = { ...props, value: "2031-04-02" }; render();
    expect(input()!.props[permission]).toBe(true);
    input()!.props.onChange!({ target: { value: "2032-01-01" } });
    expect(props.onChange).not.toHaveBeenCalled();
    expect(nodes().some((node) => node.props["aria-label"] === "Очистить дату: Дата экзамена")).toBe(false);
  });

  it("does not autofocus if edit access is revoked before the intended input mounts", () => {
    render(); button("Указать дату").props.onClick!();
    props = { ...props, disabled: true }; render();
    expect(inputFocus).not.toHaveBeenCalled(); expect(props.onChange).not.toHaveBeenCalled();
  });
});
