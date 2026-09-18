import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Stage2Workspace } from "./Stage2Workspace";
import { emptyProcurement, normalizeProcurement } from "./types";

const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = next; }];
  },
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => undefined,
}));
type Props = { children?: ReactNode; value?: unknown; role?: string; disabled?: boolean; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void };
function nodes(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(nodes);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...nodes(node.props.children)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<Props>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
describe("explicit procurement decision confirmation", () => {
  beforeEach(() => { hooks.cursor = 0; hooks.values = []; });
  it("does not persist a dropdown choice without explicit confirmation, including save/read roundtrip", () => {
    let item = emptyProcurement();
    const change = vi.fn((next) => { item = next; });
    const render = () => { hooks.cursor = 0; return Stage2Workspace({ item, onChange: change, section: "decision" }); };
    const field = (tree: ReactNode, name: string) => nodes(nodes(tree).find((node) => node.type === "label" && text(node).startsWith(name))!).find((node) => ["input", "select", "textarea"].includes(String(node.type)))!;
    field(render(), "Решение").props.onChange!({ target: { value: "Участвовать" } });
    expect(change).not.toHaveBeenCalled();
    expect(normalizeProcurement(JSON.parse(JSON.stringify(item))).goNoGoDecision).toMatchObject({ confirmed: "Решение не принято", author: "", decidedAt: "" });
    const confirm = (tree: ReactNode) => nodes(tree).find((node) => node.type === "button" && text(node) === "Подтвердить решение")!;
    confirm(render()).props.onClick!();
    expect(item.goNoGoDecision.confirmed).toBe("Решение не принято");
    expect(text(render())).toContain("Укажите автора решения.");
    field(render(), "Автор").props.onChange!({ target: { value: "QA reviewer" } });
    confirm(render()).props.onClick!();
    const saved = normalizeProcurement(JSON.parse(JSON.stringify(item)));
    expect(saved.goNoGoDecision).toMatchObject({ confirmed: "Участвовать", author: "QA reviewer", inputRevision: item.revision });
    expect(saved.goNoGoDecision.decidedAt).not.toBe("");
  });
  it("disables the confirmation control for viewers", () => {
    const tree = Stage2Workspace({ item: emptyProcurement(), onChange: vi.fn(), section: "decision", readOnly: true });
    expect(nodes(tree).find((node) => node.type === "button" && text(node) === "Подтвердить решение")?.props.disabled).toBe(true);
  });
});
