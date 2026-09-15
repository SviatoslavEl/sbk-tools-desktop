import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AnnotationColorPicker } from "./AnnotationColorPicker";

describe("scanner colour picker", () => {
  it("names every quick colour and exposes an arbitrary colour control", () => {
    const html = renderToStaticMarkup(<AnnotationColorPicker kind="marker" value="#ffd84d" label="Цвет нового маркера" onChange={() => undefined} />);
    for (const colour of ["Жёлтый", "Зелёный", "Голубой", "Розовый", "Тёмно-серый", "Чёрный", "Белый"]) {
      expect(html).toContain(`aria-label="Цвет нового маркера: ${colour}"`);
    }
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain('type="color"');
    expect(html).toContain('aria-label="Цвет нового маркера: свой цвет"');
    expect(html).toContain('value="#ffd84d"');
    expect(html).toContain('role="group"');
  });

  it("shows a saved custom colour without falsely selecting a standard swatch", () => {
    const html = renderToStaticMarkup(<AnnotationColorPicker kind="stroke" value="#983EAb" label="Цвет «Штрих», страница 2" onChange={() => undefined} />);
    expect(html).toContain('value="#983eab"');
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Цвет «Штрих», страница 2: свой цвет"');
  });

  it("disables both swatches and the custom picker while the document is loading", () => {
    const html = renderToStaticMarkup(<AnnotationColorPicker kind="stroke" value="#202020" label="Цвет нового штриха" disabled onChange={() => undefined} />);
    expect(html.match(/disabled=""/g)).toHaveLength(8);
  });
});
