import { describe, expect, it } from "vitest";
import { completeIntelligenceConditions } from "./automaticConditions";
import { extractIntelligenceConditionFacts } from "./sourceConditionFacts";
import { collectSourceFacts, validSourceFactsInventory } from "./sourceFactsWorker";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const heading = "• Управление и мониторинг: сервер должен иметь модуль удалённого управления с возможностью реализации следующих функций:";
const features = ["удалённая перезагрузка, включение/выключение сервера;", "удалённая установка операционной системы;", "виртуальная, независимая от операционной системы, текстовая и графическая консоль (Virtual KVM);", "подключение образов VirtualMedia для установки и загрузки ОС;", "поддержка управления посредством графического интерфейса и интерфейса командной строки;", "возможность удалённого обновления микрокода модуля управления и BIOS материнской платы;", "возможность загрузки с резервного образа UEFI или BMC при сбое загрузки с основного образа;", "предоставление информации об ошибках оперативной памяти и автоматическое исправление ошибок памяти;", "запись действий в KVM;", "поддержка SNMPv3;", "автоматическое уведомление о событиях по электронной почте."];
const climate = "• Климатический режим: +10…+35 °C при относительной влажности 20–80% (отдельные конфигурации могут иметь дополнительные ограничения).";
const cooling = "• Охлаждение: с поддержкой горячей замены вентиляторов.";
const address = "Место передачи оборудования: г. Тестовый, ул. Проверочная, д. 35, корпус 2.";
const paragraph = (number: number, text: string, extra: Partial<IntelligenceFragment> = {}): IntelligenceFragment => ({ id: `paragraph-${number}`, locator: `Абзац ${number}`, sheetId: "main", sheetState: "visible", text, ...extra });
const source = (): IntelligenceSource => ({ id: "technical-source", name: "Синтетическое ТЗ QA", text: "Не восстанавливать удалённые строки из агрегата", fragments: [paragraph(1, "Технические требования к оборудованию"), paragraph(2, climate), paragraph(3, heading), ...features.map((text, index) => paragraph(index + 4, text)), paragraph(15, cooling), paragraph(16, address), paragraph(17, "Сроки поставки товара: поставка не позднее 17.01.2027.")] });
const card = (): IntelligenceItem => ({ id: "technical-card", title: "Оборудование QA", destination: "procurement", fields: {}, selectedFields: [], sourceIds: ["technical-source"], evidence: [] });
const apply = (input: IntelligenceSource, item = card()) => completeIntelligenceConditions([item], [input], { includeOperational: true });
const technical = (input: IntelligenceSource) => extractIntelligenceConditionFacts([input]).facts.filter((fact) => fact.explicitTechnicalRole);

describe("source-backed operational paragraphs and closed technical feature blocks", () => {
  it("indexes every literal technical condition and all eleven features with their own header proof", () => {
    const input = source(), before = structuredClone(input), facts = technical(input);
    expect(facts.map((fact) => fact.quote)).toEqual([climate, heading, ...features, cooling, address]);
    for (const fact of facts.filter((entry) => features.includes(entry.quote))) {
      expect(fact).toMatchObject({ category: "requirement", ambiguous: true, supportingEvidence: [expect.objectContaining({ sourceId: input.id, fragmentId: "paragraph-3", quote: heading })] });
      expect(input.fragments!.find((entry) => entry.id === fact.fragmentId)?.text).toBe(fact.quote);
      expect(fact.quote).not.toContain(heading);
    }
    expect(input).toEqual(before); expect(extractIntelligenceConditionFacts([input]).limited).toBe(false);
  });

  it("copies each whole clause once, retains full literals and both actual claims, without creating structured quantities or approvals", () => {
    const input = source(), item = card(), before = structuredClone({ item, input }), result = apply(input, item), prepared = result.items[0];
    expect(prepared.fields.requirements).toEqual([climate, heading, ...features, cooling, address, input.fragments![input.fragments!.length - 1].text]);
    expect(prepared.evidence?.filter((entry) => entry.quote === heading)).toHaveLength(1);
    for (const quote of features) expect(prepared.evidence).toContainEqual(expect.objectContaining({ field: "requirements", sourceId: input.id, quote }));
    expect(result.changes.every((entry) => entry.requiresReview)).toBe(true); expect(result.limited).toBe(false);
    expect(prepared.fields).not.toHaveProperty("quantity"); expect(prepared.fields).not.toHaveProperty("licenses"); expect(prepared).not.toHaveProperty("acknowledgedEvidence");
    expect({ item, input }).toEqual(before);
    const twice = completeIntelligenceConditions(result.items, [input], { includeOperational: true });
    expect(twice.items).toEqual(result.items); expect(twice.changes.every((entry) => entry.kind === "present")).toBe(true);
  });

  it("keeps the default certificate/document-only API unchanged and never applies procurement features to staff", () => {
    expect(completeIntelligenceConditions([card()], [source()]).changes).toEqual([]);
    const staff = { ...card(), destination: "staff" as const };
    expect(apply(source(), staff).items[0]).toEqual(staff); expect(apply(source(), staff).changes).toEqual([]);
  });

  it.each(["eof", "hidden", "hidden-opted", "gap", "sheet", "table", "locator", "duplicate-id", "foreign-heading", "unknown-heading", "zero", "unsafe", "missing-locator", "nonparagraph-locator"])("does not grant technical scope to a partial block across %s", (change) => {
    const input = source(), fragments = input.fragments!;
    if (change === "eof") input.fragments = fragments.slice(0, 14);
    if (change === "hidden" || change === "hidden-opted") { fragments[8].sheetState = "hidden"; fragments[8].includedByUser = change === "hidden-opted"; }
    if (change === "gap") fragments.splice(8, 1);
    if (change === "sheet") fragments[8].sheetId = "other";
    if (change === "table") fragments[8].id = "table-row-10";
    if (change === "locator") fragments[8].locator = "Абзац 999";
    if (change === "duplicate-id") fragments[8].id = fragments[7].id;
    if (change === "foreign-heading") fragments[8].text = "Новая закупка: сторонний документ";
    if (change === "unknown-heading") fragments[8].text = "Неизвестный раздел:";
    if (change === "zero") { fragments[8].id = "paragraph-0"; fragments[8].locator = "Абзац 0"; }
    if (change === "unsafe") { fragments[8].id = "paragraph-9007199254740992"; fragments[8].locator = "Абзац 9007199254740992"; }
    if (change === "missing-locator") fragments[8].locator = "";
    if (change === "nonparagraph-locator") fragments[8].locator = "Страница 10";
    expect(technical(input).some((fact) => features.includes(fact.quote) || fact.quote === heading)).toBe(false);
    // Independent clauses such as the final delivery deadline retain their
    // old literal classification; they do not prove the detached feature list.
    expect(apply(input).changes.some((entry) => entry.quote === features[0])).toBe(false);
  });

  it("does not infer technical scope across selected sources or from excluded aggregate text", () => {
    const input = source(), head = { ...input, fragments: input.fragments!.slice(0, 3) }, tail = { ...input, id: "foreign-source", fragments: input.fragments!.slice(3) };
    expect(extractIntelligenceConditionFacts([head, tail]).facts.some((fact) => fact.explicitTechnicalRole && features.includes(fact.quote))).toBe(false);
    input.text = input.fragments!.map((entry) => entry.text).join("\n"); input.fragments = [];
    expect(technical(input)).toEqual([]); expect(apply(input).changes).toEqual([]);
  });

  it("does not trust forged role metadata on detached source fragments", () => {
    const input = source(); input.fragments = [Object.assign(paragraph(1, features[0]), { explicitTechnicalRole: true, supportingEvidence: [{ quote: heading }] })];
    expect(technical(input)).toEqual([]); expect(apply(input).changes).toEqual([]);
  });

  it("does not promote price-history technical content or reset its historical context at a technical heading", () => {
    const input = source(); input.fragments!.unshift(paragraph(0, "Источники ценовой информации:"));
    const result = apply(input);
    expect(result.changes).toEqual([]); expect(result.skipped.some((entry) => entry.reason === "informational-document")).toBe(true);
  });

  it("does not guess a feature owner among multiple procurement cards or explicit lots", () => {
    const input = source();
    const multiple = completeIntelligenceConditions([card(), { ...card(), id: "other-card" }], [input], { includeOperational: true });
    expect(multiple.changes).toEqual([]); expect(multiple.skipped.some((entry) => entry.reason === "multiple-cards")).toBe(true);
    input.fragments!.unshift(paragraph(0, "Лот №1")); input.fragments!.push(paragraph(18, "Лот №2"));
    expect(apply(input).changes).toEqual([]); expect(apply(input).skipped.some((entry) => entry.reason === "multiple-lots")).toBe(true);
  });

  it.each(["children", "characters", "field", "facts"])("fails closed on %s bounds without truncating clauses or a card", (kind) => {
    const input = source(), item = card(), before = structuredClone(item);
    if (kind === "children") input.fragments = [paragraph(1, heading), ...Array.from({ length: 33 }, (_, index) => paragraph(index + 2, `поддержка команды интерфейса ${index};`)), paragraph(35, cooling)];
    if (kind === "characters") input.fragments![4].text = "продолжение ".repeat(200000);
    if (kind === "field") input.fragments![4].text = "поддержка " + "свойство ".repeat(230) + ";";
    if (kind === "facts") input.fragments!.push(...Array.from({ length: 260 }, (_, index) => paragraph(index + 100, `Необходимо свойство ${index}.`)));
    const inventory = extractIntelligenceConditionFacts([input]), result = apply(input, item);
    if (kind === "children") expect(technical(input).some((fact) => fact.supportingEvidence?.length)).toBe(false);
    else { expect(result.limited).toBe(true); expect(result.items[0]).toEqual(before); }
    if (kind === "characters" || kind === "facts") expect(inventory.limited).toBe(true);
  });

  it("validates the additional metadata at the worker boundary without trusting arbitrary nested values", () => {
    const inventory = collectSourceFacts([source()]); expect(validSourceFactsInventory(inventory)).toBe(true);
    const feature = inventory.conditions.facts.find((entry) => entry.quote === features[0])!;
    expect(feature.supportingEvidence).toHaveLength(1);
    for (const invalid of [{ explicitTechnicalRole: "yes" }, { supportingEvidence: [null] }, { supportingEvidence: Array(17).fill({ sourceId: "a", sourceName: "A", locator: "B", quote: "C" }) }]) {
      const copy = structuredClone(inventory), entry = copy.conditions.facts.find((fact) => fact.quote === features[0])!;
      Object.assign(entry, invalid); expect(validSourceFactsInventory(copy)).toBe(false);
    }
  });
});
