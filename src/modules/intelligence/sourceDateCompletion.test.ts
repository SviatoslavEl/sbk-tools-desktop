import { describe, expect, it } from "vitest";
import { completeSourceDates } from "./sourceDateCompletion";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import type { IntelligenceDestination, IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const paragraph = (number: number, text: string, extra: Partial<IntelligenceFragment> = {}): IntelligenceFragment => ({ id: `paragraph-${number}`, locator: `Абзац ${number}`, text, ...extra });
const source = (text: string, extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "date-source", name: "Синтетические даты QA", text, ...extra });
const card = (destination: IntelligenceDestination = "procurement", fields: IntelligenceItem["fields"] = {}, extra: Partial<IntelligenceItem> = {}): IntelligenceItem => ({ id: "date-card", title: "Поставка оборудования QA", destination, fields, selectedFields: Object.keys(fields), sourceIds: ["date-source"], evidence: [], ...extra });
const deadline = "Срок подачи заявок: 21.10.2026,16:00.";
const declaration = "Редакция извещения от 12.10.2026,14:35, время в документе указано в часовом поясеMSK.";
const globalSource = () => source("Не восстанавливать агрегат", { fragments: [paragraph(1, declaration), paragraph(2, deadline)] });
const fieldBlocks = (items: IntelligenceItem[], input: IntelligenceSource, fields: string[]) => {
  const report = auditIntelligenceResult(items, [input]);
  return getBlockingEvidenceFindings(report, items[0]).filter((finding) => fields.includes(finding.field || ""));
};

describe("source-only date completion ownership and full literal context", () => {
  it("preserves a global joined MSK rule without turning its different revision date into deadline evidence", () => {
    const item = card(), input = globalSource(), before = structuredClone({ item, input }), result = completeSourceDates([item], [input]), prepared = result.items[0];
    expect(prepared.fields.submissionDeadline).toBe("2026-10-21");
    expect(prepared.fields.publishedDate).toBeUndefined();
    expect(prepared.fields.notes).toBe(`${deadline}\n${declaration}`);
    expect(prepared.evidence?.filter((claim) => claim.field === "submissionDeadline").map((claim) => claim.fragmentId)).toEqual(["paragraph-2"]);
    expect(prepared.evidence?.filter((claim) => claim.field === "notes").map((claim) => claim.fragmentId)).toEqual(["paragraph-2", "paragraph-1"]);
    expect(fieldBlocks(result.items, input, ["submissionDeadline", "notes"])).toEqual([]);
    expect(result.changes.every((change) => change.requiresReview === true)).toBe(true); expect({ item, input }).toEqual(before);
  });

  it("keeps a proposal heading as separate context, not a fabricated date quote", () => {
    const outgoing = "Исх. № _____ от «14» апреля 2026", input = source("", { fragments: [paragraph(2, "Коммерческое предложение"), paragraph(8, outgoing)] });
    const item = card("proposals"), result = completeSourceDates([item], [input]);
    expect(result.items[0].fields.documentDate).toBe("2026-04-14"); expect(result.items[0].fields.internalNote).toBe(`${outgoing}\nКоммерческое предложение`);
    expect(result.items[0].evidence?.filter((claim) => claim.field === "documentDate")).toEqual([{ field: "documentDate", sourceId: input.id, fragmentId: "paragraph-8", quote: outgoing }]);
    expect(fieldBlocks(result.items, input, ["documentDate", "internalNote"])).toEqual([]);
  });

  it("keeps the literal event label when a deadline is wrapped onto the following source line", () => {
    const input = source("Срок подачи заявок:\n21.10.2026 16:00 МСК"), result = completeSourceDates([card()], [input]);
    expect(result.items[0].fields.submissionDeadline).toBe("2026-10-21");
    expect(result.items[0].fields.notes).toContain("Срок подачи заявок:");
    expect(result.items[0].fields.notes).toContain("21.10.2026 16:00 МСК");
    expect(fieldBlocks(result.items, input, ["submissionDeadline", "notes"])).toEqual([]);
    const audit = auditIntelligenceResult(result.items, [input]);
    expect(audit.findings.filter((finding) => finding.code === "deadline-time-missing")).toEqual([]);
  });

  it("replaces a wrong parsed day only with a fresh explicit event and a visible previous-value receipt", () => {
    const item = card("procurement", { submissionDeadline: "2026-10-12" }), input = globalSource(), before = structuredClone(item), result = completeSourceDates([item], [input]);
    expect(result.items[0].fields.submissionDeadline).toBe("2026-10-21");
    expect(result.changes.find((change) => change.field === "submissionDeadline")).toMatchObject({ kind: "replaced", previousValue: "2026-10-12", value: "2026-10-21", requiresReview: true });
    expect(item).toEqual(before);
  });

  it("does not multiply context, selected fields or evidence on a second preparation", () => {
    const input = globalSource(), first = completeSourceDates([card()], [input]), second = completeSourceDates(first.items, [input]);
    expect(second.items).toEqual(first.items); expect(second.changes).toEqual([]);
  });

  it("uses only selected source ownership, not another selected document's timezone", () => {
    const input = source("Срок подачи: 21.10.2026 16:00"), foreign = source("Время в документе указано в MSK.", { id: "foreign-source" });
    const result = completeSourceDates([card()], [input, foreign]);
    expect(result.items[0].fields.submissionDeadline).toBe("2026-10-21"); expect(result.items[0].fields.notes).toBe(input.text);
    expect(result.items[0].evidence?.every((claim) => claim.sourceId === input.id)).toBe(true);
    expect(completeSourceDates([card("procurement", {}, { sourceIds: ["unavailable"] })], [input]).changes).toEqual([]);
  });

  it("does not overwrite staff, contracts, or counterparties even in the same mixed batch", () => {
    const others = (["staff", "contracts", "counterparties"] as const).map((destination, index) => card(destination, { date: "2020-01-01", notes: "Пользовательские данные" }, { id: `other-${index}` }));
    const before = structuredClone(others), result = completeSourceDates([card(), ...others], [globalSource()]);
    expect(result.items.slice(1)).toEqual(before); expect(others).toEqual(before);
  });

  it.each(["procurement", "proposals"] as const)("does not give one source date to multiple %s cards", (destination) => {
    const text = destination === "procurement" ? deadline : "Коммерческое предложение от 14.04.2026";
    const items = [card(destination), card(destination, {}, { id: "second-card" })], result = completeSourceDates(items, [source(text)]);
    expect(result.items).toEqual(items); expect(result.changes).toEqual([]); expect(result.skipped.some((skip) => skip.reason === "ambiguous-date-owner")).toBe(true);
  });

  it.each([
    "Срок подачи: 21.10.2026 16:00 MSK\nСрок подачи: 22.10.2026 16:00 MSK",
    "Срок подачи: 21.10.2026 16:00 MSK\nСрок подачи: 21.10.2026 17:00 MSK",
    "Срок подачи: 21.10.2026 16:00 MSK (UTC)",
    "Время в документе указано в MSK и UTC.\nСрок подачи: 21.10.2026 16:00",
  ])("does not choose between conflicting days, clocks or timezones: %s", (text) => {
    const result = completeSourceDates([card()], [source(text)]); expect(result.changes).toEqual([]); expect(result.items[0].fields.submissionDeadline).toBeUndefined(); expect(result.skipped.length).toBeGreaterThan(0);
  });

  it("does not assign a lower execution bound as the promised start but can preserve the explicit upper date", () => {
    const text = "Поставка: не ранее 29.12.2026, не позднее 17.01.2027.", result = completeSourceDates([card()], [source(text)]);
    expect(result.items[0].fields.executionStartDate).toBeUndefined(); expect(result.items[0].fields.executionEndDate).toBe("2027-01-17");
    expect(result.items[0].fields.notes).toBe(text); expect(result.skipped.some((skip) => skip.field === "executionStartDate")).toBe(true);
  });

  it.each(["Лот 1: Серверы\nЛот 2: Сети", "Лот (№1): Серверы\nЛот (№2): Сети", "Лоты №1 и2: Общий срок"])("skips all multi-lot sources even if the printed date is shared: %s", (heading) => {
    const result = completeSourceDates([card()], [source(`${heading}\n${deadline}`)]);
    expect(result.changes).toEqual([]); expect(result.items[0].fields.submissionDeadline).toBeUndefined();
  });

  it("does not mistake prose about one lot for multiple distinct lots", () => {
    const result = completeSourceDates([card()], [source(`Лот включает поставку и монтаж оборудования.\n${deadline}`)]);
    expect(result.items[0].fields.submissionDeadline).toBe("2026-10-21");
  });

  it.each([
    "Поставка в течение 14 календарных дней. Срок действия КП — 90 дней.",
    "Редакция извещения от 12.10.2026 14:35. Подведение итогов: 21.10.2026.",
    "Дата: 21.10.2026. Федеральный закон от 21.10.2026.",
    "Срок подачи: 31.02.2026 16:00. Срок подачи: __.__.____.",
    "Дата КП: 14 – 20 апреля 2026",
  ])("does not calculate or relabel relative, other-event, unknown, invalid or range dates: %s", (text) => {
    const result = completeSourceDates([card(), card("proposals", {}, { id: "proposal-card" })], [source(text)]);
    expect(result.changes).toEqual([]);
  });

  it.each([false, true])("does not autoassign hidden history even when explicitly selected: %s", (includedByUser) => {
    const input = source(deadline, { fragments: [paragraph(1, deadline, { sheetState: "hidden", includedByUser })] });
    expect(completeSourceDates([card()], [input]).changes).toEqual([]);
  });

  it("does not resurrect aggregate dates excluded from the fragment selection", () => {
    expect(completeSourceDates([card()], [source(deadline, { fragments: [] })]).changes).toEqual([]);
  });

  it.each(["sources", "items", "fragments"])("rejects duplicate %s identities atomically with a visible skip", (kind) => {
    const input = globalSource(), items = [card()], sources = [input];
    if (kind === "sources") sources.push({ ...input, text: "Срок подачи: 22.10.2026" });
    if (kind === "items") items.push(card());
    if (kind === "fragments") input.fragments!.push({ ...input.fragments![1] });
    const before = structuredClone({ items, sources }), result = completeSourceDates(items, sources);
    expect(result.items).toEqual(items); expect(result.changes).toEqual([]); expect(result.limited).toBe(true); expect(result.skipped.length).toBeGreaterThan(0); expect({ items, sources }).toEqual(before);
  });

  it.each(["sources", "items"])("rejects a selection over 100 %s without partial completion", (kind) => {
    const sources = kind === "sources" ? Array.from({ length: 101 }, (_, index) => source(deadline, { id: `source-${index}` })) : [globalSource()];
    const items = kind === "items" ? Array.from({ length: 101 }, (_, index) => card("procurement", {}, { id: `card-${index}` })) : [card()];
    const result = completeSourceDates(items, sources); expect(result.items).toEqual(items); expect(result.changes).toEqual([]); expect(result.limited).toBe(true); expect(result.skipped.length).toBeGreaterThan(0);
  });

  it("rejects a date inventory over the fragment budget without partial first-date assignment", () => {
    const input = source("", { fragments: [paragraph(1, deadline), ...Array.from({ length: 5000 }, (_, index) => paragraph(index + 2, "QA"))] });
    const item = card(), result = completeSourceDates([item], [input]);
    expect(result.items).toEqual([item]); expect(result.changes).toEqual([]); expect(result.limited).toBe(true); expect(result.skipped.some((skip) => skip.reason === "date-inventory-limit")).toBe(true);
  });

  it("keeps date plus context atomic if notes or evidence cannot accommodate the full proof", () => {
    const notesItem = card("procurement", { notes: "я".repeat(19999) }), notes = completeSourceDates([notesItem], [globalSource()]);
    expect(notes.items).toEqual([notesItem]); expect(notes.changes).toEqual([]); expect(notes.skipped.some((skip) => skip.reason === "date-context-limit")).toBe(true);
    const evidenceItem = card("procurement", {}, { evidence: Array.from({ length: 500 }, (_, index) => ({ field: "notes", sourceId: "date-source", quote: `Исходная ссылка QA ${index}` })) });
    const evidence = completeSourceDates([evidenceItem], [globalSource()]); expect(evidence.items).toEqual([evidenceItem]); expect(evidence.changes).toEqual([]);
  });

  it("rolls back every item and receipt when the whole operation exceeds 500 changes", () => {
    const text = "Дата публикации: 01.10.2026\nСрок подачи заявок: 21.10.2026 16:00\nСрок вопросов: 20.10.2026\nНачало выполнения работ: 01.11.2026\nОкончание выполнения работ: 30.11.2026";
    const sources = Array.from({ length: 51 }, (_, index) => source(text, { id: `source-${index}` }));
    const items = sources.map((input, index) => card("procurement", {}, { id: `card-${index}`, sourceIds: [input.id] })), before = structuredClone({ items, sources });
    const result = completeSourceDates(items, sources);
    expect(result.limited).toBe(true); expect(result.items.every((item, index) => JSON.stringify(item) === JSON.stringify(items[index]))).toBe(true); expect(result.changes).toEqual([]);
    expect(result.skipped.some((skip) => skip.reason === "date-preparation-limit")).toBe(true); expect({ items, sources }).toEqual(before);
  });
});
