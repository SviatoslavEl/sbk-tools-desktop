import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalSourcePricingReview } from "./ProposalSourcePricingReview";
import { createProposal, createProposalLine } from "./defaults";
import { createProposalSourceFinancials, type ProposalSourceFinancialCandidate } from "./sourcePricing";

const hooks = vi.hoisted(() => ({ index: 0, values: [] as unknown[] }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => { const index = hooks.index++; if (!(index in hooks.values)) hooks.values[index] = initial; return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }]; } }));
type Props = { children?: ReactNode; value?: unknown; disabled?: boolean; checked?: boolean; type?: string; onClick?: () => void; onChange?: (event: { target: { value: string; checked: boolean } }) => void };
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("") : isValidElement<Props>(node) ? text(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "";
function find(node: ReactNode, check: (type: unknown, props: Props) => boolean): Props | undefined { if (Array.isArray(node)) { for (const child of node) { const result = find(child, check); if (result) return result; } } else if (isValidElement<Props>(node)) { if (check(node.type, node.props)) return node.props; return find(node.props.children, check); } }
const event = (checked: boolean, value = "") => ({ target: { value, checked } });
const candidate = (id = "source-price-a"): ProposalSourceFinancialCandidate => ({ id, sourceId: "doc-a", sourceName: "Договор", locator: "Абзац 3", quote: "Цена комплекса 1220 рублей с НДС 22%", sourceKind: "contract", scope: "aggregate", currency: "RUB", gross: "1220", tax: { kind: "vat", rate: 22 }, issues: [] });
beforeEach(() => { hooks.index = 0; hooks.values = []; });

function setup(options: { several?: boolean; disabled?: boolean; prices?: boolean; unknownTax?: boolean } = {}) {
  let data = createProposal(); data.title = "Проверка"; data.issuer.name = "Исполнитель"; data.recipient.name = "Заказчик";
  data.lines = [{ ...createProposalLine(), title: "Анализ", description: "Полный объём", unitPrice: options.prices ? "10" : "" }];
  const first = candidate(); if (options.unknownTax) first.tax = { kind: "unknown" };
  data.sourceFinancials = createProposalSourceFinancials(options.several ? [first, candidate("source-price-b")] : [first]);
  const onChange = vi.fn((next) => { data = next; });
  const render = () => { hooks.index = 0; return ProposalSourcePricingReview({ data, onChange, disabled: options.disabled }); };
  const button = (label: string) => find(render(), (type, props) => type === "button" && text(props.children) === label)!;
  const check = (label: string, checked = true) => find(render(), (type, props) => type === "label" && text(props.children).includes(label)) && find(find(render(), (type, props) => type === "label" && text(props.children).includes(label))!.children, (type) => type === "input")!.onChange!(event(checked));
  return { get data() { return data; }, render, onChange, button, check };
}

describe("source-price UI requires human applicability decision", () => {
  it("cannot apply from a model/source fact alone, then preserves complete scope after explicit confirmations", () => {
    const ui = setup(); const apply = () => ui.button("Использовать исходную цену");
    expect(apply().disabled).toBe(true); apply().onClick!(); expect(ui.onChange).not.toHaveBeenCalled();
    ui.check("Подтверждаю: это тот же проект"); expect(apply().disabled).toBe(true);
    ui.check("одну сводную позицию"); expect(apply().disabled).toBe(false); apply().onClick!();
    expect(ui.onChange).toHaveBeenCalledOnce(); expect(ui.data.lines[0]).toMatchObject({ quantity: "1", unit: "комплекс", unitPrice: "1220", description: "Анализ\nПолный объём" });
    expect(text(ui.render())).toContain("после вашей проверки");
  });
  it("clears confirmations when scope or selected candidate changes", () => {
    const ui = setup({ several: true }); const select = () => find(ui.render(), (type) => type === "select")!;
    expect(select().value).toBe(""); select().onChange!(event(false, "source-price-a")); ui.check("Подтверждаю: это тот же проект"); ui.check("одну сводную позицию");
    expect(ui.button("Использовать исходную цену").disabled).toBe(false);
    ui.data.lines[0].description += " другой объём"; expect(ui.button("Использовать исходную цену").disabled).toBe(true);
    ui.check("Подтверждаю: это тот же проект"); ui.check("одну сводную позицию"); select().onChange!(event(false, "source-price-b"));
    expect(ui.button("Использовать исходную цену").disabled).toBe(true);
  });
  it("requires another explicit decision before replacing manually entered prices", () => {
    const ui = setup({ prices: true }); ui.check("Подтверждаю: это тот же проект"); ui.check("одну сводную позицию");
    expect(ui.button("Использовать исходную цену").disabled).toBe(true); ui.check("Заменить уже введённые цены");
    expect(ui.button("Использовать исходную цену").disabled).toBe(false);
  });
  it("lets a specialist decline source pricing without modifying their prices", () => {
    const ui = setup({ prices: true }); ui.button("Не использовать · введу свою цену").onClick!();
    expect(ui.data.lines[0].unitPrice).toBe("10"); expect(ui.data.sourceFinancials?.decision?.kind).toBe("not-used");
  });
  it("keeps unknown tax unresolved and read-only mode unable to mutate data", () => {
    const unknown = setup({ unknownTax: true }); expect(text(unknown.render())).toContain("НДС в источнике не определён"); expect(unknown.button("Использовать исходную цену").disabled).toBe(true);
    hooks.values = []; const readonly = setup({ disabled: true }); readonly.button("Не использовать · введу свою цену").onClick!(); expect(readonly.onChange).not.toHaveBeenCalled();
  });
});
