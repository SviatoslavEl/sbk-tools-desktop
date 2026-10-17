import { describe, expect, it } from "vitest";
import { completeIntelligenceConditions } from "./automaticConditions";
import { extractIntelligenceConditionFacts } from "./sourceConditionFacts";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

// Anonymized, synthetic acceptance controls. No original procurement files.
const source = (text: string, id = "source-a"): IntelligenceSource => ({ id, name: "Контрольный документ", text });
const card = (): IntelligenceItem => ({ id: "card-a", destination: "procurement", title: "Проверка", fields: { name: "Проверка" }, selectedFields: ["name"], sourceIds: ["source-a"], evidence: [] });
const apply = (text: string) => completeIntelligenceConditions([card()], [source(text)]);
const requirements = (text: string) => apply(text).items[0].fields.requirements;

describe("debug3 automatic condition acceptance controls", () => {
  it("D01 retains the entire requested document proving a licence, not only a bare licence fact", () => {
    const text = "Участник закупки должен предоставить в составе заявки документ, содержащий сведения, обеспечивающие возможность подтверждения наличия лицензии на осуществление деятельности.";
    expect(extractIntelligenceConditionFacts([source(text)]).facts[0]).toMatchObject({ category: "document", quote: text });
    expect(requirements(text)).toEqual([text]);
    expect(apply(text).changes[0]).toMatchObject({ category: "document", quote: text, requiresReview: true });
    const bare = "Участник должен иметь лицензию ФСТЭК на осуществление деятельности.";
    expect(extractIntelligenceConditionFacts([source(bare)]).facts[0].category).toBe("license");
    expect(apply(bare).changes).toEqual([]);
  });

  it("G01 retains an explicitly requested authority document when a regulator is only its recipient", () => {
    for (const text of [
      "Для передачи в ФСТЭК требуется доверенность представителя.",
      "Для предоставления в ФСБ требуется декларация соответствия участника.",
      "1. Доверенность представителя для передачи в ФСТЭК.",
    ]) {
      expect(extractIntelligenceConditionFacts([source(text)]).facts[0]).toMatchObject({ category: "document", quote: text });
      expect(requirements(text)).toEqual([text]);
      expect(apply(text).changes[0]).toMatchObject({ category: "document", quote: text, requiresReview: true });
    }
    const personalCertificate = "Сертификат OSCP требуется для предоставления в ФСТЭК.";
    expect(extractIntelligenceConditionFacts([source(personalCertificate)]).facts[0].category).toBe("certificate");
    const licence = "Лицензия ФСТЭК на техническую защиту конфиденциальной информации.";
    expect(extractIntelligenceConditionFacts([source(licence)]).facts[0].category).toBe("license");
    expect(apply(licence).changes).toEqual([]);
    const licenceCopy = "Копия лицензии ФСТЭК на техническую защиту конфиденциальной информации.";
    expect(extractIntelligenceConditionFacts([source(licenceCopy)]).facts[0].category).toBe("document");
    expect(requirements(licenceCopy)).toEqual([licenceCopy]);
  });

  it("D02 keeps a one-of heading and numbered alternatives in one literal requirement", () => {
    const text = "Участник представляет один из вариантов:\n1. Копия паспорта.\n2. Выписка из ЕГРЮЛ.";
    expect(requirements(text)).toEqual([text]);
    expect(apply(text).changes).toHaveLength(1);
    const inline = "Участник представляет один из документов: копию паспорта или выписку из ЕГРЮЛ.";
    expect(requirements(inline)).toEqual([inline]);
    const separated = `${text}\nДокументы в составе заявки:\n3. Копия доверенности.`;
    expect(requirements(separated)).toEqual([text, "3. Копия доверенности."]);
  });

  it("D03 keeps a standalone nonresident qualifier with every numbered alternative it scopes", () => {
    const text = "Только для нерезидентов:\n1. Копия документа о регистрации юридического лица.\n2. Копия документа о полномочиях представителя.";
    expect(requirements(text)).toEqual([text]);
    expect(apply(text).changes[0]).toMatchObject({ quote: text, requiresReview: true });
    const inline = "1. Только для нерезидентов: копия документа о регистрации юридического лица.";
    expect(requirements(inline)).toEqual([inline]);
  });

  it("does not erase or fabricate a detached scope across fragment boundaries", () => {
    const qualifier = "Только для нерезидентов:", document = "1. Копия документа о регистрации юридического лица.";
    const input = source(`${qualifier}\n${document}`);
    input.fragments = [{ id: "scope", locator: "Абзац 1", text: qualifier }, { id: "document", locator: "Абзац 2", text: document }];
    const result = completeIntelligenceConditions([card()], [input]);
    expect(result.changes).toEqual([]);
    expect(result.skipped.some((skip) => skip.reason === "detached-scope" && skip.quote === document)).toBe(true);
    for (const fact of extractIntelligenceConditionFacts([input]).facts) expect(input.fragments.find((part) => part.id === fact.fragmentId)?.text).toContain(fact.quote);
    input.fragments[1].text = `Участник представляет один из вариантов:\n${document}\n2. Выписка из реестра.`;
    expect(completeIntelligenceConditions([card()], [input]).changes).toEqual([]);
    input.fragments[1].text = "Участник должен предоставить копию документа о регистрации юридического лица.";
    expect(completeIntelligenceConditions([card()], [input]).changes).toEqual([]);
    const foreign = source(qualifier, "other");
    expect(completeIntelligenceConditions([card()], [foreign, source(document)]).changes).toHaveLength(1);
    input.fragments[0].sheetState = "hidden";
    expect(completeIntelligenceConditions([card()], [input]).changes).toHaveLength(1);
  });

  it.each([
    "Лот: 1\n1. Сертификат OSCP — не менее 2 специалистов.\nЛот: 2\n2. Копия доверенности.",
    "Лот(№1)\n1. Сертификат OSCP — не менее 2 специалистов.\nЛот(№2)\n2. Копия доверенности.",
    "Лот №1\n1. Сертификат OSCP — не менее 2 специалистов.\nЛот №2\n2. Копия доверенности.",
    "Лот А: Анализ\n1. Сертификат OSCP — не менее 2 специалистов.\nЛот Б: Аудит\n2. Копия доверенности.",
  ])("D04 skips distribution for distinct explicit lot headers: %s", (text) => {
    const result = apply(text);
    expect(result.changes).toEqual([]);
    expect(result.skipped.some((skip) => skip.reason === "multiple-lots")).toBe(true);
  });

  it("D05 does not interpret prose verbs or references as lot identifiers", () => {
    const text = "Закупка содержит один лот. Лот включает анализ защищенности. Лот предусматривает один этап.\n1. Копия доверенности.";
    expect(requirements(text)).toEqual(["1. Копия доверенности."]);
    expect(apply(text).skipped).toEqual([]);
    expect(requirements("Лот включает анализ.\nЛот предусматривает проверку.\n1. Копия доверенности.")).toEqual(["1. Копия доверенности."]);
    expect(requirements("Сведения приведены в лоте 1, сравнение с лотом 2.\n1. Копия доверенности.")).toEqual(["1. Копия доверенности."]);
    expect(requirements("Лот 1 включает анализ.\nЛот 2 предусматривает проверку.\n1. Копия доверенности.")).toEqual(["1. Копия доверенности."]);
  });

  it("D06 keeps historical price proposals informational and leaves a receipt instead of creating obligations", () => {
    const text = "Обоснование НМЦ. Источники ценовой информации (ранее полученные предложения):\nКоммерческое предложение №101\t120000\nКоммерческое предложение №202\t130000";
    const result = apply(text);
    expect(result.changes).toEqual([]);
    expect(result.items[0].fields.requirements).toBeUndefined();
    expect(result.skipped.some((skip) => skip.reason === "informational-document" && skip.quote?.includes("№101"))).toBe(true);
    const genuine = "Участник должен предоставить в составе заявки коммерческое предложение с подписью и печатью (при наличии).";
    expect(requirements(genuine)).toEqual([genuine]);
    expect(requirements(`${text}\nДокументы в составе заявки:\n1. Коммерческое предложение участника с подписью.`)).toEqual(["1. Коммерческое предложение участника с подписью."]);
  });

  it("also suppresses historical table rows when the context is in an adjacent included fragment", () => {
    const input = source("Не использовать агрегат");
    input.fragments = [{ id: "h", locator: "Строка 1", text: "Источники ценовой информации:" }, { id: "r", locator: "Строка 2", text: "Коммерческое предложение №101\t120000" }];
    const result = completeIntelligenceConditions([card()], [input]);
    expect(result.changes).toEqual([]); expect(result.skipped.some((skip) => skip.reason === "informational-document")).toBe(true);
  });

  it("U06 gives no procurement auto-completion warning or receipt for a staff-only task", () => {
    const item: IntelligenceItem = { ...card(), destination: "staff", fields: { fullName: "Синтетический специалист", certificates: ["Личный сертификат"] }, selectedFields: ["fullName", "certificates"] };
    const input = source("Сертификат OSCP принадлежит специалисту.");
    const before = structuredClone(item), result = completeIntelligenceConditions([item], [input]);
    expect(result).toEqual({ items: [before], changes: [], skipped: [], limited: false });
  });
});
