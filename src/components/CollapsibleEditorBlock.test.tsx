import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollapsibleEditorBlock } from "./CollapsibleEditorBlock";

// Exercise state transitions without a DOM dependency, using the same hook
// harness as the editor/session tests. Native focus is asserted through the ref.
const hooks = vi.hoisted(() => ({
  cursor: 0, changed: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }>,
  effects: [] as Array<() => void>,
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!hooks.slots[index]) hooks.slots[index] = { value: typeof initial === "function" ? initial() : initial };
    return [hooks.slots[index].value, (next: unknown) => {
      const value = typeof next === "function" ? next(hooks.slots[index].value) : next;
      if (!Object.is(value, hooks.slots[index].value)) { hooks.slots[index].value = value; hooks.changed = true; }
    }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!hooks.slots[index]) hooks.slots[index] = { value: { current: initial } };
    return hooks.slots[index].value;
  },
  useId: () => {
    const index = hooks.cursor++;
    if (!hooks.slots[index]) hooks.slots[index] = { value: `editor-block-test-${index}` };
    return hooks.slots[index].value;
  },
  useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = hooks.cursor++, previous = hooks.slots[index];
    if (previous?.deps && deps && previous.deps.length === deps.length && previous.deps.every((value, i) => Object.is(value, deps[i]))) return;
    hooks.slots[index] = { ...previous, deps };
    hooks.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.slots[index].cleanup = typeof cleanup === "function" ? cleanup : undefined; });
  },
}));

type Props = {
  children?: ReactNode; hidden?: boolean; id?: string; type?: string; value?: string; defaultValue?: string;
  "aria-expanded"?: boolean; "aria-controls"?: string;
  ref?: { current: { focus: () => void } | null };
  onClick?: () => void; onInvalidCapture?: (event: { target: { focus: () => void }; preventDefault: () => void }) => void;
};
let props: Parameters<typeof CollapsibleEditorBlock>[0];
let tree: ReactNode;
function render() {
  hooks.cursor = 0; hooks.changed = false;
  tree = CollapsibleEditorBlock(props);
  for (const effect of hooks.effects.splice(0)) effect();
}
async function flush() {
  for (let i = 0; i < 12; i += 1) { await Promise.resolve(); if (hooks.changed) render(); }
}
function nodes(node: ReactNode = tree): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap((child) => nodes(child ?? null));
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children ?? null)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map((child) => text(child ?? null)).join("");
  if (isValidElement<Props>(node)) return text(node.props.children ?? null);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function header() {
  const node = nodes().find((entry) => entry.type === "button" && typeof entry.props["aria-expanded"] === "boolean");
  if (!node) throw new Error("Accessible block header missing");
  return node;
}
function content() {
  const node = nodes().find((entry) => entry.props.id === header().props["aria-controls"]);
  if (!node) throw new Error("Header must control a mounted content region");
  return node;
}
function footer() {
  const node = nodes().find((entry) => entry.type === "button" && text(entry) === "Свернуть блок");
  if (!node) throw new Error("Collapse button missing");
  return node;
}

beforeEach(() => {
  hooks.cursor = 0; hooks.changed = false; hooks.slots = []; hooks.effects = [];
  props = { title: "Контактные данные", summary: "Телефон и почта", children: <input defaultValue="Введённое значение" /> };
  const frame = (callback: FrameRequestCallback) => { callback(0); return 1; };
  vi.stubGlobal("requestAnimationFrame", frame);
  vi.stubGlobal("window", { requestAnimationFrame: frame, setTimeout, clearTimeout });
});
afterEach(() => { for (const slot of hooks.slots) slot.cleanup?.(); vi.unstubAllGlobals(); });

describe("CollapsibleEditorBlock", () => {
  it("starts collapsed, exposes summary and links a non-submit header to mounted content", async () => {
    render(); await flush();
    expect(header().props["aria-expanded"]).toBe(false);
    expect(header().props.type).toBe("button");
    expect(header().props["aria-controls"]).toBeTruthy();
    expect(content().props.hidden).toBe(true);
    expect(text(tree)).toContain("Контактные данные");
    expect(text(tree)).toContain("Телефон и почта");
    expect(nodes().find((entry) => entry.type === "input")).toBe(props.children);
  });

  it("toggles repeatedly without removing or recreating the editor children", async () => {
    const editor = <textarea defaultValue={"Несохранённый черновик\nВторая строка"} />;
    props = { ...props, children: editor };
    render(); await flush();
    const id = content().props.id;
    for (const expanded of [true, false, true, false]) {
      header().props.onClick?.(); await flush();
      expect(header().props["aria-expanded"]).toBe(expanded);
      expect(content().props.hidden).toBe(!expanded);
      expect(content().props.id).toBe(id);
      expect(nodes().find((entry) => entry.type === "textarea")).toBe(editor);
      expect(nodes().find((entry) => entry.type === "textarea")?.props.defaultValue).toBe("Несохранённый черновик\nВторая строка");
    }
  });

  it("does not implicitly collapse or reopen when defaultExpanded changes during editing", async () => {
    props = { ...props, defaultExpanded: true }; render(); await flush();
    expect(content().props.hidden).toBe(false);
    props = { ...props, defaultExpanded: false, children: <input value="Новое введённое значение" readOnly /> };
    render(); await flush();
    expect(content().props.hidden).toBe(false);
    header().props.onClick?.(); await flush();
    props = { ...props, defaultExpanded: true }; render(); await flush();
    expect(content().props.hidden).toBe(true);
    expect(nodes().find((entry) => entry.type === "input")?.props.value).toBe("Новое введённое значение");
  });

  it("initially reveals validation errors and reveals each new nonzero validation key without locking the block open", async () => {
    props = { ...props, revealKey: 1 }; render(); await flush();
    expect(content().props.hidden).toBe(false);
    header().props.onClick?.(); await flush();
    expect(content().props.hidden).toBe(true);
    render(); await flush(); // Same key must not undo a deliberate collapse.
    expect(content().props.hidden).toBe(true);
    props = { ...props, revealKey: 2 }; render(); await flush();
    expect(content().props.hidden).toBe(false);
    props = { ...props, revealKey: 0 }; render(); await flush();
    expect(content().props.hidden).toBe(false);
    header().props.onClick?.(); await flush();
    props = { ...props, revealKey: 3 }; render(); await flush();
    expect(content().props.hidden).toBe(false);
  });

  it("reveals hidden native-invalid fields while retaining their data", async () => {
    render(); await flush();
    const handler = nodes().find((entry) => entry.props.onInvalidCapture)?.props.onInvalidCapture;
    expect(handler).toBeTypeOf("function");
    handler?.({ target: { focus: vi.fn() }, preventDefault: vi.fn() }); await flush();
    expect(content().props.hidden).toBe(false);
    expect(nodes().find((entry) => entry.type === "input")).toBe(props.children);
  });

  it("collapses from the footer and returns keyboard focus to the header", async () => {
    props = { ...props, defaultExpanded: true }; render(); await flush();
    const focus = vi.fn();
    expect(header().props.ref).toBeDefined();
    header().props.ref!.current = { focus };
    expect(footer().props.type).toBe("button");
    footer().props.onClick?.(); await flush();
    expect(content().props.hidden).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });
});
