import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceAccessProvider, ReadOnlyWorkspaceBoundary, workspaceControlIsBlocked, applyWorkspaceControlAccess } from "./workspaceAccess";

function controlStub({ title, disabled = false }: { title?: string; disabled?: boolean } = {}) {
  const attributes = new Map<string, string>();
  if (title !== undefined) attributes.set("title", title);
  return {
    disabled,
    dataset: {} as Record<string, string | undefined>,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => { attributes.set(name, value); },
    removeAttribute: (name: string) => { attributes.delete(name); },
  };
}

describe("workspace access UI", () => {
  it("announces viewer mode to every registry boundary", () => {
    const html = renderToStaticMarkup(<WorkspaceAccessProvider editor={false} message="viewer"><ReadOnlyWorkspaceBoundary><button>Добавить запись</button><button>Экспорт</button></ReadOnlyWorkspaceBoundary></WorkspaceAccessProvider>);
    expect(html).toContain('data-workspace-access="viewer"');
    expect(html).toContain("Экспорт");
  });

  it("blocks only explicit mutations while keeping viewer tools available", () => {
    expect(workspaceControlIsBlocked(false, false, true, false, false)).toBe(true);
    expect(workspaceControlIsBlocked(false, false, false, false, false)).toBe(false);
    expect(workspaceControlIsBlocked(false, false, true, false, true)).toBe(false);
    expect(workspaceControlIsBlocked(true, false, true, true, false)).toBe(false);
  });
});

describe("workspace control tooltip lifecycle", () => {
  it("updates the blocked explanation when the editor changes, then restores the original tooltip", () => {
    const control = controlStub({ title: "Настройка срока уведомлений" });
    applyWorkspaceControlAccess(control, true, "Только просмотр: QA-MAC-EDITOR");
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.getAttribute("title")).toBe("Только просмотр: QA-MAC-EDITOR");

    applyWorkspaceControlAccess(control, true, "Только просмотр: QA-WINDOWS-EDITOR");
    expect(control.getAttribute("title")).toBe("Только просмотр: QA-WINDOWS-EDITOR");
    expect(control.dataset.workspaceOriginalTitle).toBe("Настройка срока уведомлений");

    applyWorkspaceControlAccess(control, false, "Редактор");
    expect(control.disabled).toBe(false);
    expect(control.getAttribute("aria-disabled")).toBeNull();
    expect(control.getAttribute("title")).toBe("Настройка срока уведомлений");
    expect(control.dataset).toEqual({});
  });

  it("removes the viewer tooltip when the original control had no title attribute", () => {
    const control = controlStub();
    applyWorkspaceControlAccess(control, true, "Только просмотр");
    applyWorkspaceControlAccess(control, false, "");
    expect(control.getAttribute("title")).toBeNull();
    expect(control.disabled).toBe(false);
  });

  it("preserves an explicitly empty original title", () => {
    const control = controlStub({ title: "" });
    applyWorkspaceControlAccess(control, true, "Только просмотр");
    applyWorkspaceControlAccess(control, false, "");
    expect(control.getAttribute("title")).toBe("");
  });

  it("does not enable controls that were already disabled before entering viewer mode", () => {
    const control = controlStub({ disabled: true, title: "Сначала выберите запись" });
    applyWorkspaceControlAccess(control, true, "Только просмотр: первый редактор");
    applyWorkspaceControlAccess(control, true, "Только просмотр: другой редактор");
    applyWorkspaceControlAccess(control, false, "");
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("title")).toBe("Сначала выберите запись");
  });

  it("uses the fallback for an empty status and reasserts the existing disabled guard", () => {
    const control = controlStub();
    applyWorkspaceControlAccess(control, true, "Только просмотр");
    control.disabled = false;
    applyWorkspaceControlAccess(control, true, "");
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("title")).toBe("Общая база открыта только для просмотра");
    applyWorkspaceControlAccess(control, false, "");
    expect(control.disabled).toBe(false);
  });

  it("does not touch a control that is not blocked by the workspace boundary", () => {
    const control = controlStub({ disabled: true, title: "Нет выбранных данных" });
    control.setAttribute("aria-disabled", "true");
    applyWorkspaceControlAccess(control, false, "Редактор");
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("title")).toBe("Нет выбранных данных");
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(control.dataset).toEqual({});
  });

  it("captures the current original tooltip again on a later viewer session", () => {
    const control = controlStub({ title: "Первая подсказка" });
    applyWorkspaceControlAccess(control, true, "Первый редактор");
    applyWorkspaceControlAccess(control, false, "");
    control.setAttribute("title", "Обновлённая подсказка");
    applyWorkspaceControlAccess(control, true, "Следующий редактор");
    applyWorkspaceControlAccess(control, false, "");
    expect(control.getAttribute("title")).toBe("Обновлённая подсказка");
  });
});
