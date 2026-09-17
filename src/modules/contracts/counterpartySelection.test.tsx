import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CounterpartiesRegistry } from "./Counterparties";
import { emptyCompany, type CompanyCard } from "./companies";
import { ConfirmDialog } from "../../components/Dialog";

const hooks = vi.hoisted(() => ({ index: 0, values: [] as unknown[], companies: [] as CompanyCard[], archive: vi.fn(), loading: false, error: "" }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(), useEffect: vi.fn(), useMemo: (fn: () => unknown) => fn(),
  useState: (initial: unknown) => { const index = hooks.index++; if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial; return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }]; },
}));
vi.mock("../../hooks/useRecords", () => ({ useRecords: () => ({ records: [], loading: false, error: "", reload: vi.fn() }) }));
vi.mock("../../lib/workspaceAccess", () => ({ useWorkspaceAccess: () => ({ editor: true }) }));
vi.mock("./CompanyDirectory", () => ({ CompanyEditor: () => null, useCompanyDirectory: () => ({ companies: hooks.companies, error: hooks.error, loading: hooks.loading, setCompaniesArchived: hooks.archive, reload: vi.fn() }) }));

type Props = { children?: ReactNode; onClick?: () => void; onChange?: (event: { target: { checked: boolean; value: string } }) => void; "aria-label"?: string; message?: string; onConfirm?: () => Promise<void> };
function text(node: ReactNode): string { if (typeof node === "string" || typeof node === "number") return String(node); if (Array.isArray(node)) return node.map(text).join(""); return isValidElement<Props>(node) ? text(node.props.children) : ""; }
function find(node: ReactNode, predicate: (type: unknown, props: Props) => boolean): Props | undefined {
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } }
  else if (isValidElement<Props>(node)) { if (predicate(node.type, node.props)) return node.props; return find(node.props.children, predicate); }
}
const render = () => { hooks.index = 0; return CounterpartiesRegistry(); };
describe("counterparty batch actions use only explicit checkboxes", () => {
  beforeEach(() => { hooks.values = []; hooks.archive.mockReset(); hooks.loading = false; hooks.error = ""; hooks.companies = ["Первая", "Вторая"].map((name, index) => ({ ...emptyCompany("2026-09-17", String(index)), name })); });
  it("does not offer bulk actions before selecting, then confirms the exact company names", async () => {
    expect(text(render())).not.toContain("В архив выбранные");
    find(render(), (_type, props) => props["aria-label"] === "Выбрать контрагента Вторая")!.onChange!({ target: { checked: true, value: "" } });
    find(render(), (type, props) => type === "button" && text(props.children).startsWith("В архив выбранные"))!.onClick!();
    const confirmation = find(render(), (type) => type === ConfirmDialog)!;
    expect(confirmation.message).toContain("Выбрано: 1. Вторая.");
    expect(confirmation.message).not.toContain("Первая");
    await confirmation.onConfirm!();
    expect(hooks.archive).toHaveBeenCalledExactlyOnceWith(["1"], true);
    expect(find(render(), (type) => type === ConfirmDialog)).toBeUndefined();
  });
  it("retains failed confirmations and does not announce success", async () => {
    hooks.archive.mockRejectedValue(new Error("Папка недоступна"));
    find(render(), (_type, props) => props["aria-label"] === "Выбрать контрагента Первая")!.onChange!({ target: { checked: true, value: "" } });
    find(render(), (type, props) => type === "button" && text(props.children).startsWith("В архив выбранные"))!.onClick!();
    await expect(find(render(), (type) => type === ConfirmDialog)!.onConfirm!()).rejects.toThrow("Папка недоступна");
    expect(find(render(), (type) => type === ConfirmDialog)).toBeDefined();
    expect(text(render())).not.toContain("Карточки перенесены в архив");
  });
  it("does not confuse a read failure with an empty directory", () => {
    hooks.companies = []; hooks.error = "Папка недоступна";
    expect(text(render())).toContain("Не удалось прочитать справочник");
    expect(text(render())).not.toContain("Справочник пока пуст");
    expect(text(render())).not.toContain("Нет совпадений");
  });
});
