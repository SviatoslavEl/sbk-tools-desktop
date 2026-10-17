import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomaticConditionsSummary } from "./AutomaticConditionsSummary";
import type { AutoConditionChange, AutoConditionResult, AutoConditionSkipped } from "./automaticConditions";
import type { IntelligenceItem } from "./workbenchTypes";

type Receipt = Omit<AutoConditionResult, "items">;
type Element = ReactElement<Record<string, unknown>>;
const card = (id = "card-a", title = "Закупка QA"): IntelligenceItem => ({ id, title, destination: "procurement", fields: { requirements: ["Ручная строка"] }, selectedFields: ["requirements"], sourceIds: ["source-a"], evidence: [] });
const change = (extra: Partial<AutoConditionChange> = {}): AutoConditionChange => ({ itemId: "card-a", field: "requirements", kind: "added", category: "certificate", sourceId: "source-a", sourceName: "Синтетическое ТЗ QA", fragmentId: "page-3", locator: "Страница 3", quote: "Сертификат OSCP — не менее 5 специалистов.", requiresReview: true, ...extra });
const skip = (extra: Partial<AutoConditionSkipped> = {}): AutoConditionSkipped => ({ field: "requirements", reason: "multiple-cards", message: "Принадлежность условия неоднозначна; распределите по исходнику.", itemId: "card-a", requiresReview: true, ...extra });
const receipt = (changes: AutoConditionChange[] = [change()], skipped: AutoConditionSkipped[] = [], limited = false): Receipt => ({ changes, skipped, limited });
function nodes(value: ReactNode): Element[] { if (Array.isArray(value)) return value.flatMap(nodes); if (!isValidElement<Record<string, unknown>>(value)) return []; return [value, ...nodes(value.props.children as ReactNode)]; }
function textOf(value: ReactNode): string { if (Array.isArray(value)) return value.map(textOf).join(""); if (isValidElement<Record<string, unknown>>(value)) return textOf(value.props.children as ReactNode); return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
const render = (value: Receipt | null, items = [card()]) => AutomaticConditionsSummary({ receipt: value, items });
const freeze = <T,>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };
afterEach(() => { vi.unstubAllGlobals(); });

describe("automatic-condition preparation receipt UI", () => {
  it("renders nothing before preparation, for an empty receipt or when no cards remain", () => {
    expect(render(null)).toBeNull(); expect(render(receipt([]))).toBeNull(); expect(render(receipt(), [])).toBeNull();
    expect(render(receipt([], [skip()], true), [])).toBeNull();
  });

  it("does not show procurement skips or completeness warnings for staff-only or unrelated cards", () => {
    const staff: IntelligenceItem = { ...card(), destination: "staff", fields: { fullName: "Сотрудник QA", certificates: ["OSCP"] } };
    expect(render(receipt([], [skip({ itemId: undefined })], true), [staff])).toBeNull();
    expect(render(receipt([change()], [skip()], true), [staff])).toBeNull();
    expect(render(receipt([], [skip({ itemId: undefined })], true), [{ ...staff, destination: "contracts" }])).toBeNull();
    expect(render(receipt([], [skip({ itemId: undefined })], true), [staff, card("procurement-b")])).not.toBeNull();
  });

  it("counts added and present conditions separately without claiming verification or attachments", () => {
    const tree = render(receipt([change(), change({ category: "document", kind: "present", quote: "Копия доверенности, если подписывает представитель." })]));
    expect(textOf(tree)).toContain("автоматически добавлено: 1 · уже было: 1");
    expect(textOf(tree)).toContain("Добавлено при подготовке · Сертификат"); expect(textOf(tree)).toContain("Уже было в ответе · Документ / условие заявки");
    expect(textOf(tree)).toContain("не становятся прикреплёнными файлами или подтверждёнными сведениями");
    expect(nodes(tree).filter((entry) => entry.props.role === "status")).toHaveLength(1);
    expect(nodes(tree).find((entry) => entry.type === "details")?.props.open).toBeUndefined();
  });

  it("shows document exceptions as exceptions and retains their complete literal qualifications", () => {
    const quote = "Документы могут не включаться в заявку, если находятся в открытом реестре и в заявку включена декларация.";
    const tree = render(receipt([change({ category: "exception", quote })]));
    expect(textOf(tree)).toContain("Оговорка к документам"); expect(textOf(tree)).toContain(quote);
    expect(nodes(tree).find((entry) => entry.type === "blockquote")?.props.children).toBe(quote);
    expect(textOf(tree)).toContain("применимость условий нужно проверить");
    expect(textOf(tree)).not.toContain("Обязательный документ");
  });

  it("shows the current card title and exact source name, locator and quote", () => {
    const entry = change({ sourceName: "ТЗ QA редакция 2.docx", locator: "Страница 3 · пункт 4.2", quote: "OSCP — не менее 5; OSEP — не менее 2." });
    const tree = render(receipt([entry]));
    expect(textOf(tree)).toContain("Закупка QA · ТЗ QA редакция 2.docx · Страница 3 · пункт 4.2");
    expect(nodes(tree).find((element) => element.type === "blockquote")?.props.children).toBe(entry.quote);
  });

  it("warns about skipped conditions and shows their complete reason and provenance", () => {
    const entry = skip({ sourceId: "source-a", sourceName: "ТЗ с альтернативами QA", locator: "Раздел 7", category: "exception", quote: "Копия полномочий или выписка из реестра, если подписывает представитель." });
    const tree = render(receipt([], [entry]));
    expect(textOf(tree)).toContain("Не дополнено автоматически: 1"); expect(textOf(tree)).toContain("Автодополнение неполное");
    expect(textOf(tree)).toContain("Это не подтверждение полноты."); expect(textOf(tree)).toContain(entry.message);
    expect(textOf(tree)).toContain("ТЗ с альтернативами QA · Раздел 7"); expect(textOf(tree)).toContain(entry.quote!);
    expect(nodes(tree).filter((element) => element.props.role === "status")).toHaveLength(2);
  });

  it("keeps global parser-limit warnings even if there is no changed or skipped row", () => {
    const tree = render(receipt([], [], true));
    expect(tree).not.toBeNull(); expect(textOf(tree)).toContain("автоматически добавлено: 0 · уже было: 0");
    expect(textOf(tree)).toContain("Автодополнение неполное"); expect(textOf(tree)).not.toContain("подтверждена полнота");
  });

  it("hides removed-card changes and per-card skipped rows without corrupting the historical receipt", () => {
    const value = receipt([change({ itemId: "removed", quote: "Условие удалённой карточки" }), change({ quote: "Условие оставшейся карточки" })], [skip({ itemId: "removed", message: "Ошибка удалённой карточки" }), skip({ message: "Проверить оставшуюся карточку" })]);
    const before = structuredClone(value); freeze(value);
    const tree = render(value);
    expect(textOf(tree)).not.toContain("Условие удалённой карточки"); expect(textOf(tree)).not.toContain("Ошибка удалённой карточки");
    expect(textOf(tree)).toContain("Условие оставшейся карточки"); expect(textOf(tree)).toContain("Проверить оставшуюся карточку");
    expect(textOf(tree)).toContain("автоматически добавлено: 1 · уже было: 0"); expect(value).toEqual(before);
  });

  it("hides an entirely removed receipt when unrelated cards still remain", () => {
    expect(render(receipt([change({ itemId: "removed" })], [skip({ itemId: "removed" })]))).toBeNull();
  });

  it("retains a shared ambiguity warning only while at least one affected card remains", () => {
    const value = receipt([], [skip({ itemId: undefined, itemIds: ["card-a", "card-b"], message: "Распределите сертификат между двумя закупками." })]);
    expect(textOf(render(value, [card("card-b")]))).toContain("Распределите сертификат между двумя закупками.");
    expect(render(value, [card("unrelated")])).toBeNull();
  });

  it("keeps truly global source/limit warnings while cards remain", () => {
    const value = receipt([], [skip({ itemId: undefined, message: "Разбор источников достиг предела." })]);
    expect(textOf(render(value, [card("unrelated")]))).toContain("Разбор источников достиг предела.");
    expect(render(value, [])).toBeNull();
  });

  it("describes prior automatic additions as history after manual edits, never rewrites current fields", () => {
    const value = receipt(), edited = card("card-a", "Название после ручной правки"); edited.fields.requirements = ["Полностью изменённое вручную условие"]; edited.selectedFields = [];
    const before = structuredClone({ value, edited }); freeze(value); freeze(edited);
    const tree = render(value, [edited]);
    expect(textOf(tree)).toContain("Журнал подготовки черновика"); expect(textOf(tree)).toContain("Название после ручной правки");
    expect(textOf(tree)).toContain("Последующие ручные правки видны в полях и проверке результата ниже"); expect(textOf(tree)).toContain(value.changes[0].quote);
    expect(edited.fields.requirements).toEqual(["Полностью изменённое вручную условие"]); expect(edited.selectedFields).toEqual([]);
    expect({ value, edited }).toEqual(before);
  });

  it("has no database/storage/model actions and renders document markup as plain React text", () => {
    const fetch = vi.fn(), storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }; vi.stubGlobal("fetch", fetch); vi.stubGlobal("localStorage", storage); vi.stubGlobal("sessionStorage", storage);
    const quote = '<img src="synthetic://qa" onerror="writeDatabase()"> Сертификат OSCP';
    const tree = render(receipt([change({ quote })], [skip()]));
    expect(nodes(tree).find((entry) => entry.type === "blockquote")?.props.children).toBe(quote);
    expect(nodes(tree).some((entry) => ["button", "input", "select", "textarea", "form", "a", "img"].includes(String(entry.type)))).toBe(false);
    expect(nodes(tree).some((entry) => Object.keys(entry.props).some((key) => /^on[A-Z]/u.test(key) || key === "dangerouslySetInnerHTML"))).toBe(false);
    expect(fetch).not.toHaveBeenCalled(); for (const method of Object.values(storage)) expect(method).not.toHaveBeenCalled();
  });
});
