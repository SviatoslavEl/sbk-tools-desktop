import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalAnalysisProvenance } from "./ProposalAnalysisProvenance";
import type { ProposalQuoteProvenance } from "./proposalQuotePreparation";

const hooks = vi.hoisted(() => ({ cursor: 0, states: [] as unknown[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => {
    const at = hooks.cursor++;
    if (hooks.states.length <= at) hooks.states[at] = initial;
    return [hooks.states[at], (next: unknown) => { hooks.states[at] = next; }];
  },
}));
type Element = ReactElement<Record<string, unknown>>;
let tree: ReactNode;
let value: ProposalQuoteProvenance;
const quote = "Выполнить исследование с сохранением всех ограничений доступа.";
const raw = '{"unchanged":"PRIVATE RAW QUOTE SELECTION"}';
const walk = (node: ReactNode): Element[] => Array.isArray(node) ? node.flatMap(walk)
  : isValidElement<Record<string, unknown>>(node) ? [node, ...walk(node.props.children as ReactNode)] : [];
const text = (node: ReactNode): string => Array.isArray(node) ? node.map(text).join("")
  : isValidElement<Record<string, unknown>>(node) ? text(node.props.children as ReactNode)
    : typeof node === "string" || typeof node === "number" ? String(node) : "";
function render(next: ProposalQuoteProvenance | null | undefined = value) { hooks.cursor = 0; tree = ProposalAnalysisProvenance({ value: next }); }
function toggle(label: string, open: boolean) {
  const section = walk(tree).find(node => node.type === "details" && walk(node.props.children as ReactNode).find(child => child.type === "summary")?.props.children
    && text(walk(node.props.children as ReactNode).find(child => child.type === "summary")!.props.children as ReactNode).startsWith(label));
  expect(section).toBeDefined();
  (section!.props.onToggle as (event: { currentTarget: { open: boolean } }) => void)({ currentTarget: { open } }); render();
}
beforeEach(() => {
  hooks.cursor = 0; hooks.states = [];
  value = { version: 1, origin: "model-selected-quotes", sourceSnapshotKey: `sha256:${"a".repeat(64)}`,
    parts: [{ batchId: "batch-1", model: "fixture-model", raw }],
    selections: [{ unitId: "p-1", fragmentId: "p-1", sourceId: "s", locator: "Абзац 2", quote, roles: ["scope"] }],
    counts: { units: 2, commercial: 1, context: 0, unclear: 1, batches: 1 }, projectedItemId: "proposal-1" };
});
describe("private historical model provenance panel", () => {
  it("is absent for legacy records and never mounts raw or quote text while closed", () => {
    render(null); expect(tree).toBeNull();
    hooks.cursor = 0; expect(ProposalAnalysisProvenance({})).toBeNull();
    render(); expect(text(tree)).toContain("выбрано 1 из 2"); expect(text(tree)).not.toContain(raw); expect(text(tree)).not.toContain(quote);
  });
  it("lazily displays exact originals separately and labels them as historical, not current approval", () => {
    render(); toggle("Участие ИИ", true);
    expect(text(tree)).toContain("Ручные правки после этого не проверены заново");
    expect(text(tree)).toContain("не доказывают"); expect(text(tree)).not.toContain(raw); expect(text(tree)).not.toContain(quote);
    toggle("Цитаты, выбранные моделью", true); expect(text(tree)).toContain(quote); expect(text(tree)).not.toContain(raw);
    toggle("Исходные ответы ИИ", true); expect(walk(tree).filter(node => node.type === "pre").map(node => node.props.children)).toEqual([raw]);
    expect(text(tree)).toContain("Состав работ");
    toggle("Участие ИИ", false); expect(text(tree)).not.toContain(raw); expect(text(tree)).not.toContain(quote);
    toggle("Участие ИИ", true); expect(text(tree)).not.toContain(raw); expect(text(tree)).not.toContain(quote);
  });
  it("closes old details after a different receipt and does not mutate stored history", () => {
    const before = structuredClone(value); render(); toggle("Участие ИИ", true); toggle("Исходные ответы ИИ", true);
    value = structuredClone(value); render(); expect(text(tree)).not.toContain(raw); expect(value).toEqual(before);
  });
  it("does not display a malformed receipt as a model or completeness success", () => {
    value.counts.commercial = 8; render(); expect(text(tree)).toContain("повреждён");
    expect(walk(tree).some(node => node.type === "details")).toBe(false); expect(text(tree)).not.toContain(raw);
  });
});
