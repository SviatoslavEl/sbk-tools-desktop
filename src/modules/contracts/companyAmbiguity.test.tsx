import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyNameField, useCompanyDirectory } from "./CompanyDirectory";
import { ContractEditor, mapContracts, mergeContractImportUpdate } from "./Contracts";
import { emptyCompany, type CompanyCard } from "./companies";
import { emptyContract, type ContractData } from "./types";
import type { StoredRecord } from "../../lib/storage";

const runtime = vi.hoisted(() => ({ values: [] as unknown[], refs: [] as Array<{ current: unknown }>, stateIndex: 0, refIndex: 0,
  displayed: [] as CompanyCard[], records: [] as StoredRecord<ContractData>[], fresh: [] as CompanyCard[], read: vi.fn(), save: vi.fn(), batch: vi.fn(), update: vi.fn() }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useEffect: vi.fn(), useId: () => "company-selection",
  useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(),
  useRef: (initial: unknown) => runtime.refs[runtime.refIndex++] ||= { current: initial },
  useState: (initial: unknown) => { const index = runtime.stateIndex++; if (!(index in runtime.values)) runtime.values[index] = typeof initial === "function" ? initial() : initial;
    return [runtime.values[index], (next: unknown) => { runtime.values[index] = typeof next === "function" ? next(runtime.values[index]) : next; }]; },
}));
vi.mock("../../lib/workspaceAccess", () => ({ useWorkspaceAccess: () => ({ editor: true, message: "" }) }));
vi.mock("../../lib/networkDiagnostics", async (original) => ({ ...await original<typeof import("../../lib/networkDiagnostics")>(), networkAccessIsPaused: () => false }));
vi.mock("../../hooks/useRecords", async (original) => ({ ...await original<typeof import("../../hooks/useRecords")>(), useUiListSnapshot: () => ({ data: { records: runtime.records, directory: { schemaVersion: 3, companies: runtime.displayed } }, loading: false, refreshing: false, stale: false, error: "", reload: vi.fn() }) }));
vi.mock("../../lib/storage", async (original) => ({ ...await original<typeof import("../../lib/storage")>(),
  readContractWorkspace: runtime.read, saveContractWithCompanyDirectoryAtomic: runtime.save,
  importContractsWithCompanyDirectoryAtomic: runtime.batch, updateContractsAndCompanyDirectoryAtomic: runtime.update,
}));

type Props = { children?: ReactNode; value?: string; disabled?: boolean; "aria-label"?: string; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void };
function text(node: ReactNode): string { if (typeof node === "string" || typeof node === "number") return String(node); if (Array.isArray(node)) return node.map(text).join(""); return isValidElement<Props>(node) ? text(node.props.children) : ""; }
function find(node: ReactNode, predicate: (type: unknown, props: Props) => boolean): Props | undefined {
  if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } }
  else if (isValidElement<Props>(node)) { if (predicate(node.type, node.props)) return node.props; return find(node.props.children, predicate); }
}
const companies = () => [
  { ...emptyCompany("2026-10-14", "company-A"), name: "ООО «Альфа»", inn: "7736046991" },
  { ...emptyCompany("2026-10-14", "company-B"), name: "ООО «Альфа»", inn: "7721632827" },
];
const contract = (): ContractData => ({ ...emptyContract(), performingLegalEntity: "ООО СБК", number: "QA-D17", customer: "ООО Альфа", subject: "Тестовый договор" });
function render<T>(fn: () => T): T { runtime.stateIndex = 0; runtime.refIndex = 0; return fn(); }

describe("company ambiguity in actual controls and persistence boundaries", () => {
  beforeEach(() => { runtime.values = []; runtime.refs = []; runtime.displayed = companies(); runtime.records = []; runtime.fresh = companies();
    runtime.read.mockReset().mockImplementation(async () => ({ records: [], directory: { schemaVersion: 3, companies: runtime.fresh } }));
    runtime.save.mockReset().mockResolvedValue({ id: "saved" }); runtime.batch.mockReset().mockResolvedValue(undefined); runtime.update.mockReset().mockResolvedValue(undefined);
  });

  it.each([false, true])("shows an unselected placeholder, both INNs/IDs and preserves text until an explicit selection (reverse=%s)", (reverse) => {
    const entries = reverse ? companies().reverse() : companies(); const onChange = vi.fn();
    const tree = render(() => CompanyNameField({ label: "Заказчик", value: "ООО Альфа", companyId: "", companies: entries, role: "counterparty", onChange }));
    const select = find(tree, (type) => type === "select")!;
    expect(select.value).toBe(""); expect(text(tree)).toContain("несколько юридических лиц");
    expect(text(tree)).toContain("7736046991"); expect(text(tree)).toContain("7721632827");
    expect(text(tree)).toContain("company-A"); expect(text(tree)).toContain("company-B"); expect(onChange).not.toHaveBeenCalled();
    select.onChange!({ target: { value: "company-B" } }); expect(onChange).toHaveBeenCalledExactlyOnceWith("ООО «Альфа»", "company-B");
  });

  it("shows the actual ID even when the same-name card comes first", () => {
    const tree = render(() => CompanyNameField({ label: "Заказчик", value: "ООО Альфа", companyId: "company-B", companies: companies(), role: "counterparty", onChange: vi.fn() }));
    expect(find(tree, (type) => type === "select")!.value).toBe("company-B"); expect(text(tree)).not.toContain("До выбора договор нельзя сохранить");
  });

  it("blocks the actual editor save handler until a specific company has been chosen", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const editor = () => render(() => ContractEditor({ initialValue: contract(), companies: companies(), onSave, onClose: vi.fn() }));
    const save = () => find(editor(), (type, props) => type === "button" && text(props.children) === "Сохранить договор")!;
    expect(save().disabled).toBe(true); save().onClick!(); expect(onSave).not.toHaveBeenCalled();
    const field = find(editor(), (type, props) => type === CompanyNameField && props.value === "ООО Альфа") as unknown as { onChange: (name: string, id: string) => void };
    field.onChange("ООО «Альфа»", "company-B"); expect(save().disabled).toBe(false); save().onClick!();
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce()); expect(onSave.mock.calls[0][0].customerCompanyId).toBe("company-B");
  });

  it.each(["single", "batch", "update"] as const)("rechecks the fresh directory before any %s write", async (mode) => {
    runtime.displayed = [companies()[0]];
    const directory = render(() => useCompanyDirectory([])); const item = contract();
    const operation = mode === "single" ? directory.persistContractThenDirectory(item) : mode === "batch" ? directory.persistContractsThenDirectory([item]) : directory.persistContractUpdatesThenDirectory([{ id: "existing", payload: item }]);
    await expect(operation).rejects.toThrow(/несколько юридических лиц/);
    expect(runtime.read).toHaveBeenCalledOnce(); expect(runtime.save).not.toHaveBeenCalled(); expect(runtime.batch).not.toHaveBeenCalled(); expect(runtime.update).not.toHaveBeenCalled();
  });

  it("persists a chosen ID without guessing from the duplicate name", async () => {
    const directory = render(() => useCompanyDirectory([])); await directory.persistContractThenDirectory({ ...contract(), customerCompanyId: "company-B" });
    expect(runtime.save).toHaveBeenCalledOnce(); expect(runtime.save.mock.calls[0][1].customerCompanyId).toBe("company-B");
    expect(runtime.save.mock.calls[0][2].companies.filter((company: CompanyCard) => company.name === "ООО «Альфа»")).toHaveLength(2);
  });

  it("does not invent a linked company in the read model of an ambiguous legacy contract", () => {
    const payload = { ...contract(), performingLegalEntity: "ООО Альфа" };
    runtime.records = [{ id: "legacy", title: "QA", payload, archived: false, createdAt: "", updatedAt: "" }];
    const original = structuredClone(runtime.records);
    const directory = render(() => useCompanyDirectory([]));
    expect(directory.companies.filter((entry) => entry.name === "ООО «Альфа»")).toHaveLength(2);
    expect(directory.companies.every((entry) => entry.scope === "external")).toBe(true);
    expect(runtime.records).toEqual(original); expect(payload.customerCompanyId).toBe(""); expect(payload.performingLegalEntityId).toBe("");
    expect(runtime.save).not.toHaveBeenCalled(); expect(runtime.batch).not.toHaveBeenCalled(); expect(runtime.update).not.toHaveBeenCalled(); expect(runtime.read).not.toHaveBeenCalled();
  });

  it("retains the explicitly chosen template ID only for otherwise empty performer rows", () => {
    const mapping = { performingLegalEntity: 0, number: 1 } as Parameters<typeof mapContracts>[1];
    const rows = mapContracts([["", "QA-1"], ["ООО Альфа", "QA-2"]], mapping, "ООО Альфа", "company-B");
    expect(rows[0]).toMatchObject({ performingLegalEntity: "ООО Альфа", performingLegalEntityId: "company-B" });
    expect(rows[1].performingLegalEntityId).toBe("");
    const previous = { ...contract(), customerCompanyId: "company-A" };
    expect(mergeContractImportUpdate(previous, { ...previous, customerCompanyId: "company-B" }, { customer: 0 } as Parameters<typeof mapContracts>[1]).customerCompanyId).toBe("company-B");
    expect(mergeContractImportUpdate(previous, { ...previous, customer: "Новая компания", customerCompanyId: "" }, { customer: 0 } as Parameters<typeof mapContracts>[1]).customerCompanyId).toBe("");
    expect(mergeContractImportUpdate(previous, { ...previous, customerCompanyId: "" }, { customer: 0 } as Parameters<typeof mapContracts>[1]).customerCompanyId).toBe("company-A");
  });
});
