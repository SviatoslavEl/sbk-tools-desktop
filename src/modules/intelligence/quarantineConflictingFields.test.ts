import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import { quarantineConflictingFields } from "./quarantineConflictingFields";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const person = "Бетов Борис Борисович", other = "Гаммов Григорий Григорьевич";
const source = (text: string, extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "source", name: "Синтетический источник QA", text, ...extra });
const card = (destination: IntelligenceItem["destination"], fields: IntelligenceItem["fields"], extra: Partial<IntelligenceItem> = {}): IntelligenceItem => ({ id: "item", title: "Проверка QA", destination, fields, selectedFields: Object.keys(fields), sourceIds: ["source"], evidence: [], ...extra });
const staff = (fields: IntelligenceItem["fields"] = {}) => card("staff", { fullName: person, ...fields });

describe("quarantine only literal current-source conflicts", () => {
  it("deselects a whole mixed certificate field but preserves every value/evidence and records review provenance", () => {
    const input = source(`${person}\tСертификаты CISSP\n${other}\tСертификаты OSCP`), item = staff({ certificates: ["CISSP", "OSCP"] }), before = structuredClone({ item, input });
    const result = quarantineConflictingFields([item], [input]);
    expect(result.items[0].selectedFields).toEqual(["fullName"]); expect(result.items[0].fields).toBe(item.fields); expect(result.items[0].evidence).toBe(item.evidence);
    expect(result.changes).toHaveLength(1); expect(result.changes[0]).toMatchObject({ itemId: item.id, field: "certificates", kind: "quarantined", previousValue: ["CISSP", "OSCP"], requiresReview: true, sourceId: input.id });
    expect(input.text).toContain(result.changes[0].quote); expect({ item, input }).toEqual(before);
    const reselected = { ...result.items[0], selectedFields: [...result.items[0].selectedFields, "certificates"] };
    expect(getBlockingEvidenceFindings(auditIntelligenceResult([reselected], [input]), reselected).some((finding) => finding.field === "certificates")).toBe(true);
  });

  it.each([
    ["experienceYears", 25, `Опыт: 25 лет в ИБ`],
    ["experienceNotes", "300 проектов", "Проекты: 300 проектов"],
    ["phone", "+7 999 123-45-67", "Телефон: +7 999 123-45-67"],
    ["email", "manager@example.test", "Email: manager@example.test"],
    ["education", "МГУ, инженер", "Образование: МГУ, инженер"],
    ["basis", "Трудовой договор", "Основание: Трудовой договор"],
  ] as const)("quarantines explicitly foreign %s only", (field, value, clause) => {
    const item = staff({ [field]: field === "education" ? [value as string] : value }), input = source(`ФИО: ${other}\n${clause}`);
    const before = structuredClone(item), report = auditIntelligenceResult([item], [input]);
    expect(report.fields.find((entry) => entry.field === field)?.status).toBe("conflict");
    const result = quarantineConflictingFields([item], [input]); expect(result.items[0].selectedFields).not.toContain(field); expect(result.items[0].fields).toEqual(before.fields); expect(item).toEqual(before);
  });

  it("does not quarantine correct owner or unknown/unverified/placeholder data", () => {
    for (const input of [source(`${person}\tСертификат OSCP`), source("Неизвестные сведения"), source("Сертификат OSCP")]) {
      const item = staff({ certificates: ["OSCP"] }), result = quarantineConflictingFields([item], [input]); expect(result.items).toEqual([item]); expect(result.changes).toEqual([]);
    }
    const item = staff({ certificates: ["Не указано"] }); expect(quarantineConflictingFields([item], [source("Не указано")]).changes).toEqual([]);
  });

  it("quarantines literal non-license documents and wrong-event procurement dates without deleting them", () => {
    const item = card("procurement", { licenses: ["Декларация соответствия."], submissionDeadline: "2026-10-21" }), input = source("Декларация соответствия.\nПодведение итогов: 21.10.2026.");
    const result = quarantineConflictingFields([item], [input]); expect(result.items[0].selectedFields).toEqual([]); expect(result.items[0].fields).toBe(item.fields);
    expect(result.changes.map((entry) => entry.field)).toEqual(["licenses", "submissionDeadline"]);
  });

  it("quarantines proven wrong proposal issuer roles, not unrelated proposal fields", () => {
    const item = card("proposals", { issuerName: "АО «Заказчик QA»", title: "Неизвестное название QA" }), input = source("Заказчик: АО «Заказчик QA».");
    const result = quarantineConflictingFields([item], [input]); expect(result.items[0].selectedFields).toEqual(["title"]); expect(result.changes.map((entry) => entry.field)).toEqual(["issuerName"]);
  });

  it("quarantines a literal model title used as CP number but leaves a valid or unknown number untouched", () => {
    const bad = card("proposals", { number: "Сервер АЛЬФА R120 G2" }), input = source("Сервер АЛЬФА R120 G2 в составе:"), result = quarantineConflictingFields([bad], [input]);
    expect(result.items[0].fields.number).toBe(bad.fields.number); expect(result.items[0].selectedFields).not.toContain("number"); expect(result.changes[0]).toMatchObject({ field: "number", kind: "quarantined", previousValue: bad.fields.number, requiresReview: true });
    for (const [number, text] of [["QA-100", "КП № QA-100"], ["UNKNOWN-100", "Сведения отсутствуют"]]) {
      const item = card("proposals", { number }); expect(quarantineConflictingFields([item], [source(text)]).items).toEqual([item]);
    }
    const unknown = card("proposals", { number: "UNKNOWN-100" }); expect(getBlockingEvidenceFindings(auditIntelligenceResult([unknown], [source("Сведения отсутствуют")]), unknown).some((finding) => finding.field === "number")).toBe(true);
  });

  it.each(["hidden", "veryHidden", "stale-source", "excluded-fragments"])("never quarantines from %s material", (change) => {
    const text = "Декларация соответствия.", input = source(text), item = card("procurement", { licenses: [text] });
    if (change === "hidden" || change === "veryHidden") input.fragments = [{ id: "hidden", locator: "Скрытая история", text, sheetState: change, includedByUser: true }];
    if (change === "stale-source") item.sourceIds = ["old-uuid"];
    if (change === "excluded-fragments") input.fragments = [];
    expect(quarantineConflictingFields([item], [input]).changes).toEqual([]);
  });

  it("does not quarantine fields outside the explicit allowlist or already deselected fields", () => {
    const input = source("НМЦ договора: 123 руб.\nДекларация соответствия."), item = card("procurement", { licenses: ["Декларация соответствия."], nmc: 99 }, { selectedFields: ["nmc"] });
    expect(quarantineConflictingFields([item], [input]).items).toEqual([item]);
  });

  it.each(["sources", "items", "fragments"])("fails atomically with a visible skip for duplicate %s", (kind) => {
    const input = source("Декларация соответствия."), items = [card("procurement", { licenses: [input.text] })], sources = [input];
    if (kind === "sources") sources.push({ ...input });
    if (kind === "items") items.push({ ...items[0] });
    if (kind === "fragments") input.fragments = [{ id: "same", locator: "1", text: input.text }, { id: "same", locator: "2", text: input.text }];
    const result = quarantineConflictingFields(items, sources); expect(result.items).toEqual(items); expect(result.changes).toEqual([]); expect(result.limited).toBe(true); expect(result.skipped.length).toBeGreaterThan(0);
  });

  it("returns unchanged on audit limits without applying earlier conflicts", () => {
    const input = source("", { fragments: [{ id: "first", locator: "1", text: "Декларация соответствия." }, ...Array.from({ length: 5000 }, (_, index) => ({ id: `line-${index}`, locator: String(index), text: "QA" }))] }), item = card("procurement", { licenses: ["Декларация соответствия."] });
    const result = quarantineConflictingFields([item], [input]); expect(result.items).toEqual([item]); expect(result.changes).toEqual([]); expect(result.skipped[0].reason).toBe("quarantine-audit-limit"); expect(result.limited).toBe(true);
  });

  it("rolls back selections and receipts when the final result exceeds 8MiB", () => {
    const item = card("procurement", { licenses: ["Декларация соответствия."], notes: "Я".repeat(4_200_000) }, { selectedFields: ["licenses"] });
    const result = quarantineConflictingFields([item], [source("Декларация соответствия.")]); expect(result.items[0]).toBe(item); expect(result.changes).toEqual([]); expect(result.limited).toBe(true); expect(result.skipped[0].reason).toBe("quarantine-result-limit");
  });
});
