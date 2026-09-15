// @ts-expect-error Node's built-in module is available in the test runner.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { parse, type Rule } from "postcss";
import { describe, expect, it, vi } from "vitest";
import { Calculator } from "./Calculator";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    // Render the real expert form without a browser or changing its public API.
    useState: (initial: unknown) => react.useState(initial === "guided" ? "expert" : initial),
  };
});

const styles = parse(readFileSync(new URL("../../App.css", import.meta.url), "utf8"));

function declarations(selector: string, container?: string) {
  const values: Record<string, string> = {};
  styles.walkRules((rule: Rule) => {
    if (!rule.selectors.includes(selector)) return;
    if (container === undefined && rule.parent?.type !== "root") return;
    if (container !== undefined && (rule.parent?.type !== "atrule" || rule.parent.name !== "container" || rule.parent.params !== container)) return;
    rule.walkDecls((declaration) => { values[declaration.prop] = declaration.value; });
  });
  return values;
}

describe("calculator layout on small desktop windows", () => {
  it("keeps all expert sections and actions present in the responsive container", () => {
    const html = renderToStaticMarkup(<Calculator />);
    expect(html).toContain('class="module-stack calculator-module calculator-expert"');
    for (const text of ["Основные параметры", "Дополнительные расходы", "Условия сделки, агент и соисполнители", "Конкуренты и пороги", "Результат", "Сохранить расчёт", "Дублировать", "Цена и прибыль"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toMatch(/class="(?:input-column|result-column)" hidden/);
  });

  it("uses actual available width instead of the window breakpoint and stacks narrow results", () => {
    expect(declarations(".calculator-module")).toMatchObject({ "container-type": "inline-size", "container-name": "calculator" });
    expect(declarations(".calculator-module .calculator-layout")).toMatchObject({ "grid-template-columns": "minmax(0, 1fr)" });
    expect(declarations(".calculator-module .result-column")).toMatchObject({ position: "static", "grid-template-columns": "minmax(0, 1fr)" });
    expect(declarations(".calculator-module .calculator-layout", "calculator (min-width: 1100px)")).toMatchObject({ "grid-template-columns": "minmax(0, 1.08fr) minmax(0, 1fr)" });
    expect(declarations(".calculator-module .result-column", "calculator (min-width: 1100px)")).toMatchObject({ "grid-template-columns": "minmax(0, 1fr)" });
    // At 1024 px the expanded sidebar leaves about 744 px; at 800 px it
    // leaves about 554 px. Neither can accidentally enable two result cards.
    expect(declarations(".calculator-module .result-column", "calculator (min-width: 960px)")).toMatchObject({ "grid-template-columns": "repeat(2, minmax(0, 1fr))" });
  });

  it("lets form fields and repeatable rows fit their own card without fixed pixel tracks", () => {
    expect(declarations(".calculator-module .input-column")).toMatchObject({ "container-type": "inline-size", "container-name": "calculator-input", "grid-template-columns": "minmax(0, 1fr)" });
    expect(declarations(".calculator-module .input-column > *")).toMatchObject({ "min-width": "0", "max-width": "100%" });
    // The expense table intentionally remains wide for readable inputs, but
    // its own scrolling wrapper must not set the width of its grid siblings.
    expect(declarations(".expense-table-wrap")).toMatchObject({ overflow: "auto" });
    for (const selector of [".calculator-module .form-grid", ".calculator-module .form-grid.compact"]) {
      expect(declarations(selector)).toMatchObject({ "grid-template-columns": "repeat(2, minmax(0, 1fr))" });
      expect(declarations(selector, "calculator-input (min-width: 620px)")).toMatchObject({ "grid-template-columns": "repeat(3, minmax(0, 1fr))" });
      expect(declarations(selector, "calculator-input (max-width: 420px)")).toMatchObject({ "grid-template-columns": "minmax(0, 1fr)" });
    }
    for (const selector of [".calculator-module .repeatable-row", ".calculator-module .payment-stage-row"]) {
      expect(declarations(selector)["grid-template-columns"]).toBe("repeat(auto-fit, minmax(min(100%, 160px), 1fr))");
    }
  });

  it("keeps units, status, competitor labels and formula text inside their cards", () => {
    expect(declarations(".calculator-module .number-field > span")).toMatchObject({ position: "static", "overflow-wrap": "anywhere" });
    expect(declarations(".calculator-module .surface-title")).toMatchObject({ "flex-wrap": "wrap" });
    expect(declarations(".calculator-module .status")).toMatchObject({ "white-space": "normal" });
    expect(declarations(".calculator-module .competitor-bar")).toMatchObject({ "grid-template-columns": "minmax(0, 1fr) auto" });
    expect(declarations(".calculator-module .competitor-bar > div")).toMatchObject({ "grid-column": "1 / -1", "grid-row": "2" });
    expect(declarations(".calculator-module .formula-details > div")).toMatchObject({ "grid-template-columns": "minmax(0, 1fr)" });
  });
});
