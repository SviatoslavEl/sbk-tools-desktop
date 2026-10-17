import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StaffEditor } from "./Staff";
import { StaffReadCard } from "./StaffReadCard";
import { StaffOptionalDateField } from "./StaffOptionalDateField";
import { staffRequirements } from "./requirements";
import { emptyOrganizationalAssignment, emptyStaff, emptyStaffDocument, staffAssignments, type StaffData } from "./types";

const hooks = vi.hoisted(() => ({ index: 0, values: [] as unknown[], editor: true }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(), useId: () => "certificate-hint", useRef: (value: unknown) => ({ current: value }), useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
  },
}));
vi.mock("../../lib/workspaceAccess", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/workspaceAccess")>(),
  useWorkspaceAccess: () => ({ editor: hooks.editor, message: "" }),
}));
type Props = { children?: ReactNode; value?: unknown; label?: string; documents?: StaffData["documents"]; assignments?: StaffData["organizationalAssignments"]; onClick?: () => void | Promise<void>; onChange?: (event: { target: { value: string } }) => void; "aria-label"?: string };
const text = (node: ReactNode): string => typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(text).join("") : isValidElement<Props>(node) ? text(node.props.children) : "";
function find(node: ReactNode, predicate: (element: ReactElement<Props>) => boolean): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap((child) => find(child, predicate));
  return isValidElement<Props>(node) ? [...(predicate(node) ? [node] : []), ...find(node.props.children, predicate)] : [];
}
const button = (node: ReactNode, title: string) => find(node, (element) => element.type === "button" && text(element.props.children) === title)[0].props;
const dateFields = (node: ReactNode, label: string) => find(node, (element) => element.type === StaffOptionalDateField && element.props.label === label) as unknown as ReactElement<ComponentProps<typeof StaffOptionalDateField>>[];
function staff(documents: StaffData["documents"] = []): StaffData {
  return { ...emptyStaff(), fullName: "Иванов Иван QA", documents, organizationalAssignments: [{ ...emptyOrganizationalAssignment(), legalEntity: "Компания QA", department: "ИТ", position: "Инженер QA" }] };
}
function editor(initialValue: StaffData) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const render = () => { hooks.index = 0; return StaffEditor({ initialValue, onSave, onClose: vi.fn() }); };
  const list = (property: "documents" | "assignments") => {
    const element = find(render(), (node) => Array.isArray(node.props[property]))[0];
    return (element.type as (props: Props) => ReactNode)(element.props);
  };
  return { render, list, onSave, tab: (title: string) => button(render(), title).onClick!(), save: () => button(render(), "Сохранить карточку").onClick!() };
}
describe("certificate register metadata in ordinary staff cards", () => {
  beforeEach(() => { hooks.index = 0; hooks.values = []; hooks.editor = true; });

  it("edits exam date and historical register status without changing issue/expiry dates or unlimited", async () => {
    const document = { ...emptyStaffDocument(), name: "Сертификат QA", seriesNumber: "QA-12", issuedDate: "2030-01-10", expiresDate: "2032-01-10" };
    delete document.examDate; delete document.reportedValidity;
    const initial = staff([document]), form = editor(initial); form.tab("Сертификаты");
    const control = (label: string) => find(form.list("documents"), (node) => node.props["aria-label"] === label)[0].props;
    expect(dateFields(form.list("documents"), "Дата экзамена")[0].props.value).toBe(""); expect(control("Статус в исходном реестре").value).toBe("");
    dateFields(form.list("documents"), "Дата экзамена")[0].props.onChange("2029-12-15");
    control("Статус в исходном реестре").onChange!({ target: { value: "Нет" } });
    await form.save();
    expect(form.onSave).toHaveBeenCalledOnce();
    expect(form.onSave.mock.calls[0][0].documents[0]).toMatchObject({ ...document, examDate: "2029-12-15", reportedValidity: "Нет", unlimited: false });
    expect(initial.documents[0]).not.toHaveProperty("examDate"); expect(initial.documents[0]).not.toHaveProperty("reportedValidity");
    expect(text(form.list("documents"))).toContain("не подтверждение действия сегодня");
  });

  it("does not merge equal certificate names with different registry numbers or treat Да as unlimited", async () => {
    const first = { ...emptyStaffDocument(), name: "Сертификат QA", seriesNumber: "QA-1", reportedValidity: "Да" as const };
    const second = { ...emptyStaffDocument(), name: "Сертификат QA", seriesNumber: "QA-2", reportedValidity: "Нет" as const };
    const form = editor(staff([first, second])); form.tab("Сертификаты");
    dateFields(form.list("documents"), "Дата экзамена")[0].props.onChange("2031-04-02");
    await form.save();
    expect(form.onSave.mock.calls[0][0].documents).toEqual([{ ...first, examDate: "2031-04-02" }, second]);
    expect(form.onSave.mock.calls[0][0].documents.every((document: { unlimited: boolean; expiresDate: string }) => !document.unlimited && document.expiresDate === "")).toBe(true);
  });

  it("shows the exam and historical status separately in the read card", () => {
    const payload = staff([{ ...emptyStaffDocument(), name: "Сертификат QA", seriesNumber: "QA-77", examDate: "2031-04-02", reportedValidity: "Да" }]);
    const html = renderToStaticMarkup(<StaffReadCard record={{ id: "qa", title: payload.fullName, payload, archived: false, createdAt: "2031-01-01", updatedAt: "2031-01-01" }} onClose={() => {}} />);
    expect(html).toContain("Дата экзамена"); expect(html).toContain("2031-04-02"); expect(html).toContain("Статус в исходном реестре (не на сегодня)");
    expect(html).toContain("QA-77"); expect(html).not.toContain("Бессрочно");
  });

  it("leaves all three optional dates empty when saving a document without entering dates", async () => {
    const document = { ...emptyStaffDocument(), name: "Сертификат без дат QA" };
    const initial = staff([document]), form = editor(initial); form.tab("Сертификаты");
    for (const label of ["Дата выдачи", "Дата экзамена", "Срок действия"]) {
      const [field] = dateFields(form.list("documents"), label);
      expect(field.props.value).toBe(""); expect(field.props.disabled).toBe(false);
    }
    await form.save();
    expect(form.onSave.mock.calls[0][0].documents[0]).toEqual(document);
    expect(initial.documents[0]).toEqual(document);
  });

  it("updates and clears each document date independently through its controlled component callback", async () => {
    const document = { ...emptyStaffDocument(), name: "Три даты QA", issuedDate: "2030-01-10", examDate: "2029-12-15", expiresDate: "2032-01-10" };
    const form = editor(staff([document])); form.tab("Сертификаты");
    dateFields(form.list("documents"), "Дата выдачи")[0].props.onChange("");
    dateFields(form.list("documents"), "Дата экзамена")[0].props.onChange("2030-02-02");
    dateFields(form.list("documents"), "Срок действия")[0].props.onChange("");
    await form.save();
    expect(form.onSave.mock.calls[0][0].documents[0]).toMatchObject({ issuedDate: "", examDate: "2030-02-02", expiresDate: "", unlimited: false });
    expect(document).toMatchObject({ issuedDate: "2030-01-10", examDate: "2029-12-15", expiresDate: "2032-01-10" });
  });

  it("disables expiry for an unlimited document and all date controls after editor access ends", async () => {
    const form = editor(staff([{ ...emptyStaffDocument(), name: "Бессрочный QA", unlimited: true }])); form.tab("Сертификаты");
    expect(dateFields(form.list("documents"), "Срок действия")[0].props.disabled).toBe(true);
    expect(dateFields(form.list("documents"), "Дата выдачи")[0].props.disabled).toBe(false);
    hooks.editor = false;
    for (const label of ["Дата выдачи", "Дата экзамена", "Срок действия"]) expect(dateFields(form.list("documents"), label)[0].props.disabled).toBe(true);
    await form.save(); expect(form.onSave).not.toHaveBeenCalled();
  });

  it("keeps manual defaults but refuses to save an AI draft with an unknown employment basis until explicitly chosen", async () => {
    expect(emptyStaff().basis).toBe("Трудовой договор"); expect(emptyOrganizationalAssignment().engagementType).toBe("Трудовой договор");
    const initial = staff(); initial.basis = "Не указано"; initial.organizationalAssignments[0].engagementType = "Не указано";
    expect(staffAssignments(initial)[0].engagementType).toBe("Не указано"); expect(staffRequirements(initial).missing).toContain("Основание сотрудничества");
    const form = editor(initial); await form.save();
    expect(form.onSave).not.toHaveBeenCalled(); expect(text(form.render())).toContain("Выберите подтверждённое основание сотрудничества");
    const label = find(form.list("assignments"), (node) => node.type === "label" && text(node.props.children).startsWith("Основание"))[0];
    find(label, (node) => node.type === "select")[0].props.onChange!({ target: { value: "ГПХ" } });
    await form.save(); expect(form.onSave).toHaveBeenCalledOnce(); expect(form.onSave.mock.calls[0][0].basis).toBe("ГПХ");
    expect(initial.basis).toBe("Не указано");
  });
});
