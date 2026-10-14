import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceInfo } from "../../lib/storage";
import { OwnerPanel } from "./OwnerPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const workspace: WorkspaceInfo = {
  root: "/shared/ProductData",
  portable: false,
  configured: true,
  writable: true,
  editor: false,
  editorBusy: true,
  accessControlled: true,
  accessMessage: "Редактор занят",
  ownerConfigured: true,
  editorOwner: {
    displayName: "Иван Петров · OFFICE-PC-02",
    userName: "Иван Петров",
    deviceName: "OFFICE-PC-02",
    startedAt: "2026-09-09T10:00:00Z",
  },
  schemaVersion: 1,
  freeSpaceBytes: 1024,
};

describe("compact owner panel initial UI", () => {
  it.each([
    { name: "configured owner in viewer mode", value: workspace },
    { name: "first owner setup in editor mode", value: { ...workspace, editor: true, ownerConfigured: false } },
    { name: "workspace still loading", value: null },
  ])("starts collapsed for $name without mounting sensitive controls", ({ value }) => {
    const html = renderToStaticMarkup(<OwnerPanel workspace={value} />);

    expect(html).toContain("Администрирование");
    expect(html).toMatch(/<button\b[^>]*aria-expanded="false"/);
    expect(html).not.toContain('aria-expanded="true"');
    expect(html).not.toMatch(/<(?:input|textarea|form)\b/);
    expect(html).not.toContain("Войти как владелец");
    expect(html).not.toContain("Настроить владельца");
    expect(html).not.toContain("Отозвать текущего редактора");
    expect(html).not.toContain("НАЗНАЧИТЬ ВЛАДЕЛЬЦА");
    expect(html).not.toContain('role="dialog"');
  });

  it("explains the authenticated recovery route when opened in viewer mode without invoking it", () => {
    const html = renderToStaticMarkup(<OwnerPanel workspace={{ ...workspace, editorOwner: { ...workspace.editorOwner!, deviceName: "" } }} expanded />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Зафиксирован сеанс редактора");
    expect(html).toContain("Компьютер не указан");
    expect(html).toContain("Активность этого сеанса не подтверждена");
    expect(html).toContain("Войти как владелец");
    expect(html).toContain("Как восстановить сеанс после сбоя или закрытия программы");
    expect(html).toContain("Войдите выше с отдельным паролем владельца");
    expect(html).not.toContain("Восстановить завершённый сеанс…");
    expect(html).not.toContain('role="dialog"');
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps an unknown state blocked and displays its explanation in the owner panel", () => {
    const html = renderToStaticMarkup(<OwnerPanel workspace={{ ...workspace, editorOwner: undefined, editorStateMessage: "Сеть недоступна; статус неизвестен" }} expanded />);
    expect(html).toContain("Состояние сеанса не подтверждено");
    expect(html).toContain("Сеть недоступна; статус неизвестен");
    expect(html).toContain("Войдите выше с отдельным паролем владельца");
    expect(html).not.toContain("Редактор свободен");
    expect(invoke).not.toHaveBeenCalled();
  });
});
