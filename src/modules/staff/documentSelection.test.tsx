import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StaffRegistry } from "./Staff";
import { StaffSelectionDocuments } from "./StaffSelectionDocuments";
import { emptyStaff, emptyStaffDocument, type StaffData, type StaffDocument } from "./types";
import type { StoredRecord } from "../../lib/storage";
import { pruneStaffDocumentSelection, selectedStaffAttachmentPaths, staffDocumentOptions, staffDocumentSelectionKey } from "./documentSelection";

const hooks = vi.hoisted(() => ({ index: 0, refIndex: 0, values: [] as unknown[], refs: [] as { current: unknown }[], records: [] as StoredRecord<StaffData>[], archive: vi.fn(), savePath: vi.fn(), confirm: vi.fn(), alert: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(), useEffect: vi.fn(), useMemo: (fn: () => unknown) => fn(),
  useRef: (initial: unknown) => { const index = hooks.refIndex++; return hooks.refs[index] ||= { current: initial }; },
  useState: (initial: unknown) => { const index = hooks.index++; if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial; return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }]; },
}));
vi.mock("../../hooks/useRecords", () => ({ useRecords: (module: string) => ({ records: module === "staff" ? hooks.records : [], loading: false, error: "", reload: vi.fn() }) }));
vi.mock("../../lib/workspaceAccess", async (original) => ({ ...await original<typeof import("../../lib/workspaceAccess")>(), useWorkspaceAccess: () => ({ editor: true, message: "" }) }));
vi.mock("../../lib/storage", async (original) => ({ ...await original<typeof import("../../lib/storage")>(), createRegistryArchive: hooks.archive }));
vi.mock("../../lib/files", async (original) => ({ ...await original<typeof import("../../lib/files")>(), chooseSavePath: hooks.savePath }));

const document = (id: string, category: StaffDocument["category"], path?: string): StaffDocument => ({ ...emptyStaffDocument(category), id, name: `Название ${id}`, seriesNumber: `№-${id}`, unlimited: true, relativePath: path, fileName: path ? `${id}.pdf` : undefined });
const record = (id: string, documents: StaffDocument[]): StoredRecord<StaffData> => ({ id, title: id, createdAt: "2026-09-18", updatedAt: "2026-09-18", archived: false, payload: { ...emptyStaff(), fullName: `Сотрудник ${id}`, disclosureAllowed: true, documents } });
const fixture = () => [record("A", [document("cert1", "certificate", "attachments/staff/A/cert1.pdf"), document("cert2", "certificate", "attachments/staff/A/cert2.pdf"), document("contract", "contract", "attachments/staff/A/contract.pdf"), document("diploma", "education")]), record("B", [document("permit", "permit", "attachments/staff/B/permit.pdf")])];
type Props = { children?: ReactNode; onClick?: () => void; onChange?: (event: { target: { checked: boolean; value: string } }) => void; "aria-label"?: string; disabled?: boolean; checked?: boolean; records?: Array<Pick<StoredRecord<StaffData>, "id" | "payload">>; selected?: ReadonlySet<string> };
function text(node: ReactNode): string { if (typeof node === "string" || typeof node === "number") return String(node); if (Array.isArray(node)) return node.map(text).join(""); return isValidElement<Props>(node) ? text(node.props.children) : ""; }
function find(node: ReactNode, predicate: (type: unknown, props: Props) => boolean): Props | undefined { if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found; } } else if (isValidElement<Props>(node)) { if (predicate(node.type, node.props)) return node.props; return find(node.props.children, predicate); } }

describe("staff exact document selection helpers", () => {
  it("starts empty and selecting one certificate does not include other certificates or contracts", () => {
    const records = fixture(); const key = staffDocumentSelectionKey("A", records[0].payload.documents[0]);
    expect(selectedStaffAttachmentPaths(records, new Set())).toEqual([]);
    expect(selectedStaffAttachmentPaths(records, new Set([key]))).toEqual(["attachments/staff/A/cert1.pdf"]);
  });
  it("includes one concrete certificate and contract, not the unselected second certificate", () => {
    const records = fixture(); const selected = new Set([0, 2].map((index) => staffDocumentSelectionKey("A", records[0].payload.documents[index])));
    expect(selectedStaffAttachmentPaths(records, selected)).toEqual(["attachments/staff/A/cert1.pdf", "attachments/staff/A/contract.pdf"]);
  });
  it("prunes missing files and records that disappeared from the current selection", () => {
    const records = fixture(); const options = staffDocumentOptions(records); const selected = new Set(options.map((option) => option.key));
    const current = records.slice(1);
    expect(pruneStaffDocumentSelection(current, selected)).toEqual(new Set([staffDocumentSelectionKey("B", current[0].payload.documents[0])]));
    expect(pruneStaffDocumentSelection(records, selected).size).toBe(4);
    expect(selectedStaffAttachmentPaths(current, selected)).toEqual(["attachments/staff/B/permit.pdf"]);
  });
  it.each(["relativePath", "sha256"] as const)("requires explicit reselection after replacement changes %s", (field) => {
    const records = fixture(); const selected = new Set([staffDocumentSelectionKey("A", records[0].payload.documents[0])]);
    records[0].payload.documents[0][field] = field === "relativePath" ? "attachments/staff/A/new.pdf" : "new-file-sha";
    expect(pruneStaffDocumentSelection(records, selected).size).toBe(0);
    expect(selectedStaffAttachmentPaths(records, selected)).toEqual([]);
  });
  it("deduplicates shared files and never exports whitespace-only attachment paths", () => {
    const records = fixture(); records[0].payload.documents[1].relativePath = records[0].payload.documents[0].relativePath;
    records[0].payload.documents[3].relativePath = " ";
    const options = staffDocumentOptions(records); const selected = new Set(options.map((option) => option.key));
    expect(options.find((option) => option.document.id === "diploma")?.selectable).toBe(false);
    expect(selectedStaffAttachmentPaths(records, selected)).toEqual(["attachments/staff/A/cert1.pdf", "attachments/staff/A/contract.pdf", "attachments/staff/B/permit.pdf"]);
  });
});

describe("staff file picker actual UI callbacks", () => {
  it("shows names, file names, category, number and validity, and disables missing files", () => {
    const tree = StaffSelectionDocuments({ records: fixture(), selected: new Set(), onChange: vi.fn() });
    expect(text(tree)).toContain("Выбрано файлов: 0"); expect(text(tree)).toContain("cert1.pdf");
    expect(text(tree)).toContain("Сертификат · № №-cert1 · Бессрочный"); expect(text(tree)).toContain("Без файла — нельзя включить в ZIP");
    expect(find(tree, (type, props) => type === "input" && props["aria-label"]?.endsWith("Название diploma") === true)?.disabled).toBe(true);
  });
  it("individual checkbox affects one document and keeps another person's selection", () => {
    const records = fixture(); const other = staffDocumentSelectionKey("B", records[1].payload.documents[0]); const onChange = vi.fn();
    const tree = StaffSelectionDocuments({ records, selected: new Set([other]), onChange });
    find(tree, (type, props) => type === "input" && props["aria-label"]?.endsWith("Название contract") === true)!.onChange!({ target: { checked: true, value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(new Set([other, staffDocumentSelectionKey("A", records[0].payload.documents[2])]));
  });
  it("select-all and clear within one person preserve another person's documents", () => {
    const records = fixture(); const other = staffDocumentSelectionKey("B", records[1].payload.documents[0]); const onChange = vi.fn();
    let selected = new Set([other]);
    const render = () => StaffSelectionDocuments({ records, selected, onChange });
    const group = () => find(render(), (_type, props) => props["aria-label"] === "Документы: Сотрудник A")!;
    find(group().children, (type, props) => type === "button" && text(props.children) === "Выбрать все у сотрудника")!.onClick!();
    selected = onChange.mock.lastCall![0]; expect(selected.size).toBe(4);
    expect(selected.has(staffDocumentSelectionKey("A", records[0].payload.documents[3]))).toBe(false);
    find(group().children, (type, props) => type === "button" && text(props.children) === "Снять у сотрудника")!.onClick!();
    expect(onChange).toHaveBeenLastCalledWith(new Set([other]));
  });
  it("global choose-all excludes missing files and global clear resets the choice", () => {
    const records = fixture(); const onChange = vi.fn(); let selected = new Set<string>();
    const render = () => StaffSelectionDocuments({ records, selected, onChange });
    find(render(), (type, props) => type === "button" && text(props.children) === "Выбрать все файлы")!.onClick!();
    selected = onChange.mock.lastCall![0]; expect(selected.size).toBe(4);
    find(render(), (type, props) => type === "button" && text(props.children) === "Снять выбор файлов")!.onClick!();
    expect(onChange).toHaveBeenLastCalledWith(new Set());
  });
});

describe("staff selection ZIP actual export boundary", () => {
  const render = () => { hooks.index = 0; hooks.refIndex = 0; return StaffRegistry(); };
  const button = (label: string) => find(render(), (type, props) => type === "button" && text(props.children).startsWith(label))!;
  const picker = () => find(render(), (type) => type === StaffSelectionDocuments)!;
  const select = () => {
    button("Подбор под закупку").onClick!();
    find(render(), (type, props) => type === "input" && props["aria-label"] === "Выбрать Сотрудник A")!.onChange!({ target: { checked: true, value: "" } });
    const props = picker(); const person = props.records![0];
    (props.onChange as unknown as (value: Set<string>) => void)(new Set([0, 2].map((index) => staffDocumentSelectionKey(person.id, person.payload.documents[index]))));
  };
  beforeEach(() => {
    hooks.values = []; hooks.refs = []; hooks.records = fixture(); hooks.archive.mockReset().mockResolvedValue({ fileName: "staff-picked.zip" }); hooks.savePath.mockReset().mockResolvedValue("/tmp/staff-picked.zip"); hooks.confirm.mockReset().mockReturnValue(true); hooks.alert.mockReset();
    vi.stubGlobal("window", { alert: hooks.alert, confirm: hooks.confirm });
  });
  it("disables ZIP before choosing files and sends only one certificate and contract", async () => {
    button("Подбор под закупку").onClick!(); expect(button("ZIP").disabled).toBe(true);
    select(); button("ZIP").onClick!();
    await vi.waitFor(() => expect(hooks.archive).toHaveBeenCalledExactlyOnceWith("staff", "/tmp/staff-picked.zip", ["A"], ["attachments/staff/A/cert1.pdf", "attachments/staff/A/contract.pdf"]));
  });
  it("shows disclosure warning and cancellation prevents exporting", () => {
    hooks.records[0].payload.disclosureAllowed = false;
    button("Подбор под закупку").onClick!();
    const label = find(render(), (type, props) => type === "label" && text(props.children).includes("Только разрешённые для заявки"))!;
    find(label.children, (type) => type === "input")!.onChange!({ target: { checked: false, value: "" } });
    hooks.confirm.mockReturnValue(false); select(); button("ZIP").onClick!();
    expect(hooks.confirm).toHaveBeenCalledWith(expect.stringContaining("без разрешения на включение в заявку"));
    expect(hooks.savePath).not.toHaveBeenCalled(); expect(hooks.archive).not.toHaveBeenCalled();
  });
  it("blocks export when selected staff no longer match, even before pruning effects", () => {
    select(); hooks.records[0].payload.disclosureAllowed = false;
    expect(button("ZIP").disabled).toBe(true); button("ZIP").onClick!();
    expect(hooks.archive).not.toHaveBeenCalled(); expect(hooks.savePath).not.toHaveBeenCalled();
  });
  it("ignores a replaced certificate even when its old key remains temporarily selected", async () => {
    select(); hooks.records[0].payload.documents[0].relativePath = "attachments/staff/A/new-cert.pdf";
    button("ZIP").onClick!();
    await vi.waitFor(() => expect(hooks.archive).toHaveBeenCalledExactlyOnceWith("staff", "/tmp/staff-picked.zip", ["A"], ["attachments/staff/A/contract.pdf"]));
  });
  it("prevents duplicate ZIP requests while the destination picker is pending", async () => {
    let resolve!: (value: string) => void; hooks.savePath.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done; }));
    select(); const action = button("ZIP"); action.onClick!(); action.onClick!();
    expect(hooks.savePath).toHaveBeenCalledOnce(); expect(button("Создаём архив").disabled).toBe(true);
    resolve("/tmp/staff-picked.zip"); await vi.waitFor(() => expect(hooks.archive).toHaveBeenCalledOnce());
  });
  it("keeps chosen files on archive failure and retries the same allowlist", async () => {
    hooks.archive.mockRejectedValueOnce(new Error("Папка недоступна"));
    select(); button("ZIP").onClick!();
    await vi.waitFor(() => expect(hooks.alert).toHaveBeenCalledWith(expect.stringContaining("Папка недоступна")));
    expect(picker().selected?.size).toBe(2); expect(button("ZIP").disabled).toBe(false);
    button("ZIP").onClick!(); await vi.waitFor(() => expect(hooks.archive).toHaveBeenCalledTimes(2));
    expect(hooks.archive.mock.calls[1][3]).toEqual(["attachments/staff/A/cert1.pdf", "attachments/staff/A/contract.pdf"]);
  });
  it("keeps the general registry ZIP unrestricted and based on its own checked staff", async () => {
    find(render(), (type, props) => type === "input" && props["aria-label"] === "Выбрать сотрудника Сотрудник B")!.onChange!({ target: { checked: true, value: "" } });
    button("Документы и сведения (ZIP)").onClick!();
    await vi.waitFor(() => expect(hooks.archive).toHaveBeenCalledExactlyOnceWith("staff", "/tmp/staff-picked.zip", ["B"], undefined));
  });
});
