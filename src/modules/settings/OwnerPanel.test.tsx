import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "../../lib/storage";
import { OwnerPanel } from "./OwnerPanel";

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
});
