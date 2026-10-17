// @ts-expect-error Node's built-in module is available in the test runner.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { parse } from "postcss";
import { describe, expect, it } from "vitest";
import { Dialog, ConfirmDialog } from "./Dialog";
import { DrawerBackdrop } from "./DrawerBackdrop";
import { readModalWorkspaceMarkers } from "./ModalOverlay";
import { ReadOnlyWorkspaceBoundary, WorkspaceAccessProvider, useWorkspaceBoundaryPolicy, workspaceControlIsBlocked, applyWorkspaceControlAccess } from "../lib/workspaceAccess";

function PolicyProbe() {
  const policy = useWorkspaceBoundaryPolicy();
  return <output>{JSON.stringify(policy)}</output>;
}

describe("modal workspace policy and accessible markup", () => {
  it("attaches the first preview/OCR and custom-content drawer with their names and controls before any busy update", () => {
    for (const title of ["Итоговый просмотр · страница 2", "Загрузить документ из окна ИИ для OCR?"]) {
      const html = renderToStaticMarkup(<Dialog title={title} onClose={() => {}}><button>Вернуться / Загрузить</button></Dialog>);
      const section = html.match(/<section[^>]+>/)?.[0];
      expect(section).toContain('role="dialog"');
      expect(section).toContain('aria-modal="true"');
      expect(section).toContain('aria-labelledby=');
      expect(section).not.toContain('opacity:0');
      expect(section).not.toMatch(/(?:aria-hidden|inert)=/);
      expect(html).toContain(title); expect(html).toContain("Вернуться / Загрузить");
    }
    function DrawerContent() {
      return <aside className="detail-drawer" role="dialog" aria-modal="true" aria-label="Карточка компании"><button data-autofocus>Закрыть карточку</button><span role="status">Сохранено</span></aside>;
    }
    const drawer = renderToStaticMarkup(<DrawerBackdrop onClose={() => {}}><DrawerContent /></DrawerBackdrop>);
    expect(drawer).toContain('class="detail-drawer" role="dialog" aria-modal="true" aria-label="Карточка компании"');
    expect(drawer).toContain('data-autofocus="true"');
    expect(drawer).toContain("Закрыть карточку");
    expect(drawer).toContain('role="status"');
  });

  it("keeps modal surfaces visible at their first focus registration without removing unrelated motion", () => {
    const styles = parse(readFileSync(new URL("../App.css", import.meta.url), "utf8"));
    const modalDeclarations: string[] = [];
    styles.walkRules((rule) => {
      if (!rule.selectors.some((selector) => selector === ".dialog" || selector === ".detail-drawer")) return;
      rule.walkDecls((declaration) => {
        if (declaration.prop === "animation" || declaration.prop === "animation-name" || declaration.prop === "opacity") modalDeclarations.push(`${declaration.prop}:${declaration.value}`);
      });
    });
    expect(modalDeclarations).toEqual([]);
    const animationNames: string[] = [];
    styles.walkAtRules("keyframes", (rule) => { animationNames.push(rule.params); });
    expect(animationNames).not.toContain("appear");
    expect(animationNames).toContain("startup-slide");
    expect(styles.toString()).toContain("transition: background-color .12s ease");
  });

  it("inherits the nearest explicit boundary without making viewer dialogs editable", () => {
    const ordinary = renderToStaticMarkup(<WorkspaceAccessProvider editor={false} message="Другой редактор"><ReadOnlyWorkspaceBoundary><PolicyProbe /></ReadOnlyWorkspaceBoundary></WorkspaceAccessProvider>);
    expect(ordinary).toContain('&quot;allowMutations&quot;:false');
    const scanner = renderToStaticMarkup(<WorkspaceAccessProvider editor={false} message="Просмотр"><ReadOnlyWorkspaceBoundary allowMutations><Dialog title="Сканер" onClose={() => {}}><PolicyProbe /></Dialog></ReadOnlyWorkspaceBoundary></WorkspaceAccessProvider>);
    expect(scanner).toContain('&quot;allowMutations&quot;:true');
    const strict = renderToStaticMarkup(<ReadOnlyWorkspaceBoundary allowMutations><ReadOnlyWorkspaceBoundary disableFormControls><PolicyProbe /></ReadOnlyWorkspaceBoundary></ReadOnlyWorkspaceBoundary>);
    expect(strict).toContain('&quot;allowMutations&quot;:false,&quot;disableFormControls&quot;:true');
  });

  it("carries mutation and owner exceptions from the origin instead of granting access to every portal", () => {
    const origin = (attributes: string[]) => ({ closest: (selector: string) => attributes.includes(selector) ? {} : null }) as Pick<HTMLElement, "closest">;
    const ordinary = readModalWorkspaceMarkers(origin(["[data-workspace-mutation]"]));
    const owner = readModalWorkspaceMarkers(origin(["[data-workspace-mutation]", "[data-workspace-viewer-allowed]"]));
    expect(ordinary).toEqual({ mutation: true, viewerAllowed: false, componentManaged: false, networkLocal: false });
    expect(owner).toEqual({ mutation: true, viewerAllowed: true, componentManaged: false, networkLocal: false });
    expect(readModalWorkspaceMarkers(origin(["[data-network-offline-allowed]"])).networkLocal).toBe(true);
    const attributes = new Map<string, string>();
    const control = { disabled: false, dataset: {} as Record<string, string>, getAttribute: (key: string) => attributes.get(key) ?? null, setAttribute: (key: string, value: string) => { attributes.set(key, value); }, removeAttribute: (key: string) => { attributes.delete(key); } };
    applyWorkspaceControlAccess(control, workspaceControlIsBlocked(false, false, ordinary.mutation, false, ordinary.viewerAllowed), "Другой редактор");
    expect(control.disabled).toBe(true);
    applyWorkspaceControlAccess(control, workspaceControlIsBlocked(false, false, owner.mutation, false, owner.viewerAllowed), "Другой редактор");
    expect(control.disabled).toBe(false);
    expect(workspaceControlIsBlocked(false, true, ordinary.mutation, true, false)).toBe(false);
    expect(workspaceControlIsBlocked(false, false, false, true, false)).toBe(true);
  });

  it("retains Dialog labels, confirmation controls and drawer role without changing callers", () => {
    const dialog = renderToStaticMarkup(<Dialog title="Компании" description="Справочник" onClose={() => {}} width="1100px"><input aria-label="Название" /></Dialog>);
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain("aria-describedby=");
    expect(dialog).toContain('max-width:1100px');
    const confirm = renderToStaticMarkup(<ConfirmDialog title="Закрыть?" message="Изменения не сохранены" onClose={() => {}} onConfirm={() => {}} />);
    expect(confirm).toContain("Отмена");
    expect(confirm).toContain("Подтвердить");
    const drawer = renderToStaticMarkup(<DrawerBackdrop onClose={() => {}}><aside role="dialog" aria-label="Карточка компании">Карточка</aside></DrawerBackdrop>);
    expect(drawer).toContain('class="drawer-backdrop"');
    expect(drawer).toContain('aria-label="Карточка компании"');
  });
});
