import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContractsRegistry } from "./Contracts";
import { ContractSelectionDocuments } from "./ContractSelectionDocuments";
import { emptyContract, emptyContractDocument, type ContractData, type ContractDocument } from "./types";
import type { StoredRecord } from "../../lib/storage";
import { contractSelectionArchivePlan, contractSelectionDocumentGroups, pruneContractDocumentSelection, selectContractDocumentGroup, type ContractSelectionDocumentGroup } from "./selectionDocuments";

const hooks = vi.hoisted(() => ({ index: 0, refIndex: 0, values: [] as unknown[], refs: [] as { current: unknown }[], records: [] as StoredRecord<ContractData>[], archive: vi.fn(), savePath: vi.fn(), confirm: vi.fn(), alert: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(), useEffect: vi.fn(), useMemo: (fn: () => unknown) => fn(),
  useRef: (initial: unknown) => { const index = hooks.refIndex++; return hooks.refs[index] ||= { current: initial }; },
  useState: (initial: unknown) => { const index = hooks.index++; if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial; return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }]; },
}));
vi.mock("../../hooks/useRecords", () => ({ useRecords: () => ({ records: hooks.records, loading: false, error: "", reload: vi.fn() }) }));
vi.mock("./CompanyDirectory", () => ({ CompanyNameField: () => null, useCompanyDirectory: () => ({ companies: [], editor: true, loading: false, error: "", migrationRevision: 0 }) }));
vi.mock("../../lib/storage", async (original) => ({ ...await original<typeof import("../../lib/storage")>(), createRegistryArchive: hooks.archive }));
vi.mock("../../lib/files", async (original) => ({ ...await original<typeof import("../../lib/files")>(), chooseSavePath: hooks.savePath }));

const document = (id: string, type: ContractDocument["type"] = "Договор", path?: string): ContractDocument => ({ ...emptyContractDocument(), id, type, name: `Название ${id}`, relativePath: path, fileName: path ? `${id}.pdf` : undefined });
const record = (id: string, documents: ContractDocument[]): StoredRecord<ContractData> => ({ id, title: id, createdAt: "2026-09-18", updatedAt: "2026-09-18", archived: false, payload: { ...emptyContract(), number: id, customer: `Заказчик ${id}`, stage: "Выполнен", disclosureAllowed: true, documents } });
const fixture = () => [record("A", [document("contract", "Договор", "attachments/contract-experience/A/contract.pdf"), document("act", "Акт", "attachments/contract-experience/A/act.pdf"), document("review", "Отзыв"), document("cert", "Сертификат", "attachments/contract-experience/A/cert.pdf")]), record("B", [document("other", "Иное", "attachments/contract-experience/B/other.pdf")])];

type Props = { children?: ReactNode; onClick?: () => void; onChange?: (event: { target: { checked: boolean; value: string } }) => void; "aria-label"?: string; disabled?: boolean; checked?: boolean; groups?: ContractSelectionDocumentGroup[]; selected?: ReadonlySet<string>; value?: unknown };
function text(node: ReactNode): string { if (typeof node === "string" || typeof node === "number") return String(node); if (Array.isArray(node)) return node.map(text).join(""); return isValidElement<Props>(node) ? text(node.props.children) : ""; }
function find(node: ReactNode, predicate: (type: unknown, props: Props) => boolean): Props | undefined { if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } } else if (isValidElement<Props>(node)) { if (predicate(node.type, node.props)) return node.props; return find(node.props.children, predicate); } }

describe("exact contract document archive plan", () => {
  it("starts with no selected files and includes only explicitly selected records", () => {
    const groups = contractSelectionDocumentGroups(fixture(), new Set(["A", "stale"]));
    expect(groups).toHaveLength(1);
    expect(contractSelectionArchivePlan(groups, new Set())).toEqual({ recordIds: ["A"], attachmentPaths: [] });
    expect(groups[0].documents.map((entry) => entry.type)).toEqual(["Договор", "Акт", "Отзыв", "Сертификат"]);
  });
  it("exports exactly an individual selected file, never the remaining documents", () => {
    const groups = contractSelectionDocumentGroups(fixture(), new Set(["A", "B"]));
    expect(contractSelectionArchivePlan(groups, new Set([groups[0].documents[1].key])).attachmentPaths).toEqual(["attachments/contract-experience/A/act.pdf"]);
  });
  it("group select-all excludes missing attachments and leaves other groups unchanged", () => {
    const groups = contractSelectionDocumentGroups(fixture(), new Set(["A", "B"]));
    const initial = new Set([groups[1].documents[0].key]);
    const all = selectContractDocumentGroup(groups[0], initial, true);
    expect(all.size).toBe(4); expect(all.has(groups[0].documents[2].key)).toBe(false);
    expect(selectContractDocumentGroup(groups[0], all, false)).toEqual(initial);
    expect(initial.size).toBe(1);
  });
  it("removes documents from deselected or no-longer-matching contracts", () => {
    const records = fixture(); const groups = contractSelectionDocumentGroups(records, new Set(["A", "B"]));
    const selected = new Set(groups.flatMap((group) => group.documents.map((entry) => entry.key)));
    const current = contractSelectionDocumentGroups(records.slice(1), new Set(["A", "B"]));
    expect([...pruneContractDocumentSelection(current, selected)]).toEqual([groups[1].documents[0].key]);
    expect(contractSelectionArchivePlan(current, selected)).toEqual({ recordIds: ["B"], attachmentPaths: ["attachments/contract-experience/B/other.pdf"] });
  });
  it("requires explicit selection again after replacing a file under the same document ID", () => {
    const records = fixture(); const groups = contractSelectionDocumentGroups(records, new Set(["A"]));
    const selected = new Set([groups[0].documents[0].key]);
    records[0].payload.documents[0].relativePath = "attachments/contract-experience/A/replaced.pdf";
    const current = contractSelectionDocumentGroups(records, new Set(["A"]));
    expect(pruneContractDocumentSelection(current, selected).size).toBe(0);
    expect(contractSelectionArchivePlan(current, selected).attachmentPaths).toEqual([]);
  });
  it("deduplicates shared paths and rejects blank/no-file options even if supplied as selected", () => {
    const records = [record("A", [document("one", "Договор", "attachments/contract-experience/A/shared.pdf"), document("two", "Акт", "attachments/contract-experience/A/shared.pdf"), document("blank", "Иное", " ")])];
    const groups = contractSelectionDocumentGroups(records, new Set(["A"]));
    expect(contractSelectionArchivePlan(groups, new Set(groups[0].documents.map((entry) => entry.key))).attachmentPaths).toEqual(["attachments/contract-experience/A/shared.pdf"]);
  });
  it("keeps legacy contracts without documents safe and displays unnamed files", () => {
    const records = fixture(); records[0].payload.documents = undefined as unknown as ContractDocument[];
    records[1].payload.documents[0].name = " "; records[1].payload.documents[0].fileName = undefined;
    const groups = contractSelectionDocumentGroups(records, new Set(["A", "B"]));
    expect(groups[0].documents).toEqual([]); expect(groups[1].documents[0].name).toBe("other.pdf");
  });
});

describe("contract file picker actual UI callbacks", () => {
  it("shows concrete file names/types and disables missing attachments", () => {
    const groups = contractSelectionDocumentGroups(fixture(), new Set(["A"]));
    const tree = ContractSelectionDocuments({ groups, selected: new Set(), onChange: vi.fn() });
    expect(text(tree)).toContain("Файлы для архива · выбрано: 0");
    expect(text(tree)).toContain("Акт · act.pdf"); expect(text(tree)).toContain("Без файла — недоступно для архива");
    expect(find(tree, (type, props) => type === "input" && props["aria-label"]?.endsWith("Название review") === true)?.disabled).toBe(true);
  });
  it("checkbox selects only its file and the group button selects only available group files", () => {
    const groups = contractSelectionDocumentGroups(fixture(), new Set(["A"])); const onChange = vi.fn();
    const tree = ContractSelectionDocuments({ groups, selected: new Set(), onChange });
    find(tree, (type, props) => type === "input" && props["aria-label"]?.endsWith("Название act") === true)!.onChange!({ target: { checked: true, value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(new Set([groups[0].documents[1].key]));
    find(tree, (type, props) => type === "button" && text(props.children) === "Выбрать все файлы")!.onClick!();
    expect((onChange.mock.lastCall![0] as Set<string>).size).toBe(3);
  });
});

describe("contract selection ZIP uses explicit allowlist at the real export boundary", () => {
  const render = () => { hooks.index = 0; hooks.refIndex = 0; return ContractsRegistry(); };
  const button = (label: string) => find(render(), (type, props) => type === "button" && text(props.children).startsWith(label))!;
  const picker = () => find(render(), (type) => type === ContractSelectionDocuments)!;
  const choose = () => {
    button("Подбор под закупку").onClick!();
    find(render(), (type, props) => type === "input" && props["aria-label"] === "Выбрать A")!.onChange!({ target: { checked: true, value: "" } });
    const props = picker();
    (props.onChange as unknown as (value: Set<string>) => void)(new Set([props.groups![0].documents[1].key]));
  };
  beforeEach(() => {
    hooks.values = []; hooks.refs = []; hooks.records = fixture(); hooks.archive.mockReset().mockResolvedValue({ fileName: "chosen.zip" }); hooks.savePath.mockReset().mockResolvedValue("/tmp/chosen.zip"); hooks.confirm.mockReset().mockReturnValue(true); hooks.alert.mockReset();
    vi.stubGlobal("window", { alert: hooks.alert, confirm: hooks.confirm });
  });
  it("disables ZIP before selecting files, then sends only the act path and selected contract ID", async () => {
    button("Подбор под закупку").onClick!(); expect(button("ZIP").disabled).toBe(true);
    choose(); button("ZIP").onClick!();
    await vi.waitFor(() => expect(hooks.archive).toHaveBeenCalledExactlyOnceWith("contract-experience", "/tmp/chosen.zip", ["A"], ["attachments/contract-experience/A/act.pdf"]));
  });
  it("retains the disclosure warning and cancellation prevents archive creation", () => {
    hooks.records[0].payload.disclosureAllowed = false; hooks.confirm.mockReturnValue(false);
    choose(); button("ZIP").onClick!();
    expect(hooks.confirm).toHaveBeenCalledWith(expect.stringContaining("без разрешения на раскрытие"));
    expect(hooks.savePath).not.toHaveBeenCalled(); expect(hooks.archive).not.toHaveBeenCalled();
  });
  it("does not export selections that have disappeared from the current match set", () => {
    choose(); hooks.records[0].payload.stage = "Подготовка";
    expect(button("ZIP").disabled).toBe(true); button("ZIP").onClick!();
    expect(hooks.archive).not.toHaveBeenCalled(); expect(hooks.savePath).not.toHaveBeenCalled();
  });
  it("prevents duplicate exports while the destination picker is pending", async () => {
    let resolve!: (value: string) => void; hooks.savePath.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
    choose(); const action = button("ZIP"); action.onClick!(); action.onClick!();
    expect(hooks.savePath).toHaveBeenCalledOnce(); expect(button("Создаём архив").disabled).toBe(true);
    resolve("/tmp/chosen.zip"); await vi.waitFor(() => expect(hooks.archive).toHaveBeenCalledOnce());
  });
  it("keeps selected files after an export failure and allows retry", async () => {
    hooks.archive.mockRejectedValueOnce(new Error("Сетевая папка недоступна"));
    choose(); button("ZIP").onClick!();
    await vi.waitFor(() => expect(hooks.alert).toHaveBeenCalledWith(expect.stringContaining("Сетевая папка недоступна")));
    expect(picker().selected?.size).toBe(1); expect(button("ZIP").disabled).toBe(false);
    button("ZIP").onClick!(); await vi.waitFor(() => expect(hooks.archive).toHaveBeenCalledTimes(2));
    expect(hooks.archive.mock.calls[1][3]).toEqual(["attachments/contract-experience/A/act.pdf"]);
  });
  it("leaves the general registry ZIP export unrestricted by the selection picker", async () => {
    find(render(), (type, props) => type === "input" && props["aria-label"] === "Выбрать договор A")!.onChange!({ target: { checked: true, value: "" } });
    button("Документы и сведения (ZIP)").onClick!();
    await vi.waitFor(() => expect(hooks.archive).toHaveBeenCalledExactlyOnceWith("contract-experience", "/tmp/chosen.zip", ["A"], undefined));
  });
});
