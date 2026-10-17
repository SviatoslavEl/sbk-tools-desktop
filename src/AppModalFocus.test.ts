import { describe, expect, it } from "vitest";
// @ts-expect-error Node built-ins are provided by the test runner.
import { readFileSync } from "node:fs";

describe("topbar modal mouse initiators", () => {
  it.each([
    ["network-diagnostics-button", "setShowNetworkDiagnostics"],
    ["global-search-button", "setShowSearch"],
  ])("focuses %s without scrolling before opening its modal", (className, setter) => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8") as string;
    const start = source.indexOf(`className="secondary ${className}"`);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("</button>", start);
    expect(end).toBeGreaterThan(start);
    const button = source.slice(start, end);
    expect(button).toContain("onClick={(event) => {");
    const focusIndex = button.indexOf("event.currentTarget.focus({ preventScroll: true });");
    const openIndex = button.indexOf(`${setter}(true);`);
    expect(focusIndex).toBeGreaterThanOrEqual(0);
    expect(openIndex).toBeGreaterThan(focusIndex);
  });
});
