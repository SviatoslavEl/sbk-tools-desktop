import { isValidElement, type ComponentProps, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StaffEditor } from "./Staff";
import { staffEmailFormatError, staffEmailHint } from "./emailValidation";
import { emptyOrganizationalAssignment, emptyStaff, type OrganizationalAssignment } from "./types";

const hooks = vi.hoisted(() => ({ index: 0, values: [] as unknown[], updates: [] as unknown[], editor: true }));

// Exercise the rendered component's actual field and Save handlers. This is a
// component-operation test, not a native/DOM test; effects and storage are idle.
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
  useId: () => "email-hint",
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next;
      hooks.updates.push(hooks.values[index]);
    }];
  },
}));
vi.mock("../../lib/workspaceAccess", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/workspaceAccess")>(),
  useWorkspaceAccess: () => ({ editor: hooks.editor, message: "" }),
}));

type ElementProps = { children?: ReactNode; onClick?: () => void; onChange?: (event: { target: { value: string } }) => void; value?: unknown; disabled?: boolean; "aria-label"?: string; "aria-invalid"?: boolean; className?: string; assignments?: OrganizationalAssignment[] };

function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<ElementProps>(node) ? text(node.props.children) : "";
}

function find(node: ReactNode, predicate: (type: unknown, props: ElementProps) => boolean): ElementProps | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const result = find(child, predicate); if (result) return result; }
  } else if (isValidElement<ElementProps>(node)) {
    if (predicate(node.type, node.props)) return node.props;
    return find(node.props.children, predicate);
  }
  return undefined;
}

const staff = (email: string) => ({
  ...emptyStaff(), fullName: "Тестовый сотрудник", email,
  organizationalAssignments: [{ ...emptyOrganizationalAssignment(), legalEntity: "Тестовая компания", department: "ИТ", position: "Инженер" }],
});
const record = (email: string) => ({ id: "test-staff", title: "Тестовый сотрудник", payload: staff(email), archived: false, createdAt: "2026-09-15", updatedAt: "2026-09-15" });

function editor(props: Partial<ComponentProps<typeof StaffEditor>> = {}) {
  const onSave = vi.fn().mockResolvedValue(undefined);
  const render = () => { hooks.index = 0; return StaffEditor({ onSave, onClose: vi.fn(), ...props }); };
  return { render, onSave, save: () => find(render(), (type, attributes) => type === "button" && text(attributes.children) === "Сохранить карточку")! };
}

describe("StaffEditor email through the actual Save action", () => {
  beforeEach(() => { hooks.index = 0; hooks.values = []; hooks.updates = []; hooks.editor = true; });

  it("blocks a new invalid address even when Save is clicked from another tab", () => {
    const form = editor({ initialValue: staff("not-an-email") });
    const workTab = find(form.render(), (type, props) => type === "button" && text(props.children) === "Работа")!;
    workTab.onClick!();
    form.save().onClick!();
    expect(form.onSave).not.toHaveBeenCalled();
    expect(hooks.updates).toContain(staffEmailFormatError);
    const email = find(form.render(), (type, props) => type === "input" && props["aria-label"] === "Email")!;
    expect(email.value).toBe("not-an-email");
    expect(email["aria-invalid"]).toBe(true);
    expect(text(form.render())).toContain(staffEmailHint);
  });

  it("blocks a newly typed invalid address on an existing valid card", () => {
    const form = editor({ record: record("name@example.com") });
    find(form.render(), (type, props) => type === "input" && props["aria-label"] === "Email")!.onChange!({ target: { value: "not-an-email" } });
    form.save().onClick!();
    expect(form.onSave).not.toHaveBeenCalled();
    expect(hooks.updates).toContain(staffEmailFormatError);
  });

  it("saves another field with an unchanged legacy address, warning without rewriting it", async () => {
    const previous = record("not-an-email");
    const form = editor({ record: previous });
    expect(text(form.render())).toContain("Ранее сохранённый email имеет неверный формат");
    find(form.render(), (type, props) => type === "input" && props.value === "Тестовый сотрудник")!.onChange!({ target: { value: "Новое имя" } });
    form.save().onClick!();
    await vi.waitFor(() => expect(form.onSave).toHaveBeenCalledOnce());
    expect(form.onSave).toHaveBeenCalledWith(expect.objectContaining({ fullName: "Новое имя", email: "not-an-email" }), "test-staff");
    expect(previous.payload.email).toBe("not-an-email");
  });

  it("rejects changing a legacy address to another invalid value", () => {
    const form = editor({ record: record("not-an-email") });
    find(form.render(), (type, props) => type === "input" && props["aria-label"] === "Email")!.onChange!({ target: { value: "still-invalid" } });
    form.save().onClick!();
    expect(form.onSave).not.toHaveBeenCalled();
    expect(text(form.render())).not.toContain("Ранее сохранённый email");
  });

  it.each(["", "name+tag@example.com"])("saves a new optional/valid address %s", async (email) => {
    const form = editor({ initialValue: staff(email) });
    form.save().onClick!();
    await vi.waitFor(() => expect(form.onSave).toHaveBeenCalledOnce());
    expect(form.onSave.mock.calls[0][0].email).toBe(email);
  });

  it("keeps the existing viewer guard even for an otherwise valid email", () => {
    hooks.editor = false;
    const form = editor({ initialValue: staff("name@example.com") });
    expect(form.save().disabled).toBe(true);
    form.save().onClick!();
    expect(form.onSave).not.toHaveBeenCalled();
    expect(hooks.updates.some((value) => String(value).includes("запись в общую базу запрещена"))).toBe(true);
  });

  it("updates readiness immediately after editing a work position, without rewriting the legacy role or saving", () => {
    const initialValue = staff("");
    initialValue.organizationalAssignments[0].position = "";
    const form = editor({ initialValue });
    const completeness = () => text(find(form.render(), (_type, props) => props.className === "drawer-completeness")!.children);
    expect(completeness()).toContain("Должность или роль");
    find(form.render(), (type, props) => type === "button" && text(props.children) === "Работа")!.onClick!();
    const work = find(form.render(), (_type, props) => Array.isArray(props.assignments))!;
    const updateWork = work.onChange as unknown as (assignments: OrganizationalAssignment[]) => void;
    updateWork(work.assignments!.map((assignment) => ({ ...assignment, position: "Тестировщик", startDate: "2026-09-15" })));
    expect(completeness()).not.toContain("Должность или роль");
    expect(completeness()).not.toContain("Дата начала");
    expect(form.onSave).not.toHaveBeenCalled();
    expect(hooks.values[1]).toMatchObject({ role: "", startDate: "" });
    expect(initialValue.organizationalAssignments[0].position).toBe("");
  });

  it("uses the selected primary assignment rather than a stale role or the first non-primary one", () => {
    const initialValue = staff("");
    initialValue.role = "Устаревшая роль";
    initialValue.organizationalAssignments[0].isPrimary = false;
    initialValue.organizationalAssignments.push({ ...emptyOrganizationalAssignment(), isPrimary: true, engagementType: "Иное", engagementOther: "", position: "" });
    const form = editor({ initialValue });
    const completeness = text(find(form.render(), (_type, props) => props.className === "drawer-completeness")!.children);
    expect(completeness).toContain("Должность или роль");
    expect(completeness).toContain("Основание сотрудничества");
    expect(form.onSave).not.toHaveBeenCalled();
    expect(initialValue.role).toBe("Устаревшая роль");
  });
});
