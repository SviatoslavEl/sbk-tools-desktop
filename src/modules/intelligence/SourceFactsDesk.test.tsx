import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceFactsDesk } from "./SourceFactsDesk";
import { collectSourceFacts } from "./sourceFactsWorker";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const hooks = vi.hoisted(() => ({ cursor: 0, changed: false,
  slots: [] as Array<{ value?: unknown; deps?: readonly unknown[] }>, effects: [] as Array<() => void>,
}));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useState: (initial: unknown) => { const index = hooks.cursor++; if (!hooks.slots[index]) hooks.slots[index] = { value: initial }; return [hooks.slots[index].value, (next: unknown) => { const value = typeof next === "function" ? next(hooks.slots[index].value) : next; if (!Object.is(value, hooks.slots[index].value)) { hooks.slots[index].value = value; hooks.changed = true; } }]; },
  useEffect: (effect: () => void, deps: readonly unknown[]) => { const index = hooks.cursor++, previous = hooks.slots[index]; if (previous?.deps?.length === deps.length && deps.every((value, at) => Object.is(value, previous.deps![at]))) return; hooks.slots[index] = { deps }; hooks.effects.push(effect); },
}));

type Element = ReactElement<Record<string, unknown>>;
type Props = Parameters<typeof SourceFactsDesk>[0];
let props: Props, tree: ReactNode;
const source = (text: string, id = "source-a"): IntelligenceSource => ({ id, name: `Синтетический источник ${id}`, text, fragments: [{ id: "page-1", locator: "Страница 1", text }] });
const card = (fields: IntelligenceItem["fields"] = {}, destination: IntelligenceItem["destination"] = "procurement"): IntelligenceItem => ({ id: "card-a", title: "QA", destination, fields, selectedFields: Object.keys(fields), sourceIds: ["source-a"], evidence: [] });
function render(next: Partial<Props> = {}) { props = { ...props, ...next }; for (let index = 0; index < 20; index++) { hooks.cursor = 0; hooks.changed = false; tree = SourceFactsDesk(props); for (const effect of hooks.effects.splice(0)) effect(); if (!hooks.changed) break; } }
function walk(value: ReactNode): Element[] { if (Array.isArray(value)) return value.flatMap(walk); if (!isValidElement<Record<string, unknown>>(value)) return []; const element = value as Element; return [element, ...walk(element.props.children as ReactNode)]; }
function elements(value: ReactNode = tree) { return walk(value); }
function textOf(value: ReactNode): string { if (Array.isArray(value)) return value.map(textOf).join(""); if (isValidElement<Record<string, unknown>>(value)) return textOf(value.props.children as ReactNode); return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function button(label: string): Element { const found = elements().find((element) => element.type === "button" && textOf(element) === label); expect(found, label).toBeDefined(); return found!; }
function click(element: Element) { if (!element.props.disabled) (element.props.onClick as () => void)(); render(); }
function open() { (elements()[0].props.onToggle as (event: unknown) => void)({ currentTarget: { open: true } }); render(); }
function change(element: Element, value: string | boolean) { (element.props.onChange as (event: unknown) => void)({ target: typeof value === "boolean" ? { checked: value } : { value } }); render(); }
function checkboxes() { return elements().filter((element) => element.type === "input" && element.props.type === "checkbox"); }
function select(label: string) { const element = elements().find((entry) => entry.type === "select" && entry.props["aria-label"] === label); expect(element).toBeDefined(); return element!; }
function useSources(sources: IntelligenceSource[], item = card()) { render({ sources, item, inventory: collectSourceFacts(sources) }); }

beforeEach(() => {
  hooks.cursor = 0; hooks.changed = false; hooks.slots = []; hooks.effects = [];
  props = { item: card(), sources: [], pending: false, failed: false, onRequest: vi.fn(), onRetry: vi.fn(), onApply: vi.fn() };
});

describe("SourceFactsDesk explicit RAM-only controls", () => {
  it("does not request or apply on mount; opening requests only, failure offers explicit retry", () => {
    render(); expect(elements()[0].props.open).toBe(false); expect(props.onRequest).not.toHaveBeenCalled(); expect(props.onApply).not.toHaveBeenCalled();
    open(); expect(props.onRequest).toHaveBeenCalledTimes(1); expect(props.onApply).not.toHaveBeenCalled();
    render({ pending: true }); expect(elements().some((element) => element.props.role === "status")).toBe(true);
    render({ pending: false, failed: true }); click(button("Повторить разбор источников"));
    expect(props.onRetry).toHaveBeenCalledTimes(1); expect(props.onApply).not.toHaveBeenCalled();
  });

  it("filters facts by selected source ownership and applies a date only on an explicit click", () => {
    const first = source("Редакция извещения от 01.08.2039\nСрок подачи: 03.08.2039 11:45 MSK"), foreign = source("Срок подачи: 04.08.2039 10:00 MSK", "foreign");
    const item = card({ submissionDeadline: "2039-07-01", notes: "Ручная заметка" }), before = structuredClone({ item, first, foreign });
    useSources([first, foreign], item); open();
    expect(textOf(tree)).toContain("2039-08-03"); expect(textOf(tree)).not.toContain("2039-08-04");
    expect(elements().filter((element) => element.type === "button" && textOf(element).startsWith("Использовать:"))).toHaveLength(1);
    expect(props.onApply).not.toHaveBeenCalled();
    click(elements().find((element) => element.type === "button" && textOf(element).startsWith("Использовать:"))!);
    expect(props.onApply).toHaveBeenCalledTimes(1);
    const patch = vi.mocked(props.onApply).mock.calls[0][0]; expect(patch.fields.submissionDeadline).toBe("2039-08-03"); expect(patch.fields.notes).toContain("Ручная заметка"); expect(patch.fields.notes).toContain("11:45 MSK");
    expect({ item, first, foreign }).toEqual(before);
  });

  it("shows ambiguous lot dates but prevents one-click application", () => {
    useSources([source("Лот 1: Сервер\nСрок подачи: 03.08.2039 11:45 MSK\nЛот 2: Аудит\nСрок подачи: 04.08.2039 15:30 MSK")]); open();
    const dates = elements().filter((element) => element.type === "button" && textOf(element).startsWith("Использовать:"));
    expect(dates).toHaveLength(2); expect(dates.every((element) => element.props.disabled)).toBe(true);
    expect(textOf(tree)).toContain("заполните поле вручную"); expect(props.onApply).not.toHaveBeenCalled();
  });

  it("catches rejected stale-card cleanup callbacks rather than throwing from the UI event", () => {
    render({ item: card({ name: "QA", notes: "null", submissionDeadline: "2110-26-16" }), onApply: vi.fn(() => { throw new Error("Карточка изменилась; повторите действие."); }) }); open();
    expect(() => click(button("Убрать заглушки и неверные даты (2)"))).not.toThrow();
    expect(textOf(tree)).toContain("Карточка изменилась; повторите действие."); expect(props.onApply).toHaveBeenCalledTimes(1);
    expect(props.item.fields.notes).toBe("null");
  });

  it("groups conditions by at most 100, blocks the 101st and replaces rather than appends groups", () => {
    const input = source(Array.from({ length: 130 }, (_, index) => `${index + 1}. Сертификат QA-${index + 1} — не менее 2 специалистов.`).join("\n"));
    useSources([input]); open(); expect(checkboxes()).toHaveLength(130);
    click(button("Выбрать группу 1–100")); expect(checkboxes().filter((element) => element.props.checked)).toHaveLength(100);
    expect(button("Добавить выбранные условия (100)").props.disabled).toBe(false);
    change(checkboxes()[100], true); expect(checkboxes()[100].props.checked).toBe(false); expect(textOf(tree)).toContain("За одно действие можно выбрать до 100 условий.");
    click(button("Выбрать группу 101–130")); expect(checkboxes().filter((element) => element.props.checked)).toHaveLength(30);
    expect(checkboxes()[0].props.checked).toBe(false); expect(checkboxes()[100].props.checked).toBe(true);
    expect(textOf(tree)).not.toContain("За одно действие можно выбрать до 100 условий.");
    expect(props.onApply).not.toHaveBeenCalled(); click(button("Добавить выбранные условия (30)"));
    const patch = vi.mocked(props.onApply).mock.calls[0][0]; expect(patch.fields.requirements).toHaveLength(30);
    expect((patch.fields.requirements as string[])[0]).toContain("QA-101"); expect((patch.fields.requirements as string[])[29]).toContain("QA-130");
    expect(checkboxes().some((element) => element.props.checked)).toBe(false);
  });

  it("adds only checked literal conditions, preserving qualifiers and the original card", () => {
    const input = source("1. Сертификат OSCP — не менее 5 специалистов.\n2. Копия доверенности, если подписывает представитель.\n3. Условия оплаты: 100% предоплата."), item = card({ requirements: ["Ручное требование"] }), before = structuredClone(item);
    useSources([input], item); open(); expect(button("Добавить выбранные условия (0)").props.disabled).toBe(true);
    change(checkboxes()[1], true); click(button("Добавить выбранные условия (1)"));
    const patch = vi.mocked(props.onApply).mock.calls[0][0]; expect(patch.fields.requirements).toEqual(["Ручное требование", "2. Копия доверенности, если подписывает представитель."]);
    expect(patch.fields.notes).toBeUndefined(); expect(item).toEqual(before);
    expect(patch.evidence?.some((entry) => entry.quote === "2. Копия доверенности, если подписывает представитель.")).toBe(true);
  });

  it("clears selections when inventory or selected source identities change", () => {
    useSources([source("1. Сертификат OSCP — не менее 5 специалистов.")]); open(); change(checkboxes()[0], true);
    expect(button("Добавить выбранные условия (1)").props.disabled).toBe(false);
    render({ inventory: collectSourceFacts(props.sources) }); expect(button("Добавить выбранные условия (0)").props.disabled).toBe(true);
    change(checkboxes()[0], true); render({ item: { ...props.item, sourceIds: [] } });
    expect(checkboxes()).toHaveLength(0); expect(textOf(tree)).toContain("Сначала выберите источники"); expect(props.onApply).not.toHaveBeenCalled();
  });

  it("requires both explicit SKU/configuration choices and preserves the complete description", () => {
    const description = Array.from({ length: 19 }, (_, index) => `- Альфа компонент ${index + 1} — 1 шт;`).join("\n");
    const input = source(`№ п/п Артикул Изготовитель\n1 QA-100_A шт 2\nУсловия оплаты: 100%\nСервер QA в составе:\n${description}`), item = card({}, "proposals");
    useSources([input], item); open(); const inventory = props.inventory!;
    expect(inventory.positions.positions).toHaveLength(1); expect(inventory.positions.configurations).toHaveLength(1);
    expect(button("Применить выбранный артикул и полный состав").props.disabled).toBe(true);
    change(select("Артикул для сопоставления"), inventory.positions.positions[0].id);
    expect(button("Применить выбранный артикул и полный состав").props.disabled).toBe(true);
    change(select("Состав для сопоставления"), inventory.positions.configurations[0].id);
    expect(props.onApply).not.toHaveBeenCalled(); click(button("Применить выбранный артикул и полный состав"));
    const patch = vi.mocked(props.onApply).mock.calls[0][0]; expect(patch.fields.lines).toEqual(["QA-100_A"]); expect(patch.fields.lineDescriptions).toEqual([inventory.positions.configurations[0].quote]); expect((patch.fields.lineDescriptions as string[])[0]).toContain(description); expect((patch.fields.lineDescriptions as string[])[0]).toContain("Сервер QA в составе:"); expect(item.fields).toEqual({});
  });

  it("passes the literal inventory snapshot when mapping, rejecting changed component content", () => {
    const input = source("№ п/п Артикул Изготовитель\n1 QA-100_A шт 2\nУсловия оплаты: 100%\nСервер QA в составе:\n- Альфа компонент 1 — 1 шт;\n- Альфа компонент 2 — 1 шт;");
    useSources([input], card({}, "proposals")); open(); const inventory = props.inventory!;
    change(select("Артикул для сопоставления"), inventory.positions.positions[0].id); change(select("Состав для сопоставления"), inventory.positions.configurations[0].id);
    render({ sources: [source(input.text.replace("Альфа компонент 1", "Другой компонент 1"))] });
    click(button("Применить выбранный артикул и полный состав"));
    expect(props.onApply).not.toHaveBeenCalled(); expect(textOf(tree)).toContain("изменились");
  });
});
