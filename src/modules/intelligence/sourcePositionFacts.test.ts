import { describe, expect, it } from "vitest";
import { extractSourcePositionFacts, SOURCE_POSITION_LIMITS } from "./sourcePositionFacts";
import type { IntelligenceSource } from "./workbenchTypes";

const source = (text: string, id = "source-a"): IntelligenceSource => ({ id, name: `Синтетический ${id}.pdf`, text, fragments: [{ id: "page-1", locator: "Страница 1", text }] });
const components = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `- ${prefix}: компонент ${index + 1} — 1 шт;`).join("\r\n");
const block = (sku: string, name: string, count = 2) => `Артикул: ${sku}\nНаименование: ${name}\nСостав:\n${components(count, name)}`;

describe("bounded source SKU and configuration facts", () => {
  it("binds only an explicit SKU/name/composition section, preserving exact substrings", () => {
    const text = `${block("QA-100_A", "Сервер Альфа", 19)}\n${block("QA-200_B", "Сервер Бета", 13)}`;
    const input = source(text), before = structuredClone(input);
    const result = extractSourcePositionFacts([input]);
    expect(result.positions).toHaveLength(2); expect(result.configurations).toHaveLength(2);
    expect(result.positions.map((position) => position.sku)).toEqual(["QA-100_A", "QA-200_B"]);
    expect(result.positions.map((position) => position.name)).toEqual(["Сервер Альфа", "Сервер Бета"]);
    expect(result.positions.every((position) => !position.ambiguous)).toBe(true);
    expect(result.configurations.map((configuration) => configuration.componentCount)).toEqual([19, 13]);
    expect(result.positions.map((position) => position.description)).toEqual([components(19, "Сервер Альфа"), components(13, "Сервер Бета")]);
    for (const fact of [...result.positions, ...result.configurations]) {
      expect(text).toContain(fact.quote); expect(fact.fragmentId).toBe("page-1");
      expect(fact.sourceName).toBe(input.name); expect(fact.locator).toBe("Страница 1");
      expect(fact.quote).toContain(fact.description); expect(fact.quote).toContain(fact.name);
    }
    expect(extractSourcePositionFacts([input])).toEqual(result); expect(input).toEqual(before);
  });

  it("supports an explicit SKU in each composition heading without borrowing components", () => {
    const text = `Сервер Альфа SKU: ALPHA-100 в составе:\n${components(2, "Альфа")}\nСервер Бета SKU: BETA-200 в составе:\n${components(3, "Бета")}\nУсловия оплаты: 100%`;
    const result = extractSourcePositionFacts([source(text)]);
    expect(result.positions.map((position) => [position.sku, position.name, position.ambiguous])).toEqual([["ALPHA-100", "Сервер Альфа", false], ["BETA-200", "Сервер Бета", false]]);
    expect(result.configurations.map((configuration) => configuration.componentCount)).toEqual([2, 3]);
    expect(result.configurations[1].description).not.toContain("Условия оплаты");
  });

  it("never pairs detached table rows and descriptions by their order or equal count", () => {
    const text = `№ п/п Артикул Изготовитель\r\nЕд.\r\nизм.\r\nКол-во\r\nЦена без НДС,\r\nруб.\r\nСтоимость без\r\nНДС, руб. Срок поставки\r\n1 X05QA100_E001 шт 2,00\r\n4 000,00 8 000,00\r\n2 X05QA100_F002 шт 2,00\r\n1 000,00 2 000,00\r\nУсловия оплаты: 100%\r\nНаименование оборудования\r\nРеквизиты организации\r\nСервер QA в составе:\r\n${components(19, "Состав А")}\r\nСервер QA в составе:\r\n${components(13, "Состав Б")}`;
    const result = extractSourcePositionFacts([source(text)]);
    expect(result.positions).toHaveLength(2); expect(result.configurations).toHaveLength(2);
    for (const position of result.positions) {
      expect(position.ambiguous).toBe(true); expect(position.reasons).toContain("unbound-configuration");
      expect(position.name).toBe(""); expect(position.description).toBe(""); expect(position.configurationId).toBeUndefined();
    }
    expect(result.configurations.map((configuration) => configuration.componentCount)).toEqual([19, 13]);
    expect(result.configurations.every((configuration) => configuration.reasons.includes("unbound-sku") && !configuration.sku)).toBe(true);
    expect(result.configurations.map((configuration) => configuration.description)).toEqual([components(19, "Состав А"), components(13, "Состав Б")]);
  });

  it("keeps wrapped component lines literally, counting bullet components not physical lines", () => {
    const text = "Артикул: QA-100\nСервер QA в составе:\r\n- Рельсы с поддержкой — 1\r\nшт;\r\n- Поддержка на сервер,\r\nпрограмма Базовая, 3 года — 1 шт\r\nИтого: 123";
    const result = extractSourcePositionFacts([source(text)]);
    expect(result.positions[0].ambiguous).toBe(true);
    expect(result.positions[0].reasons).toContain("uncertain-description-boundary");
    expect(result.configurations[0].componentCount).toBe(2);
    expect(result.configurations[0].description).toBe("- Рельсы с поддержкой — 1\r\nшт;\r\n- Поддержка на сервер,\r\nпрограмма Базовая, 3 года — 1 шт");
  });

  it("does not invent SKU facts from filenames, component models or placeholders", () => {
    const text = "Артикул: ______\nSKU: UNKNOWN\nSKU: 000000\nSKU: N/A\nСервер QA в составе:\n- Процессор CPU-2000 — 1 шт;\n- Кабель SKU: CABLE-44 — 2 шт;";
    const input = { ...source(text), name: "SKU-FILENAME-999.pdf" };
    const result = extractSourcePositionFacts([input]);
    expect(result.positions).toEqual([]); expect(result.configurations).toHaveLength(1);
    expect(result.configurations[0].componentCount).toBe(2);
  });

  it("does not bind across fragment, source or arbitrary prose boundaries", () => {
    const first = source("Артикул: QA-100");
    first.fragments!.push({ id: "page-2", locator: "Страница 2", text: `Сервер QA в составе:\n${components(2, "CPU")}` });
    const other = source(`Сервер QA в составе:\n${components(2, "RAM")}`, "source-b");
    const result = extractSourcePositionFacts([first, other]);
    expect(result.positions[0].description).toBe("");
    expect(result.configurations.every((configuration) => !configuration.positionId && configuration.ambiguous)).toBe(true);
    const prose = extractSourcePositionFacts([source(`Артикул: QA-100\nОтдельный раздел с другой информацией\nСервер QA в составе:\n${components(2, "CPU")}`)]);
    expect(prose.positions[0].configurationId).toBeUndefined();
  });

  it("does not treat prose mentioning an SKU as an owning section or a table header", () => {
    const prose = extractSourcePositionFacts([source(`Пример из прошлого: SKU: OLD-100\nСервер QA в составе:\n${components(1, "CPU")}`)]);
    expect(prose.positions[0].sku).toBe("OLD-100"); expect(prose.positions[0].configurationId).toBeUndefined();
    expect(prose.configurations[0].reasons).toContain("unbound-sku");
    const noTable = extractSourcePositionFacts([source("В тексте упомянут артикул, но таблицы нет\n1 CPU-100 условие требования")]);
    expect(noTable.positions).toEqual([]);
  });

  it("keeps an unlabelled name or incomplete prose boundary ambiguous", () => {
    const noName = extractSourcePositionFacts([source(`SKU: QA-100\nСостав:\n${components(1, "CPU")}`)]);
    expect(noName.positions[0].reasons).toContain("missing-name"); expect(noName.positions[0].ambiguous).toBe(true);
    const boundary = extractSourcePositionFacts([source(`SKU: QA-100\nСервер QA в составе:\n${components(1, "CPU")}\nОтдельный необозначенный абзац`)]);
    expect(boundary.configurations[0].reasons).toContain("uncertain-description-boundary");
    expect(boundary.positions[0].ambiguous).toBe(true);
    expect(boundary.positions[0].description).not.toContain("Отдельный необозначенный абзац");
  });

  it("does not resurrect aggregate text for an empty or hidden fragment selection", () => {
    const text = block("SECRET-100", "Скрытая комплектация");
    const input = source(text);
    input.fragments = [{ id: "hidden", locator: "Скрытый лист", text, sheetState: "hidden" }];
    expect(extractSourcePositionFacts([input]).positions).toEqual([]);
    input.fragments[0].includedByUser = true;
    expect(extractSourcePositionFacts([input]).positions[0].sku).toBe("SECRET-100");
    input.fragments = [];
    expect(extractSourcePositionFacts([input]).positions).toEqual([]);
    input.fragments = undefined;
    expect(extractSourcePositionFacts([input]).positions[0].sku).toBe("SECRET-100");
  });

  it("retains repeated SKU occurrences separately and marks ambiguous provenance", () => {
    const a = source(block("SAME-100", "Альфа"));
    const b = source(block("SAME-100", "Бета"), "source-b");
    const result = extractSourcePositionFacts([a, b]);
    expect(result.positions).toHaveLength(2);
    expect(new Set(result.positions.map((position) => position.id)).size).toBe(2);
    expect(result.positions.every((position) => position.ambiguous && position.reasons.includes("duplicate-sku"))).toBe(true);
    expect(result.configurations.every((configuration) => configuration.ambiguous)).toBe(true);
    expect(result.positions.map((position) => position.description)).toEqual([components(2, "Альфа"), components(2, "Бета")]);
    const conflicting = extractSourcePositionFacts([source(`SKU: QA-100; SKU: QA-200\nСервер QA в составе:\n${components(1, "CPU")}`)]);
    expect(conflicting.configurations[0].reasons).toContain("multiple-sku-section");
    expect(conflicting.positions.every((position) => !position.configurationId)).toBe(true);
  });

  it("flags incomplete sources, duplicate fragment IDs and duplicate source IDs", () => {
    const input = source(block("QA-100", "Сервер")); input.coverage = { complete: false, requiresOcr: true };
    expect(extractSourcePositionFacts([input]).positions[0].reasons).toContain("incomplete-source");
    const duplicate = source(block("QA-100", "Сервер")); duplicate.fragments!.push({ ...duplicate.fragments![0], text: block("QA-200", "Другой сервер") });
    expect(extractSourcePositionFacts([duplicate]).positions.every((position) => position.reasons.includes("duplicate-fragment-id") && position.ambiguous)).toBe(true);
    expect(extractSourcePositionFacts([source(block("QA-100", "A")), source(block("QA-200", "B"))]).positions).toEqual([]);
  });

  it("uses stable fact IDs when authoritative sources/fragments are reordered", () => {
    const a = source(block("QA-100", "Альфа")), b = source(block("QA-200", "Бета"), "source-b");
    const bySku = (inputs: IntelligenceSource[]) => Object.fromEntries(extractSourcePositionFacts(inputs).positions.map((position) => [position.sku, [position.id, position.configurationId]]));
    expect(bySku([a, b])).toEqual(bySku([b, a]));
    a.fragments!.push({ id: "page-2", locator: "Страница 2", text: block("QA-300", "Гамма") });
    const first = bySku([a]); a.fragments!.reverse(); expect(bySku([a])).toEqual(first);
  });

  it("skips oversized descriptions/fragments whole, never returning a silently cut valid pair", () => {
    const hugeDescription = `Артикул: QA-100\nСервер QA в составе:\n- ${"x".repeat(SOURCE_POSITION_LIMITS.descriptionCharacters + 1)}`;
    const result = extractSourcePositionFacts([source(hugeDescription)]);
    expect(result.truncated).toBe(true); expect(result.configurations).toEqual([]);
    expect(result.positions[0].description).toBe(""); expect(result.positions[0].ambiguous).toBe(true);
    const oversized = extractSourcePositionFacts([source(`${block("QA-100", "A")}\n${"x".repeat(SOURCE_POSITION_LIMITS.fragmentCharacters)}`)]);
    expect(oversized.truncated).toBe(true); expect(oversized.positions).toEqual([]);
    const many = extractSourcePositionFacts([source(Array.from({ length: 101 }, (_, index) => `SKU: QA-${index}`).join("\n"))]);
    expect(many.positions).toHaveLength(100); expect(many.truncated).toBe(true);
  });

  it("bounds sources, fragment counts, lines and total UTF-8 text, without scanning aggregate text", () => {
    const manySources = Array.from({ length: 101 }, (_, index) => source(`SKU: QA-${index}`, `source-${index}`));
    const limitedSources = extractSourcePositionFacts(manySources);
    expect(limitedSources.positions).toHaveLength(100); expect(limitedSources.truncated).toBe(true);
    const manyFragments = source("SKU: NEVER-999");
    manyFragments.fragments = Array.from({ length: 1001 }, (_, index) => ({ id: `fragment-${index}`, locator: `Фрагмент ${index}`, text: "нет артикула" }));
    const limitedFragments = extractSourcePositionFacts([manyFragments]);
    expect(limitedFragments.positions).toEqual([]); expect(limitedFragments.truncated).toBe(true);
    expect(extractSourcePositionFacts([source(`SKU: QA-100\n${"\n".repeat(3001)}`)]).positions).toEqual([]);
    const bytes = source(""); bytes.fragments = Array.from({ length: 8 }, (_, index) => ({ id: `fragment-${index}`, locator: `Фрагмент ${index}`, text: "я".repeat(80_000) }));
    expect(extractSourcePositionFacts([bytes]).truncated).toBe(true);
  });
});
