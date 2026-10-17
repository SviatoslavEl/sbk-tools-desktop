import { describe, expect, it } from "vitest";
import { completeIntelligenceConditions } from "./automaticConditions";
import { extractIntelligenceConditionFacts } from "./sourceConditionFacts";
import { buildIntelligenceHandoff } from "./workbenchModel";
import type { IntelligenceDestination, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

// Newly authored synthetic material only. No customer document or response is
// checked into the repository; this fixture exercises the same list boundaries.
const certificates = [
  ["OSCP", 5], ["OSEP", 2], ["BSCP", 3], ["OSWE", 3], ["OSWP", 3],
  ["KLCP", 1], ["eJPT", 1], ["CompTIA PenTest+", 1], ["HTB CPTS", 3],
] as const;
const certificateRows = certificates.map(([name, count]) => `o\tСертификат ${name} — не менее ${count} специалистов;`);
const documentRows = [
  "1. Заявка в виде коммерческого предложения с подписью и печатью (при наличии) — контроль А;",
  "2. Копия выписки из ЕГРЮЛ, полученная не ранее 30 дней до подачи заявки — контроль Б;",
  "3. Копии документов о полномочиях либо доверенность представителя — контроль В;",
  "4. Решение об одобрении сделки, если требуется, либо справка об отсутствии необходимости — контроль Г;",
  "5. Декларация по приложению, заверенная печатью (при наличии) — контроль Д;",
  "7. Запрос на аккредитацию (карточка предприятия) — контроль Е;",
  "8. КНД 1120101 об отсутствии налоговой задолженности — контроль Ж;",
  "9. Типовой проект Договора с существенными условиями — контроль З;",
];
const source = (text: string, id = "synthetic-source"): IntelligenceSource => ({
  id, name: `Синтетический источник ${id}`, text,
  fragments: [{ id: `${id}-fragment`, locator: "Синтетический раздел", text }],
});
const card = (sourceIds = ["synthetic-source"], id = "synthetic-card", destination: IntelligenceDestination = "procurement"): IntelligenceItem => ({
  id, title: "Синтетическая карточка", destination, sourceIds,
  fields: destination === "procurement" ? { name: "Синтетическая закупка", requirements: ["Имеющееся модельное условие"] } : { fullName: "Синтетический сотрудник" },
  selectedFields: destination === "procurement" ? ["name", "requirements"] : ["fullName"], evidence: [],
});
const requirements = (item: IntelligenceItem): string[] => item.fields.requirements as string[];

describe("automatic condition completion: independent synthetic corpus regression", () => {
  it("automatically preserves all nine separate certificate minima and eight numbered documents", () => {
    const input = source([...certificateRows, ...documentRows].join("\n"));
    const item = card(), before = structuredClone({ item, input });
    const result = completeIntelligenceConditions([item], [input]);
    expect(result.limited).toBe(false);
    expect(requirements(result.items[0])).toEqual(["Имеющееся модельное условие", ...certificateRows, ...documentRows]);
    expect(result.changes.filter((entry) => entry.kind === "added")).toHaveLength(17);
    for (const quote of [...certificateRows, ...documentRows]) {
      expect(result.changes).toEqual(expect.arrayContaining([expect.objectContaining({
        itemId: item.id, sourceId: input.id, field: "requirements", quote, requiresReview: true,
      })]));
      expect(result.items[0].evidence).toEqual(expect.arrayContaining([expect.objectContaining({
        sourceId: input.id, fragmentId: input.fragments![0].id, field: "requirements", quote,
      })]));
    }
    expect({ item, input }).toEqual(before);
  });

  it("retains the entire conditional alternative, never just its first required document", () => {
    const rows = [
      "1. Копия выписки из ЕГРЮЛ, если заявитель юридическое лицо, либо выписка из ЕГРИП;",
      "2. Копия доверенности требуется только если подписывает представитель, иначе решение о назначении;",
    ];
    const result = completeIntelligenceConditions([card()], [source(rows.join("\n"))]);
    expect(requirements(result.items[0])).toEqual(["Имеющееся модельное условие", ...rows]);
    expect(result.changes.every((entry) => entry.requiresReview)).toBe(true);
    expect(requirements(result.items[0]).some((entry) => entry === "1. Копия выписки из ЕГРЮЛ")).toBe(false);
  });

  it("is idempotent without collapsing neighboring minima or altered conditional clauses", () => {
    const input = source([...certificateRows, ...documentRows].join("\n"));
    const item = card();
    item.fields.requirements = [
      "Сертификат OSCP — не менее 5 специалистов",
      "Сертификат OSEP — не менее 5 специалистов",
      "Копии документов о полномочиях",
    ];
    const first = completeIntelligenceConditions([item], [input]);
    const second = completeIntelligenceConditions(first.items, [input]);
    expect(second.items).toEqual(first.items);
    expect(second.changes.filter((entry) => entry.kind === "added")).toEqual([]);
    expect(requirements(first.items[0]).filter((entry) => entry.includes("OSCP"))).toHaveLength(1);
    expect(requirements(first.items[0]).filter((entry) => entry.includes("OSEP"))).toHaveLength(2);
    expect(requirements(first.items[0])).toContain(documentRows[2]);
  });

  it("does not route a tender certificate requirement into any employee's personal certificate list", () => {
    const input = source(certificateRows.join("\n"));
    const staff = card([input.id], "employee", "staff"), procurement = card();
    const before = structuredClone(staff);
    const result = completeIntelligenceConditions([staff, procurement], [input]);
    expect(result.items[0]).toEqual(before);
    expect(result.items[0].fields.certificates).toBeUndefined();
    expect(requirements(result.items[1])).toEqual(["Имеющееся модельное условие", ...certificateRows]);
    expect(result.changes.some((entry) => entry.itemId === staff.id)).toBe(false);
    const staffOnly = completeIntelligenceConditions([staff], [input]);
    expect(staffOnly.items).toEqual([staff]);
    expect(staffOnly.changes).toEqual([]);
  });

  it("does not turn local automatic extraction into a confirmed or mandatory business requirement", () => {
    const input = source(certificateRows[0]);
    const completed = completeIntelligenceConditions([card()], [input]);
    const handoff = buildIntelligenceHandoff(completed.items[0], [input], "/synthetic-unused-workspace");
    expect(handoff.destination).toBe("procurement");
    if (handoff.destination !== "procurement") throw new Error("Unexpected synthetic destination");
    expect(handoff.data.requirements).toHaveLength(2);
    expect(handoff.data.requirements.every((entry) => entry.mandatory === false && entry.status === "Не подтверждено")).toBe(true);
    expect(handoff.data.requirements[1].evidenceLinks).toEqual([]);
    expect(handoff.data.requirements[1].source).toContain(input.name);
  });

  it("keeps two separate source/card relationships separate rather than pooling all conditions", () => {
    const first = source("Сертификат OSCP — не менее 2 специалистов;", "first");
    const second = source("Копия доверенности, если подписывает представитель;", "second");
    const result = completeIntelligenceConditions([card([first.id], "a"), card([second.id], "b")], [first, second]);
    expect(requirements(result.items[0])).toEqual(["Имеющееся модельное условие", first.text]);
    expect(requirements(result.items[1])).toEqual(["Имеющееся модельное условие", second.text]);
    expect(result.changes.filter((entry) => entry.itemId === "a").every((entry) => entry.sourceId === first.id)).toBe(true);
    expect(result.changes.filter((entry) => entry.itemId === "b").every((entry) => entry.sourceId === second.id)).toBe(true);
  });

  it("does not guess which of two procurement cards sharing a source owns its conditions", () => {
    const input = source([...certificateRows, ...documentRows].join("\n"));
    const items = [card([input.id], "a"), card([input.id], "b")];
    const result = completeIntelligenceConditions(items, [input]);
    expect(result.items).toEqual(items);
    expect(result.changes).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it("does not infer lot ownership from order when two lots occur in one source", () => {
    const input = source(`Лот 1. Синтетическая услуга А\n${certificateRows[0]}\nЛот 2. Синтетическая услуга Б\n${documentRows[0]}`);
    const item = card();
    const result = completeIntelligenceConditions([item], [input]);
    expect(result.items).toEqual([item]);
    expect(result.changes).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it.each([
    "Лот А. Синтетическая услуга А\nСертификат OSCP — не менее 2 специалистов;\nЛот Б. Синтетическая услуга Б\nКопия доверенности представителя;",
    "Лоты № 1–3\nСертификат OSCP — не менее 2 специалистов;",
    "Лот А-1. Синтетическая услуга А\nСертификат OSCP — не менее 2 специалистов;\nЛот Б-2. Синтетическая услуга Б\nКопия доверенности представителя;",
  ])("fails closed for explicit alphabetic or ranged multiple-lot labels: %s", (text) => {
    const input = source(text), item = card();
    const result = completeIntelligenceConditions([item], [input]);
    expect(result.items).toEqual([item]);
    expect(result.changes).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it("never resurrects certificates from aggregate text after fragments were removed or hidden", () => {
    const aggregate = certificateRows.join("\n"), input = source(aggregate);
    input.fragments = [];
    expect(completeIntelligenceConditions([card()], [input]).changes).toEqual([]);
    input.fragments = [{ id: "hidden", locator: "Hidden", text: aggregate, sheetState: "veryHidden" }];
    expect(completeIntelligenceConditions([card()], [input]).changes).toEqual([]);
    input.fragments[0].includedByUser = true;
    expect(completeIntelligenceConditions([card()], [input]).changes.filter((entry) => entry.kind === "added")).toHaveLength(9);
  });

  it("keeps a wrapped open-register AND declaration exception intact in the candidate inventory", () => {
    const exception = "Документы могут не включаться в заявку, если сведения находятся в открытом реестре,\nучастник должен включить декларацию соответствия.";
    const input = source(exception);
    const inventory = extractIntelligenceConditionFacts([input]);
    expect(inventory.facts).toEqual([expect.objectContaining({ category: "exception", ambiguous: true, quote: exception })]);
    const result = completeIntelligenceConditions([card()], [input]);
    expect(requirements(result.items[0])).toContain(exception);
    expect(result.changes).toEqual(expect.arrayContaining([expect.objectContaining({ category: "exception", quote: exception, requiresReview: true })]));
    expect(requirements(result.items[0]).some((entry) => entry === "участник должен включить декларацию соответствия.")).toBe(false);
  });

  it("retains a full review receipt instead of guessing the referent of an unbound exception", () => {
    const input = source("untrusted aggregate");
    const document = "Копия доверенности представителя.";
    const exception = "Указанные сведения не предоставляются, если полномочия подтверждены открытым реестром.";
    input.fragments = [{ id: "document", locator: "Документ", text: document }, { id: "exception", locator: "Оговорка", text: exception }];
    const result = completeIntelligenceConditions([card()], [input]);
    expect(requirements(result.items[0])).toContain(document);
    expect(result.skipped).toEqual(expect.arrayContaining([expect.objectContaining({
      reason: "untransferred-exception", quote: exception, fragmentId: "exception", requiresReview: true,
    })]));
    expect(result.changes.some((entry) => entry.quote === exception)).toBe(false);
  });
});
