import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProcurementProposalSource } from "./ProcurementProposalSource";
import { emptyProcurement, emptyScenario } from "../procurement/types";

const hooks = vi.hoisted(() => ({ index: 0, values: [] as unknown[] }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => { const index = hooks.index++; if (!(index in hooks.values)) hooks.values[index] = initial; return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }]; } }));
type Props = { children?: ReactNode; value?: unknown; disabled?: boolean; checked?: boolean; type?: string; onClick?: () => void; onChange?: (event: { target: { value: string; checked: boolean } }) => void };
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("") : isValidElement<Props>(node) ? text(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "";
function find(node: ReactNode, check: (type: unknown, props: Props) => boolean): Props | undefined { if (Array.isArray(node)) { for (const child of node) { const result = find(child, check); if (result) return result; } } else if (isValidElement<Props>(node)) { if (check(node.type, node.props)) return node.props; return find(node.props.children, check); } }
const event = (value: string, checked = false) => ({ target: { value, checked } });
beforeEach(() => { hooks.index = 0; hooks.values = []; });

describe("procurement price source actual UI confirmation", () => {
  const setup = () => {
    const data = { ...emptyProcurement(), name: "Закупка", subject: "Аудит", customer: "Заказчик", nmc: 9_000_000, notes: "PRIVATE", participationScenarios: [
      { ...emptyScenario(), id: "loss-a", name: "Убыточный A", customerPriceGross: 500, directCosts: 1000, vatRate: 0 },
      { ...emptyScenario(), id: "loss-b", name: "Убыточный B", customerPriceGross: 600, directCosts: 1000, vatRate: 0 },
      { ...emptyScenario(), id: "profit", name: "Прибыльный", customerPriceGross: 1500, directCosts: 1000, vatRate: 0 },
    ] };
    const onCreate = vi.fn(), onClose = vi.fn();
    const render = () => { hooks.index = 0; return ProcurementProposalSource({ data, recordId: "procurement-id", onCreate, onClose }); };
    const choose = (id: string) => find(render(), (type) => type === "select")!.onChange!(event(id));
    const confirm = (checked: boolean) => find(render(), (type, props) => type === "input" && props.type === "checkbox")!.onChange!(event("", checked));
    const create = () => find(render(), (type, props) => type === "button" && text(props.children) === "Создать черновик КП")!;
    return { data, render, choose, confirm, create, onCreate, onClose };
  };
  it("has no default price and does not silently substitute NMC", () => {
    const ui = setup(); expect(ui.create().disabled).toBe(true); ui.create().onClick!();
    expect(ui.onCreate).not.toHaveBeenCalled(); expect(text(ui.render())).toContain("Выберите существующий сценарий");
  });
  it("blocks a loss-making source until its explicit checkbox is checked", () => {
    const ui = setup(); ui.choose("scenario:loss-a"); expect(ui.create().disabled).toBe(true);
    ui.create().onClick!(); expect(ui.onCreate).not.toHaveBeenCalled();
    ui.confirm(true); expect(ui.create().disabled).toBe(false); ui.create().onClick!();
    expect(ui.onCreate).toHaveBeenCalledOnce(); expect(ui.onCreate.mock.calls[0][0].lines[0].unitPrice).toBe("500.00");
    expect(ui.onCreate.mock.calls[0][0].internalNote).toBe(""); expect(ui.onCreate.mock.calls[0][0]).not.toHaveProperty("directCosts");
  });
  it("resets the consent when a different source is selected", () => {
    const ui = setup(); ui.choose("scenario:loss-a"); ui.confirm(true); ui.choose("scenario:loss-b");
    expect(ui.create().disabled).toBe(true); ui.create().onClick!(); expect(ui.onCreate).not.toHaveBeenCalled();
    ui.confirm(true); ui.create().onClick!(); expect(ui.onCreate.mock.calls[0][0].lines[0].unitPrice).toBe("600.00");
  });
  it("permits a profitable source without loss confirmation and preserves the source record", () => {
    const ui = setup(); const original = structuredClone(ui.data); ui.choose("scenario:profit");
    expect(ui.create().disabled).toBe(false); ui.create().onClick!();
    expect(ui.onCreate.mock.calls[0][0].source.recordId).toBe("procurement-id"); expect(ui.data).toEqual(original);
  });
  it("cancellation returns without creating a proposal", () => {
    const ui = setup(); ui.choose("scenario:loss-a"); ui.confirm(true);
    find(ui.render(), (type, props) => type === "button" && text(props.children) === "Отмена")!.onClick!();
    expect(ui.onClose).toHaveBeenCalledOnce(); expect(ui.onCreate).not.toHaveBeenCalled();
  });
  it("rejects a removed source instead of exporting the previously selected price", () => {
    const ui = setup(); ui.choose("scenario:loss-a"); ui.confirm(true); ui.data.participationScenarios = [];
    ui.create().onClick!(); expect(ui.onCreate).not.toHaveBeenCalled(); expect(text(ui.render())).toContain("Выберите существующий сценарий");
  });
});
