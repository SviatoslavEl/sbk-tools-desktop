import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContractEditor } from "./Contracts";
import { StaffEditor } from "../staff/Staff";
import { CompanyEditor } from "./CompanyDirectory";
import { emptyContract } from "./types";
import { emptyCompany } from "./companies";
import { emptyStaff, emptyOrganizationalAssignment } from "../staff/types";

const hooks = vi.hoisted(() => ({ stateIndex: 0, refIndex: 0, values: [] as unknown[], refs: [] as Array<{ current: unknown }>, editor: true }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: vi.fn(), useId: () => "test-field", useCallback: (fn: unknown) => fn,
  useRef: (initial: unknown) => { const index = hooks.refIndex++; return hooks.refs[index] ||= { current: initial }; },
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
  },
}));
vi.mock("../../lib/workspaceAccess", async (original) => ({ ...await original<typeof import("../../lib/workspaceAccess")>(), useWorkspaceAccess: () => ({ editor: hooks.editor, message: "" }) }));

type Props = { children?: ReactNode; onClick?: () => void; disabled?: boolean; onClose?: () => void; value?: unknown };
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement<Props>(node) ? text(node.props.children) : "";
}
function find(node: ReactNode, predicate: (type: unknown, props: Props) => boolean): Props | undefined {
  if (Array.isArray(node)) { for (const child of node) { const result = find(child, predicate); if (result) return result; } }
  else if (isValidElement<Props>(node)) { if (predicate(node.type, node.props)) return node.props; return find(node.props.children, predicate); }
}
const staff = { ...emptyStaff(), fullName: "Тестовый сотрудник", organizationalAssignments: [{ ...emptyOrganizationalAssignment(), legalEntity: "Тестовая компания", department: "ИТ", position: "Инженер" }] };
const contract = { ...emptyContract(), performingLegalEntity: "Наша компания", customer: "Заказчик", number: "ТЕСТ-1", subject: "Работы" };
const company = { ...emptyCompany("2026-09-17", "test"), name: "Тестовая компания" };

describe("actual registry save handlers retain drafts on failure", () => {
  beforeEach(() => { hooks.values = []; hooks.refs = []; hooks.editor = true; });
  it.each(["contract", "staff", "company"] as const)("%s prevents duplicate writes and close while pending, then supports retry", async (kind) => {
    let reject!: (reason: Error) => void;
    const onSave = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
    const onClose = vi.fn();
    const render = () => {
      hooks.stateIndex = 0; hooks.refIndex = 0;
      return kind === "contract" ? ContractEditor({ initialValue: contract, companies: [], onSave, onClose }) : kind === "staff" ? StaffEditor({ initialValue: staff, onSave, onClose }) : CompanyEditor({ company, companies: [], onSave, onClose });
    };
    const save = find(render(), (type, props) => type === "button" && text(props.children).startsWith("Сохранить"))!;
    save.onClick!(); save.onClick!();
    expect(onSave).toHaveBeenCalledOnce();
    expect(text(render())).toContain("Сохраняем…");
    expect(find(render(), (type, props) => type === "button" && text(props.children) === "Сохраняем…")!.disabled).toBe(true);
    find(render(), (_type, props) => typeof props.onClose === "function")!.onClose!();
    // Escape is registered inside useUnsavedChanges and reaches its closeRef,
    // not the drawer's wrapper; it must be protected independently as well.
    const hookClose = hooks.refs.find((entry) => typeof entry.current === "function")!.current as () => void | Promise<void>;
    await hookClose();
    expect(onClose).not.toHaveBeenCalled();
    reject(new Error("Тестовый сетевой диск недоступен"));
    await vi.waitFor(() => expect(text(render())).toContain("Введённые данные остались в форме"));
    expect(text(render())).toContain("Тестовый сетевой диск недоступен");
    expect(find(render(), (type, props) => type === "input" && props.value === (kind === "contract" ? "ТЕСТ-1" : kind === "staff" ? "Тестовый сотрудник" : "Тестовая компания"))).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    find(render(), (type, props) => type === "button" && text(props.children).startsWith("Сохранить"))!.onClick!();
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
  });
});
