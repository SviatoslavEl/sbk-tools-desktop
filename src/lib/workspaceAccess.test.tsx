import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceAccessProvider, ReadOnlyWorkspaceBoundary, workspaceControlIsBlocked } from "./workspaceAccess";

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
