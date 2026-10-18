import { describe, expect, it } from "vitest";
import type { CommercialBody } from "./commercialDocument";
import { projectCommercialBodyPublic } from "./commercialPublic";

function fixture(): CommercialBody {
  return { version: 1, sections: [
    { id: "private-scope-uuid", kind: "scope", title: "Состав работ", blocks: [
      { id: "private-scope-block", kind: "paragraph", style: "body", content: [{ kind: "text", text: "Состав работ полностью сохраняется. См. " }, { kind: "local-ref", targetId: "private-delivery-block" }] },
      { id: "private-list", kind: "list", style: "bullet", items: [[{ kind: "text", text: "При наличии доступа; без разрушительного тестирования." }], [{ kind: "local-ref", targetId: "private-delivery-uuid" }]] },
    ] },
    { id: "private-delivery-uuid", kind: "deliverables", title: "Результаты", blocks: [
      { id: "private-delivery-block", kind: "table", columns: ["Результат", "Формат"], rows: [[[ { kind: "text", text: "Отчёт" } ], [ { kind: "text", text: "DOCX и PDF" } ]]] },
    ] },
  ] };
}

describe("commercial public body projection", () => {
  it("renumbers section/block references without copying private identifiers", () => {
    const output = projectCommercialBodyPublic(fixture());
    expect(output.sections.map((section) => section.anchor)).toEqual(["s1", "s2"]);
    expect(output.sections.flatMap((section) => section.blocks.map((block) => block.anchor))).toEqual(["s1b1", "s1b2", "s2b1"]);
    expect(output.sections[0].blocks[0]).toMatchObject({ content: [{ kind: "text" }, { kind: "local-ref", target: "s2b1" }] });
    expect(output.sections[0].blocks[1]).toMatchObject({ items: [[{ kind: "text" }], [{ kind: "local-ref", target: "s2" }]] });
    expect(JSON.stringify(output.sections)).not.toMatch(/private-|targetId|sourceId|fragmentId|quoteHash|decision/);
    expect(output.anchors.get("private-delivery-block")).toBe("s2b1");
  });

  it("does not make title text an identity and allows identical headings", () => {
    const body = fixture(); body.sections[1].title = body.sections[0].title;
    const output = projectCommercialBodyPublic(body);
    expect(output.sections.map((section) => section.title)).toEqual(["Состав работ", "Состав работ"]);
    expect(output.sections[1].anchor).toBe("s2");
  });

  it("makes independent nested arrays, preserving literal Unicode and source data", () => {
    const body = fixture(), before = structuredClone(body), output = projectCommercialBodyPublic(body);
    const table = output.sections[1].blocks[0];
    if (table.kind !== "table" || table.rows[0][0][0].kind !== "text") throw new Error("fixture");
    table.rows[0][0][0].text = "Изменение результата"; table.columns[0] = "Другой заголовок";
    expect(body).toEqual(before);
  });

  it.each(["missing", "private-delivery-uuid-deleted"])("rejects a dangling private target %s", (targetId) => {
    const body = fixture(), block = body.sections[0].blocks[0];
    if (block.kind !== "paragraph") throw new Error("fixture");
    block.content.push({ kind: "local-ref", targetId });
    expect(() => projectCommercialBodyPublic(body)).toThrow(/ссылк/);
  });

  it("never exports an empty body or silently substitutes a generated paragraph", () => {
    expect(() => projectCommercialBodyPublic({ version: 1, sections: [] })).toThrow(/Пустой/);
    expect(() => projectCommercialBodyPublic({ version: 1, sections: [{ id: "empty", kind: "scope", title: "Состав", blocks: [] }] })).toThrow(/Пустой/);
  });

  it("does not accept unknown rich-text/code fields", () => {
    const body = fixture(); Object.assign(body.sections[0].blocks[0], { html: "<script>private()</script>" });
    expect(() => projectCommercialBodyPublic(body)).toThrow(/Разрешены только/);
  });
});
