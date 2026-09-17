import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CollapsibleEditorBlock } from "../../components/CollapsibleEditorBlock";
import { StaffEditor } from "./Staff";
import { emptyOrganizationalAssignment, emptyStaff, emptyStaffDocument, type StaffData } from "./types";

const hooks = vi.hoisted(() => ({ index: 0, values: [] as unknown[] }));

// Execute StaffEditor's actual tab, field and Save handlers, then render its
// real document/assignment child functions. No DOM or storage is simulated.
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
  useId: () => "staff-block-hint",
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next;
    }];
  },
}));
vi.mock("../../lib/workspaceAccess", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/workspaceAccess")>(),
  useWorkspaceAccess: () => ({ editor: true, message: "" }),
}));

type ElementProps = {
  children?: ReactNode;
  onClick?: () => void | Promise<void>;
  onChange?: (event: { target: { value: string } }) => void;
  value?: unknown;
  documents?: StaffData["documents"];
  assignments?: StaffData["organizationalAssignments"];
};

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<ElementProps>(node) ? text(node.props.children) : "";
}

function findAll(node: ReactNode, predicate: (element: ReactElement<ElementProps>) => boolean): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, predicate));
  if (!isValidElement<ElementProps>(node)) return [];
  return [...(predicate(node) ? [node] : []), ...findAll(node.props.children, predicate)];
}

function button(node: ReactNode, label: string) {
  const result = findAll(node, (element) => element.type === "button" && text(element.props.children) === label)[0];
  expect(result, `Button ${label}`).toBeDefined();
  return result.props;
}

function field(node: ReactNode, label: string) {
  const parent = findAll(node, (element) => element.type === "label" && text(element.props.children) === label)[0];
  expect(parent, `Field label ${label}`).toBeDefined();
  return findAll(parent, (element) => element.type === "input" || element.type === "textarea" || element.type === "select")[0].props;
}

function blocks(node: ReactNode) {
  return findAll(node, (element) => element.type === CollapsibleEditorBlock) as ReactElement<ComponentProps<typeof CollapsibleEditorBlock>>[];
}

function staff(overrides: Partial<StaffData> = {}): StaffData {
  return {
    ...emptyStaff(),
    fullName: "Тестовый сотрудник",
    organizationalAssignments: [{ ...emptyOrganizationalAssignment(), legalEntity: "Компания", department: "ИТ", position: "Инженер" }],
    ...overrides,
  };
}

function editor(initialValue: StaffData) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const render = () => { hooks.index = 0; return StaffEditor({ initialValue, onSave, onClose: vi.fn() }); };
  const selectTab = (title: string) => button(render(), title).onClick!();
  const renderList = (property: "documents" | "assignments") => {
    const child = findAll(render(), (element) => Array.isArray(element.props[property]))[0];
    expect(child, `${property} editor`).toBeDefined();
    return (child.type as (props: ElementProps) => ReactNode)(child.props);
  };
  return {
    render, selectTab, onSave,
    documents: () => renderList("documents"),
    assignments: () => renderList("assignments"),
    save: () => button(render(), "Сохранить карточку").onClick!(),
  };
}

describe("StaffEditor collapsible document and work blocks", () => {
  beforeEach(() => { hooks.index = 0; hooks.values = []; });

  it("shows an existing certificate as a compact titled row with its number and attachment state", () => {
    const certificate = { ...emptyStaffDocument(), name: "Сертификат инженера", seriesNumber: "ABC-17", fileName: "certificate.pdf", relativePath: "attachments/certificate.pdf" };
    const form = editor(staff({ documents: [certificate] }));
    form.selectTab("Сертификаты");
    const [block] = blocks(form.documents());
    expect(block.key).toBe(certificate.id);
    expect(block.props).toMatchObject({ title: "Сертификат инженера", defaultExpanded: false });
    expect(block.props.summary).toContain("№ ABC-17");
    expect(block.props.summary).toContain("Файл прикреплён");
    expect(field(block.props.children, "Название").value).toBe("Сертификат инженера");
  });

  it("opens a newly added blank document and saves its field edits through the real handlers", async () => {
    const form = editor(staff());
    form.selectTab("Сертификаты");
    button(form.documents(), "Добавить документ").onClick!();
    const [blank] = blocks(form.documents());
    expect(blank.props).toMatchObject({ title: "Новый документ", defaultExpanded: true });
    field(blank.props.children, "Название").onChange!({ target: { value: "Новый сертификат" } });
    const [named] = blocks(form.documents());
    expect(named.key).toBe(blank.key);
    expect(named.props.title).toBe("Новый сертификат");
    field(named.props.children, "Серия / номер").onChange!({ target: { value: "CERT-42" } });
    await form.save();
    expect(form.onSave).toHaveBeenCalledOnce();
    expect(form.onSave.mock.calls[0][0].documents).toEqual([
      expect.objectContaining({ id: blank.key, name: "Новый сертификат", seriesNumber: "CERT-42", category: "certificate" }),
    ]);
  });

  it("keeps other certificates and hidden-category documents when editing or adding a block", async () => {
    const first = { ...emptyStaffDocument(), name: "Первый сертификат" };
    const second = { ...emptyStaffDocument(), name: "Второй сертификат", seriesNumber: "KEEP-2" };
    const diploma = { ...emptyStaffDocument("education"), name: "Диплом", issuer: "Университет" };
    const initial = staff({ documents: [first, second, diploma] });
    const form = editor(initial);
    form.selectTab("Сертификаты");
    expect(blocks(form.documents())).toHaveLength(2);
    field(blocks(form.documents())[0].props.children, "Кем выдан").onChange!({ target: { value: "Учебный центр" } });
    button(form.documents(), "Добавить документ").onClick!();
    expect(blocks(form.documents())).toHaveLength(3);
    await form.save();
    const saved = form.onSave.mock.calls[0][0] as StaffData;
    expect(saved.documents).toHaveLength(4);
    expect(saved.documents[0]).toMatchObject({ ...first, issuer: "Учебный центр" });
    expect(saved.documents[1]).toEqual(second);
    expect(saved.documents[2]).toEqual(diploma);
    expect(initial.documents).toEqual([first, second, diploma]);
  });

  it.each([
    ["Дипломы", "education"],
    ["Договоры", "contract"],
  ] as const)("uses the same compact blocks in the %s tab", (tab, category) => {
    const document = { ...emptyStaffDocument(category), name: "Добавленный документ", seriesNumber: "DOC-3" };
    const form = editor(staff({ documents: [document] }));
    form.selectTab(tab);
    const [block] = blocks(form.documents());
    expect(block.props).toMatchObject({ title: "Добавленный документ", defaultExpanded: false });
    expect(block.props.summary).toContain("№ DOC-3");
  });

  it("summarizes a completed work assignment and retains edits to its fields", async () => {
    const form = editor(staff());
    form.selectTab("Работа");
    const [block] = blocks(form.assignments());
    expect(block.props).toMatchObject({ title: "Инженер", defaultExpanded: false, revealKey: 0 });
    expect(block.props.summary).toBe("Компания · ИТ · Основное");
    field(block.props.children, "Должность / роль *").onChange!({ target: { value: "Главный инженер" } });
    expect(blocks(form.assignments())[0].props.title).toBe("Главный инженер");
    await form.save();
    expect(form.onSave.mock.calls[0][0].organizationalAssignments[0]).toMatchObject({ legalEntity: "Компания", department: "ИТ", position: "Главный инженер" });
  });

  it("reveals only invalid work blocks on every failed Save, including an otherwise compact Other basis", async () => {
    const initial = staff();
    initial.organizationalAssignments.push({
      ...emptyOrganizationalAssignment(), legalEntity: "Вторая компания", department: "Продажи", position: "Консультант", isPrimary: false, engagementType: "Иное", engagementOther: "",
    });
    const form = editor(initial);
    form.selectTab("Работа");
    expect(blocks(form.assignments()).map((block) => block.props.defaultExpanded)).toEqual([false, false]);
    expect(blocks(form.assignments()).map((block) => block.props.revealKey)).toEqual([0, 0]);
    form.selectTab("Сертификаты");
    await form.save();
    expect(form.onSave).not.toHaveBeenCalled();
    expect(blocks(form.assignments()).map((block) => block.props.revealKey)).toEqual([0, 1]);
    await form.save();
    expect(blocks(form.assignments()).map((block) => block.props.revealKey)).toEqual([0, 2]);
    expect(text(form.render())).toContain("Для каждого места работы заполните юрлицо");
    field(blocks(form.assignments())[1].props.children, "Пояснение основания *").onChange!({ target: { value: "Консультационное соглашение" } });
    expect(blocks(form.assignments()).map((block) => block.props.revealKey)).toEqual([0, 0]);
    await form.save();
    expect(form.onSave).toHaveBeenCalledOnce();
    expect(form.onSave.mock.calls[0][0].organizationalAssignments[1].engagementOther).toBe("Консультационное соглашение");
  });
});
