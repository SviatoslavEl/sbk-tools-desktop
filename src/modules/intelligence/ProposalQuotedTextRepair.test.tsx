import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalQuotedTextRepair } from "./ProposalQuotedTextRepair";

const hooks = vi.hoisted(() => ({ cursor: 0, changed: false, slots: [] as unknown[], deps: [] as unknown[], effects: [] as Array<() => void> }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => {
  const index = hooks.cursor++; if (hooks.slots.length <= index) hooks.slots[index] = initial;
  return [hooks.slots[index], (value: unknown) => { if (!Object.is(value, hooks.slots[index])) { hooks.changed = true; hooks.slots[index] = value; } }];
}, useRef: (initial: unknown) => { const index = hooks.cursor++; if (hooks.slots.length <= index) hooks.slots[index] = { current: initial }; return hooks.slots[index]; }, useEffect: (effect: () => void, deps: unknown[]) => {
  const index = hooks.cursor++, previous = hooks.deps[index] as unknown[] | undefined;
  if (!previous || deps.some((value, at) => !Object.is(value, previous[at]))) { hooks.deps[index] = deps; hooks.effects.push(effect); }
} }));
type Element = ReactElement<Record<string, unknown>>;
type Props = Parameters<typeof ProposalQuotedTextRepair>[0];
let props: Props, tree: ReactNode;
const quote = "По согласованию сторон выдать результат на основе представленных материалов. При этом услуги оплачиваются полностью.";
function render(next: Partial<Props> = {}) { props = { ...props, ...next }; for (let index = 0; index < 10; index++) { hooks.cursor = 0; hooks.changed = false; tree = ProposalQuotedTextRepair(props); for (const effect of hooks.effects.splice(0)) effect(); if (!hooks.changed) break; } }
function walk(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  return isValidElement<Record<string, unknown>>(node) ? [node, ...walk(node.props.children as ReactNode)] : [];
}
function elements(node: ReactNode = tree) { return walk(node); }
function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<Record<string, unknown>>(node)) return textOf(node.props.children as ReactNode);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
function text(node: ReactNode = tree) { return textOf(node); }
function button(label: string) { const found = elements().find(node => node.type === "button" && text(node) === label); expect(found).toBeDefined(); return found!; }
function click(label: string) { const node = button(label); if (!node.props.disabled) (node.props.onClick as () => void)(); render(); }
const preview = () => click("Сверить поле с полными цитатами");
const apply = () => click("Заменить поле дословными цитатами");

beforeEach(() => {
  hooks.cursor = 0; hooks.slots = []; hooks.deps = []; hooks.effects = [];
  props = { field: "deliveryTerms", label: "Сроки и условия", sources: [{ id: "s", name: "Источник", text: quote, fragments: [{ id: "a", locator: "Условие A", text: quote }] }],
    item: { id: "p", destination: "proposals", title: "КП", sourceIds: ["s"], fields: { deliveryTerms: "Исполнитель вправе выбрать решение", internalNote: "Не менять" }, selectedFields: ["deliveryTerms"], evidence: [{ field: "deliveryTerms", sourceId: "s", fragmentId: "a", quote }] },
    onApply: vi.fn() };
});

describe("explicit quotation repair UI", () => {
  it("does not parse or change a card on mount or preview; shows whole quotes and a replacement warning", () => {
    const before = structuredClone(props.item); render();
    expect(text()).not.toContain(quote); expect(props.onApply).not.toHaveBeenCalled();
    preview(); expect(text()).toContain(quote); expect(text()).toContain("Текущий текст поля будет заменён");
    expect(text()).toContain("не доказывают полноту"); expect(props.onApply).not.toHaveBeenCalled(); expect(props.item).toEqual(before);
  });
  it("replaces only on the explicit action and keeps other fields and source text", () => {
    const before = structuredClone({ item: props.item, sources: props.sources }); render(); preview(); apply();
    expect(props.onApply).toHaveBeenCalledTimes(1);
    const patch = vi.mocked(props.onApply).mock.calls[0][0];
    expect(patch.fields.deliveryTerms).toBe(quote); expect(patch.fields.internalNote).toBe("Не менять");
    expect({ item: props.item, sources: props.sources }).toEqual(before);
    expect(text()).not.toContain("Текущий текст поля будет заменён");
  });
  it("cancels without changing anything", () => { render(); preview(); click("Отмена замены"); expect(props.onApply).not.toHaveBeenCalled(); expect(text()).not.toContain(quote); });
  it("revokes captured apply callbacks after cancel, disable or replacement and consumes a choice once", () => {
    render(); preview(); const oldApply = button("Заменить поле дословными цитатами").props.onClick as () => void;
    click("Отмена замены"); oldApply(); expect(props.onApply).not.toHaveBeenCalled();
    preview(); const disabledApply = button("Заменить поле дословными цитатами").props.onClick as () => void;
    render({ disabled: true }); disabledApply(); expect(props.onApply).not.toHaveBeenCalled();
    render({ disabled: false }); preview(); const replacedApply = button("Заменить поле дословными цитатами").props.onClick as () => void;
    render({ item: { ...props.item } }); replacedApply(); expect(props.onApply).not.toHaveBeenCalled();
    preview(); const once = button("Заменить поле дословными цитатами").props.onClick as () => void;
    once(); once(); expect(props.onApply).toHaveBeenCalledTimes(1);
  });
  it("invalidates the preview when item/source identities change", () => {
    render(); preview(); render({ item: { ...props.item, fields: { deliveryTerms: "Новая редакция" } } });
    expect(text()).not.toContain("Текущий текст поля будет заменён"); expect(props.onApply).not.toHaveBeenCalled();
    preview(); render({ sources: structuredClone(props.sources) });
    expect(text()).not.toContain("Текущий текст поля будет заменён");
  });
  it("rejects same-object stale source snapshots and stale field values before calling the parent", () => {
    render(); preview(); props.sources[0].text += " Новый текст"; apply();
    expect(props.onApply).not.toHaveBeenCalled(); expect(elements().some(node => node.props.role === "alert")).toBe(true);
    preview(); props.item.fields.deliveryTerms = "Изменённое поле"; apply(); expect(props.onApply).not.toHaveBeenCalled();
  });
  it("handles parent stale/access errors locally and offers a new preview", () => {
    render({ onApply: vi.fn(() => { throw new Error("Карточка изменилась"); }) }); preview();
    expect(() => apply()).not.toThrow(); expect(text()).toContain("Карточка изменилась"); button("Сверить поле с полными цитатами");
  });
  it("blocks preview/apply when disabled and never provides quotation repair for names/prices", () => {
    render({ disabled: true }); preview(); expect(text()).not.toContain(quote); expect(props.onApply).not.toHaveBeenCalled();
    render({ disabled: false }); preview(); const oldApply = button("Заменить поле дословными цитатами").props.onClick as () => void; render({ disabled: true }); oldApply(); expect(props.onApply).not.toHaveBeenCalled();
    render({ field: "issuerName" }); expect(tree).toBeNull();
  });
});
