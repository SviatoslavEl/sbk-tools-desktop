import { describe, expect, it } from "vitest";
import { SOURCE_PREPARATION_LIMITS } from "./sourcePreparedFacts";
import { completeSourceStaffCertificates, extractStaffCertificateFacts } from "./sourceStaffCertificates";
import { runResponsePreparation, validResponsePreparationReply } from "./responsePreparationWorker";
import { auditIntelligenceResult } from "./resultEvidence";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const alice = "Альфова Анна Алексеевна", boris = "Бетов Борис Борисович";
const header = "Контактное лицо\tСертификат\tДействителен\tДата сдачи\tНомер сертификата";
const row = (n: number, text: string, patch: Partial<IntelligenceFragment> = {}): IntelligenceFragment => ({ id: `sheet-1-row-${n}`, locator: `Лист QA, A${n}:E${n}`, sheetId: "1", sheetState: "visible", text, ...patch });
const certificate = (name = alice, title = "Сертификат QA", status = "Да", exam = "29.02.2024", number = "CERT-42") => [name, title, status, exam, number].join("\t");
const source = (fragments = [row(1, header), row(2, certificate()), row(3, certificate(boris, "Сертификат QB", "Нет", "03.07.2025", "CERT-43"))], id = "qa-source"): IntelligenceSource => ({ id, name: "Синтетический реестр QA", text: "Не восстанавливать исключённые строки", fragments });
const card = (name = alice, patch: Partial<IntelligenceItem> = {}): IntelligenceItem => ({ id: "qa-card", destination: "staff", title: name, fields: { fullName: name }, selectedFields: ["fullName"], sourceIds: ["qa-source"], evidence: [], ...patch });
const freeze = <T,>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };

describe("literal owner-bound certificate source facts", () => {
  it("retains each row's number, exam date, literal validity and full row/header with stable identities", () => {
    const input = source(), before = structuredClone(input); freeze(input);
    const facts = extractStaffCertificateFacts([input]);
    expect(facts.limited).toBe(false); expect(facts.skipped).toEqual([]); expect(facts.documents).toHaveLength(2);
    expect(facts.documents[0]).toEqual({ id: expect.any(String), ownerFullName: alice, category: "certificate", name: "Сертификат QA", seriesNumber: "CERT-42", examDate: "2024-02-29", reportedValidity: "Да", sourceId: input.id, fragmentId: "sheet-1-row-2", headerFragmentId: "sheet-1-row-1", quote: input.fragments![1].text, headerQuote: header });
    expect(facts.documents[1]).toMatchObject({ ownerFullName: boris, reportedValidity: "Нет", examDate: "2025-07-03" });
    expect(extractStaffCertificateFacts([input]).documents).toEqual(facts.documents); expect(input).toEqual(before);
  });

  it("supports explicit repeated owner cells inside a sparse contact-column region, never group-name filldown", () => {
    const sparseHeader = ["", "Контактное лицо", "", "", "Сертификат", "Действителен", "Дата сдачи", "Номер сертификата"].join("\t");
    const input = source([row(4, sparseHeader), row(5, ["", alice, "", "", "", "", "", ""].join("\t")), row(6, ["", "", alice, "", "QA", "Да", "01.05.2025", "QA-1"].join("\t")), row(7, ["", "", "", "", "Unowned QA", "Да", "01.05.2025", "QA-2"].join("\t"))]);
    const facts = extractStaffCertificateFacts([input]);
    expect(facts.documents.map((doc) => doc.name)).toEqual(["QA"]);
    expect(facts.skipped.some((entry) => entry.reason === "certificate-owner-ambiguous")).toBe(true);
  });

  it("keeps equal names with distinct row/number identities and does not turn reported validity into expiry or unlimited", () => {
    const input = source([row(1, header), row(2, certificate()), row(3, certificate(alice, "Сертификат QA", "Нет", "", "OTHER-42"))]);
    const docs = extractStaffCertificateFacts([input]).documents;
    expect(docs).toHaveLength(2); expect(new Set(docs.map((doc) => doc.id)).size).toBe(2);
    expect(docs[1].examDate).toBe("");
    for (const doc of docs) for (const key of ["issuedDate", "expiresDate", "unlimited", "relativePath", "acknowledged"]) expect(doc).not.toHaveProperty(key);
  });

  it.each(["hidden-header", "hidden-row", "gap", "sheet", "foreign-header", "duplicate-fragment", "duplicate-coordinate", "duplicate-column", "missing-status-column", "missing-owner", "two-owners", "initials", "bad-date", "bad-status"])("does not guess certificates across %s", (variant) => {
    const input = source([row(1, header), row(2, certificate())]);
    if (variant === "hidden-header") { input.fragments![0].sheetState = "hidden"; input.fragments![0].includedByUser = true; }
    if (variant === "hidden-row") { input.fragments![1].sheetState = "hidden"; input.fragments![1].includedByUser = true; }
    if (variant === "gap") input.fragments![1] = row(3, certificate());
    if (variant === "sheet") input.fragments![1].sheetId = "other";
    if (variant === "foreign-header") { input.fragments![0].id = "sheet-2-row-1"; input.fragments![0].sheetId = "2"; }
    if (variant === "duplicate-fragment") input.fragments!.push(structuredClone(input.fragments![1]));
    if (variant === "duplicate-coordinate") input.fragments!.push({ ...row(2, certificate()), id: "table-row-2", locator: "Лист QA, A2:E2" });
    if (variant === "duplicate-column") { input.fragments![0].text += "\tСертификат"; input.fragments![1].text += "\tOTHER"; }
    if (variant === "missing-status-column") input.fragments![0].text = header.replace("Действителен", "Примечание");
    if (variant === "missing-owner") input.fragments![1].text = certificate("");
    if (variant === "two-owners") { input.fragments![0].text = `ФИО\t\tСертификат\tДействителен\tДата сдачи\tНомер сертификата`; input.fragments![1].text = `${alice}\t${boris}\tQA\tДа\t01.01.2025\tN`; }
    if (variant === "initials") input.fragments![1].text = certificate("Альфова А.А.");
    if (variant === "bad-date") input.fragments![1].text = certificate(alice, "QA", "Да", "31.02.2025");
    if (variant === "bad-status") input.fragments![1].text = certificate(alice, "QA", "Сдан");
    expect(extractStaffCertificateFacts([input]).documents).toEqual([]);
  });

  it("does not repair U+FFFD or suppress the existing incomplete-source warnings", () => {
    const input = source([row(1, header), row(2, certificate(alice, "Сопр��вождение QA"))]);
    input.warnings = ["Сохранена ошибка Excel"]; input.coverage = { complete: false, requiresOcr: false };
    const before = structuredClone(input), facts = extractStaffCertificateFacts([input]);
    expect(facts.documents[0].name).toBe("Сопр��вождение QA"); expect(input).toEqual(before);
    expect(facts.skipped.some((entry) => entry.reason === "certificate-text-damage")).toBe(true);
  });

  it.each(["row", "table"])("rejects a DOCX %s locator that disagrees with its exact fragment identity", (variant) => {
    const fragments: IntelligenceFragment[] = [
      { id: "table-1-row-1", locator: "Таблица 1, строка 1", text: header },
      { id: "table-1-row-2", locator: variant === "row" ? "Таблица 1, строка 3" : "Таблица 2, строка 2", text: certificate() },
    ];
    expect(extractStaffCertificateFacts([source(fragments)]).documents).toEqual([]);
    fragments[1].locator = "Таблица 1, строка 2";
    expect(extractStaffCertificateFacts([source(fragments)]).documents).toHaveLength(1);
  });

  it("rejects duplicate sources and does not read discarded aggregate-only material", () => {
    const input = source(); expect(extractStaffCertificateFacts([input, input]).documents).toEqual([]);
    expect(extractStaffCertificateFacts([{ ...input, fragments: [] }]).documents).toEqual([]);
    expect(extractStaffCertificateFacts([{ ...input, fragments: undefined, text: [header, certificate()].join("\n") }]).documents).toEqual([]);
  });

  it("rolls back the inventory at source/fragment/quote/list limits rather than returning a prefix", () => {
    const inputs = [
      Array.from({ length: 101 }, (_, n) => source(undefined, `source-${n}`)),
      [source([row(1, header), ...Array.from({ length: 5000 }, (_, n) => row(n + 2, certificate()))])],
      [source([row(1, header), row(2, certificate(alice, "X".repeat(SOURCE_PREPARATION_LIMITS.quoteCharacters + 1)))])],
      [source([row(1, header), ...Array.from({ length: 101 }, (_, n) => row(n + 2, certificate(alice, `QA-${n}`)))])],
    ];
    for (const input of inputs) { const facts = extractStaffCertificateFacts(input); expect(facts.documents).toEqual([]); expect(facts.limited).toBe(true); }
  });

  it.each([false, true])("atomically limits all-invalid/trailing-invalid receipts (initial valid row: %s)", (initialValid) => {
    const fragments = [row(1, header), ...(initialValid ? [row(2, certificate())] : [])];
    fragments.push(...Array.from({ length: 501 }, (_, n) => row(n + (initialValid ? 3 : 2), certificate(alice, "QA", "Возможно"))));
    const facts = extractStaffCertificateFacts([source(fragments)]);
    expect(facts.documents).toEqual([]); expect(facts.limited).toBe(true);
    expect(facts.skipped).toHaveLength(1); expect(facts.skipped[0].reason).toBe("staff-certificate-limit");
  });
});

describe("unsaved certificate roster completion and worker protocol", () => {
  it("creates all named candidates, merges a unique owned card and preserves unrelated model fields immutably", () => {
    const input = source(), item = card(alice, { fields: { fullName: alice, certificates: ["Модель сохранила QA"], additionalSpecializations: ["Видимая спорная модельная строка"], basis: "Трудовой договор" }, selectedFields: ["fullName", "certificates", "additionalSpecializations", "basis"] });
    const before = structuredClone({ input, item }); freeze(input); freeze(item);
    const result = completeSourceStaffCertificates([item], [input], ["staff"]);
    expect(result.items).toHaveLength(2); expect(result.limited).toBe(false);
    expect(result.items[0].id).toBe(item.id); expect(result.items[0].fields.certificates).toEqual(["Модель сохранила QA", "Сертификат QA"]);
    expect(result.items[0].fields.additionalSpecializations).toEqual(item.fields.additionalSpecializations); expect(result.items[0].fields.basis).toBe("Трудовой договор");
    expect(result.items[1].fields).toEqual({ fullName: boris, certificates: ["Сертификат QB"] });
    expect(result.items[1].staffDocuments![0].reportedValidity).toBe("Нет");
    expect(result.changes.every((entry) => entry.requiresReview)).toBe(true); expect({ input, item }).toEqual(before);
    expect(completeSourceStaffCertificates(result.items, [input], ["staff"]).items).toEqual(result.items);
    expect(completeSourceStaffCertificates(result.items, [input], ["staff"]).changes).toEqual([]);
  });

  it("does not merge duplicate owned cards, foreign people, other destinations or invalid old certificate values", () => {
    const input = source([row(1, header), row(2, certificate())]), item = card();
    expect(completeSourceStaffCertificates([item, { ...item, id: "second" }], [input], ["staff"]).items).toEqual([item, { ...item, id: "second" }]);
    const foreign = card(alice, { sourceIds: ["foreign"] });
    const completed = completeSourceStaffCertificates([foreign], [input], ["staff"]); expect(completed.items[0]).toEqual(foreign); expect(completed.items).toHaveLength(2);
    expect(completeSourceStaffCertificates([], [input], ["proposals"]).items).toEqual([]);
    const invalid = card(alice, { fields: { fullName: alice, certificates: "Meaningful scalar must remain visible" } });
    expect(completeSourceStaffCertificates([invalid], [input], ["staff"]).items).toEqual([invalid]);
  });

  it("keeps two documents with the same title in normalized metadata while the transfer name list may be unique", () => {
    const input = source([row(1, header), row(2, certificate()), row(3, certificate(alice, "Сертификат QA", "Нет", "01.05.2025", "N-2"))]);
    const result = completeSourceStaffCertificates([], [input], ["staff"]);
    expect(result.items[0].fields.certificates).toEqual(["Сертификат QA"]); expect(result.items[0].staffDocuments).toHaveLength(2);
  });

  it("keeps the header as typed role metadata, never an unsupported certificate-value claim in the independent audit", () => {
    const input = source([row(1, header), row(2, certificate())]);
    const result = completeSourceStaffCertificates([], [input], ["staff"]), item = result.items[0];
    expect(item.staffDocuments![0]).toMatchObject({ headerFragmentId: "sheet-1-row-1", headerQuote: header });
    expect(item.evidence!.filter((claim) => claim.field === "certificates")).toEqual([{ field: "certificates", sourceId: input.id, fragmentId: "sheet-1-row-2", quote: input.fragments![1].text }]);
    expect(auditIntelligenceResult(result.items, [input]).findings.some((finding) => finding.code === "evidence-does-not-support-value")).toBe(false);
  });

  it("does not create an empty person candidate or overwrite an old card when the same certificate number has conflicting metadata", () => {
    const input = source([row(1, header), row(2, certificate()), row(3, certificate(alice, "Сертификат QA", "Нет", "01.05.2025"))]);
    const result = completeSourceStaffCertificates([], [input], ["staff"]);
    expect(result.items).toEqual([]); expect(result.changes).toEqual([]);
    expect(result.skipped.some((entry) => entry.reason === "staff-certificate-conflict")).toBe(true);
    const previous = card();
    expect(completeSourceStaffCertificates([previous], [input], ["staff"]).items).toEqual([previous]);
  });

  it("rolls back the entire completion if a new card or its full evidence cannot fit", () => {
    const input = source(), crowded = Array.from({ length: 100 }, (_, n) => card(`Человек QA ${n}`, { id: `old-${n}` }));
    const overflow = completeSourceStaffCertificates(crowded, [input], ["staff"]);
    expect(overflow.items).toEqual(crowded); expect(overflow.changes).toEqual([]); expect(overflow.limited).toBe(true);
    const old = card(alice, { evidence: Array.from({ length: 500 }, (_, n) => ({ field: "notes", sourceId: "qa-source", quote: `Existing proof ${n}` })) });
    const evidenceOverflow = completeSourceStaffCertificates([old], [input], ["staff"]);
    expect(evidenceOverflow.items).toEqual([old]); expect(evidenceOverflow.changes).toEqual([]); expect(evidenceOverflow.limited).toBe(true);
  });

  it("creates candidates from a valid empty model answer, preserves raw/source and validates closed metadata without ACK", () => {
    const input = { revision: 54, raw: '{"items":[]}', sources: [source()], destinations: ["staff"] }, before = structuredClone(input); freeze(input);
    const reply = runResponsePreparation(input);
    expect(reply.failed).toBeUndefined(); expect(validResponsePreparationReply(reply, 54)).toBe(true); expect(reply.prepared!.items).toHaveLength(2);
    expect(reply.prepared!.items.every((item) => item.staffDocuments?.length === 1 && !Object.prototype.hasOwnProperty.call(item.fields, "basis"))).toBe(true); expect(input).toEqual(before);
    const mutations: Array<(copy: typeof reply) => void> = [
      (copy) => { (copy.prepared!.items[0].staffDocuments![0] as unknown as Record<string, unknown>).unlimited = true; },
      (copy) => { copy.prepared!.items[0].staffDocuments![0].sourceId = "foreign"; },
      (copy) => { copy.prepared!.items[0].staffDocuments![0].ownerFullName = boris; },
      (copy) => { copy.prepared!.items[0].staffDocuments![0].examDate = "2025-02-31"; },
      (copy) => { copy.prepared!.items[0].staffDocuments![0].reportedValidity = "Бессрочный"; },
      (copy) => { copy.prepared!.items[0].staffDocuments![0].reportedValidity = ["Да"] as unknown as string; },
      (copy) => { copy.prepared!.items[0].staffDocuments!.push(structuredClone(copy.prepared!.items[0].staffDocuments![0])); },
      (copy) => { delete (copy.prepared!.items[0].staffDocuments![0] as Partial<NonNullable<IntelligenceItem["staffDocuments"]>[number]>).headerQuote; },
    ];
    for (const mutate of mutations) { const copy = structuredClone(reply); mutate(copy); expect(validResponsePreparationReply(copy, 54)).toBe(false); }
    expect(reply.prepared).not.toHaveProperty("reviewedFindingIds");
  });
});
