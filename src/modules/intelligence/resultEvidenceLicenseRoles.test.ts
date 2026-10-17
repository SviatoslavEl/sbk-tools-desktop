import { describe, expect, it } from "vitest";
import { auditIntelligenceResult, getBlockingEvidenceFindings } from "./resultEvidence";
import { buildIntelligencePrompt, buildIntelligenceResponseSchema } from "./workbenchModel";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const clauses = ["Сертификат OSCP — не менее 5 специалистов.", "Сертификат OSEP — не менее 2 специалистов.", "Копия действующей лицензии ФСТЭК.", "Копия доверенности, если заявку подписывает представитель.", "Декларация соответствия участника установленным требованиям."];
const source = (text = clauses.join("\n"), id = "source-a"): IntelligenceSource => ({ id, name: "Синтетическая закупка QA", text, fragments: [{ id: "page-1", locator: "Страница 1", text }] });
const item = (licenses: string[], requirements = clauses): IntelligenceItem => ({ id: "purchase-a", title: "Испытание лицензионных полей QA", destination: "procurement", fields: { requirements, licenses }, selectedFields: ["requirements", "licenses"], sourceIds: ["source-a"] });
const licenseStatus = (report: ReturnType<typeof auditIntelligenceResult>) => report.fields.find((field) => field.field === "licenses");
const licenseBlockers = (report: ReturnType<typeof auditIntelligenceResult>, card: IntelligenceItem) => getBlockingEvidenceFindings(report, card).filter((finding) => finding.field === "licenses");

describe("procurement license field semantic role", () => {
  it("does not greenlight powers of attorney/declarations as licenses even when all five application requirements are complete", () => {
    const card = item([clauses[3], clauses[2], clauses[4]]), input = source(), before = structuredClone({ card, input });
    const report = auditIntelligenceResult([card], [input]);
    expect(licenseStatus(report)?.status).not.toBe("confirmed"); expect(licenseBlockers(report, card).length).toBeGreaterThan(0);
    expect(report.coverage.length).toBeGreaterThan(0); expect(report.coverage.every((check) => check.status === "covered")).toBe(true);
    expect(licenseBlockers(report, card)[0].evidence.some((proof) => proof.quote.includes("доверенности"))).toBe(true);
    expect(licenseBlockers(report, card)[0].evidence.some((proof) => proof.quote.includes("Декларация"))).toBe(true);
    expect({ card, input }).toEqual(before);
  });

  it.each(["Копия доверенности.", "Декларация соответствия.", "Сертификат OSCP.", "Выписка из ЕГРЮЛ.", "Решение об одобрении крупной сделки."])("requires a licensing-role review for a literal non-license document: %s", (value) => {
    const card = item([value], [value]), report = auditIntelligenceResult([card], [source(value)]);
    expect(licenseStatus(report)?.status).not.toBe("confirmed"); expect(licenseBlockers(report, card).length).toBeGreaterThan(0);
    expect(licenseStatus(report)?.message).toContain("Лицензии");
  });

  it.each([
    "Лицензия на медицинскую деятельность.", "Копия лицензии ФСТЭК на ТЗКИ, подпункты «б», «е».", "Лицензия ФСБ, пункты 13, 20, 22.",
    "ФСТЭК — ТЗКИ: подпункты «б», «е».", "ФСБ: пункты 13, 20, 22.", "ТЗКИ: виды работ «б», «е».",
    "Копия лицензии ФСТЭК или выписка из реестра лицензий, если допустимо условиями.",
    "Лицензия ФСТЭК, подписанная представителем по доверенности.",
  ])("keeps an actual literal licensing description on the normal evidence path: %s", (value) => {
    const card = item([value], [value]), report = auditIntelligenceResult([card], [source(value)]);
    expect(licenseStatus(report)?.status).toBe("confirmed"); expect(licenseBlockers(report, card)).toEqual([]);
  });

  it.each([0, 1, 2])("checks every list entry independently, including index %i", (index) => {
    const licenses = [clauses[2], "Лицензия ФСБ.", "ТЗКИ: виды работ «б», «е»."]; licenses[index] = clauses[3];
    const input = source([...clauses, ...licenses].join("\n")), card = item(licenses);
    expect(licenseBlockers(auditIntelligenceResult([card], [input]), card).length).toBeGreaterThan(0);
  });

  it.each(["Доверенность на подачу документов в ФСТЭК.", "Декларация о наличии лицензии ФСБ.", "Лицензия ФСТЭК; копия доверенности."])("does not borrow a licensing word to bless a distinct document's role: %s", (value) => {
    const card = item([value], [value]), report = auditIntelligenceResult([card], [source(value)]);
    expect(licenseStatus(report)?.status).not.toBe("confirmed"); expect(licenseBlockers(report, card).length).toBeGreaterThan(0);
  });

  it("keeps literals scoped to cited eligible fragments, not nearby or uncited licensing language", () => {
    const card = item(["Копия доверенности."], ["Копия доверенности."]);
    const input = source("Лицензия ФСТЭК.\nКопия доверенности."), report = auditIntelligenceResult([card], [input, source("Копия доверенности. Лицензия ФСТЭК.", "foreign")]);
    expect(licenseStatus(report)?.status).not.toBe("confirmed"); expect(licenseBlockers(report, card)[0].evidence.every((entry) => entry.sourceId === "source-a")).toBe(true);
    const excluded = source(); excluded.fragments = [];
    expect(licenseStatus(auditIntelligenceResult([item([clauses[2]])], [excluded]))?.status).not.toBe("confirmed");
  });

  it("does not treat licensing labels alone as proof of absent or changed source values", () => {
    const card = item(["Лицензия ФСТЭК № 987654."], []);
    expect(licenseStatus(auditIntelligenceResult([card], [source("Лицензия ФСТЭК № 123456.")]))?.status).not.toBe("confirmed");
  });

  it("does not weaken the existing literal-fragment boundary for wrapped licensing prose", () => {
    const value = "Лицензия ФСБ:\nпункты 13, 20, 22.", card = item([value], [value]);
    const report = auditIntelligenceResult([card], [source(value)]);
    expect(licenseStatus(report)?.status).toBe("unverified");
    expect(licenseStatus(report)?.message).not.toContain("В поле «Лицензии»");
  });

  it("allows an explicit review but invalidates the ACK if this list or its source changes", () => {
    const card = item([clauses[3]]), input = source(), report = auditIntelligenceResult([card], [input]), blocker = licenseBlockers(report, card)[0];
    expect(blocker).toBeDefined(); expect(licenseBlockers(report, card).length).toBeGreaterThan(0);
    expect(getBlockingEvidenceFindings(report, card, [blocker.id]).some((finding) => finding.field === "licenses")).toBe(false);
    const changed = { ...card, fields: { ...card.fields, licenses: [clauses[4]] } }, changedReport = auditIntelligenceResult([changed], [input]);
    expect(getBlockingEvidenceFindings(changedReport, changed, [blocker.id]).some((finding) => finding.field === "licenses")).toBe(true);
    expect(getBlockingEvidenceFindings(auditIntelligenceResult([card], [source(`${input.text}\nИзменение условий.`)]), card, [blocker.id]).some((finding) => finding.field === "licenses")).toBe(true);
  });

  it("does not add a license-field blocker when the field is deselected or the documents remain only in requirements", () => {
    const card = item([clauses[3]]); card.selectedFields = ["requirements"];
    const report = auditIntelligenceResult([card], [source()]); expect(licenseStatus(report)).toBeUndefined(); expect(licenseBlockers(report, card)).toEqual([]);
    const onlyRequirements = item([]); const normal = auditIntelligenceResult([onlyRequirements], [source()]); expect(licenseBlockers(normal, onlyRequirements)).toEqual([]);
  });

  it("describes licensing-only semantics in the shared prompt and response schema", () => {
    const prompt = buildIntelligencePrompt("Подготовь закупку", [source()], ["procurement"]);
    const schema = JSON.stringify(buildIntelligenceResponseSchema(["procurement"]));
    for (const text of [prompt, schema]) { expect(text).toContain("Лицензии"); expect(text.toLocaleLowerCase("ru")).toContain("доверенности"); expect(text).toContain("декларации"); }
  });
});
