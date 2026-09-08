// @ts-expect-error Node types are intentionally not included in the app build.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

describe("workflow integration guards", () => {
  it("keeps the scanner mounted but hides it outside its tool", () => {
    const app = source("./App.tsx");
    expect(app).toContain("scannerOpened");
    expect(app).toContain('hidden={activeTool !== "scanner"}');
    expect(app).toContain('active={activeTool === "scanner"}');
    expect(source("./App.css")).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });
  it("does not disable calculator inputs for viewers but keeps shared saves protected", () => {
    expect(source("./App.tsx")).not.toContain('disableFormControls={activeTool === "calculator"}');
    const calculator = source("./modules/calculator/Calculator.tsx");
    expect(calculator).toContain("!draftReady || !workspaceAccess.editor");
    expect(calculator).toContain("Локальный расчёт в режиме просмотра");
    expect(calculator).toContain("data-workspace-mutation");
    expect(calculator).toContain('scrollIntoView({ block: "start" })');
  });
  it("places calendar on dashboard and pre-fills the selected day", () => {
    const app = source("./App.tsx");
    const calendar = source("./modules/tender-calendar/TenderCalendar.tsx");
    expect(app).not.toContain('activeTool === "tender-calendar"');
    expect(app).toContain('aria-label="Календарь тендеров"');
    expect(calendar).toContain("onDoubleClick");
    expect(calendar).toContain("initialDate");
    expect(calendar).toContain("scheduleDay(cell.date)");
  });
  it("offers history in all three registries and requires confirmation to restore", () => {
    for (const path of ["./modules/staff/Staff.tsx", "./modules/contracts/Contracts.tsx", "./modules/contracts/Counterparties.tsx"]) {
      expect(source(path)).toContain("<VersionHistory");
    }
    const history = source("./components/VersionHistory.tsx");
    expect(history).toContain("<ConfirmDialog");
    expect(history).toContain("!access.editor || !entry?.snapshot || busy");
    expect(history).toContain("historyChanges(entry.snapshot, payload)");
  });
});
