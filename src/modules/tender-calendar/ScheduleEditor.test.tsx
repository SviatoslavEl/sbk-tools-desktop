// @ts-expect-error Node's built-in module is available in the test runner.
import { readFileSync } from "node:fs";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { parse } from "postcss";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScheduleEditor } from "./TenderCalendar";
import { DrawerBackdrop } from "../../components/DrawerBackdrop";
import { ModalOverlay } from "../../components/ModalOverlay";
import { ConfirmDialog } from "../../components/Dialog";

const hooks = vi.hoisted(() => ({ index: 0, values: [] as unknown[] }));

// Component-operation tests exercise real close/dirty handlers and rendered
// structure. Shared modalStack tests cover DOM focus/Escape ordering separately.
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: vi.fn(),
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

type Props = { children?: ReactNode; className?: string; onClose?: () => void; onChange?: (event: { target: { value: string } }) => void; placeholder?: string; value?: unknown; };
function find(node: ReactNode, predicate: (element: ReactElement<Props>) => boolean): ReactElement<Props> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) { const match = find(child, predicate); if (match) return match; }
  } else if (isValidElement<Props>(node)) {
    if (predicate(node)) return node;
    return find(node.props.children, predicate);
  }
  return undefined;
}
function form() {
  const onClose = vi.fn();
  const render = () => {
    hooks.index = 0;
    return ScheduleEditor({ initialDate: "2026-09-16", procurements: [], staff: [], allSchedules: [], onSave: vi.fn(), onClose });
  };
  return { render, onClose };
}

describe("calendar editor overlay and viewport contract", () => {
  beforeEach(() => { hooks.index = 0; hooks.values = []; });

  it("uses the shared modal stack and exactly header, scrolling body, footer rows", () => {
    const editor = form();
    const backdrop = find(editor.render(), (node) => node.type === DrawerBackdrop)!;
    const overlay = DrawerBackdrop({ children: backdrop.props.children, onClose: backdrop.props.onClose! });
    expect(overlay.type).toBe(ModalOverlay);
    expect(overlay.props.onClose).toBe(backdrop.props.onClose);
    const aside = find(backdrop, (node) => node.type === "aside")!;
    expect(aside.props.className).toBe("detail-drawer schedule-drawer");
    const rows = Children.toArray(aside.props.children) as ReactElement<Props>[];
    expect(rows.map((row) => row.type)).toEqual(["header", "div", "footer"]);
    expect(rows[1].props.className).toBe("drawer-body schedule-editor");
    backdrop.props.onClose!();
    expect(editor.onClose).toHaveBeenCalledOnce();
  });

  it("keeps discard confirmation outside the drawer and preserves typed data when cancelled", () => {
    const editor = form();
    const title = find(editor.render(), (node) => node.type === "input" && Boolean(node.props.placeholder?.startsWith("Например,")))!;
    title.props.onChange!({ target: { value: "Проверка календаря" } });
    find(editor.render(), (node) => node.type === DrawerBackdrop)!.props.onClose!();
    expect(editor.onClose).not.toHaveBeenCalled();
    const tree = editor.render();
    const siblings = Children.toArray(tree.props.children) as ReactElement<Props>[];
    expect(siblings.map((node) => node.type)).toEqual([DrawerBackdrop, ConfirmDialog]);
    expect(find(siblings[0], (node) => node.type === ConfirmDialog)).toBeUndefined();
    siblings[1].props.onClose!();
    const restored = editor.render();
    expect(find(restored, (node) => node.type === ConfirmDialog)).toBeUndefined();
    expect(find(restored, (node) => node.type === "input" && Boolean(node.props.placeholder?.startsWith("Например,")))!.props.value).toBe("Проверка календаря");
    expect(editor.onClose).not.toHaveBeenCalled();
  });

  it("allocates one flexible scroll row and preserves wide/narrow drawer sizing", () => {
    const css = parse(readFileSync(new URL("../../App.css", import.meta.url), "utf8"));
    const values = (selector: string) => {
      const declarations: Record<string, string> = {};
      css.walkRules(selector, (rule) => {
        if (rule.parent?.type === "root") rule.walkDecls((decl) => { declarations[decl.prop] = decl.value; });
      });
      return declarations;
    };
    expect(values(".schedule-drawer")).toMatchObject({ width: "min(1040px, calc(100vw - 90px))", "grid-template-rows": "auto minmax(0, 1fr) auto" });
    expect(values(".detail-drawer")).toMatchObject({ position: "fixed", top: "0", bottom: "0", "min-height": "0" });
    expect(values(".drawer-body")).toMatchObject({ "min-height": "0", overflow: "auto" });
    const responsiveWidths: string[] = [];
    css.walkRules((rule) => {
      if (rule.parent?.type === "atrule" && rule.selectors.includes(".schedule-drawer")) {
        rule.walkDecls("width", (decl) => { responsiveWidths.push(decl.value); });
      }
    });
    expect(responsiveWidths).toContain("calc(100vw - 64px)");
  });
});
