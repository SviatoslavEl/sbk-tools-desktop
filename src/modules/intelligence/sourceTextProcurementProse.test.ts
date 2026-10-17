import { describe, expect, it } from "vitest";
import { completeSourceTextFields } from "./sourceTextCompletion";
import { auditIntelligenceResult } from "./resultEvidence";
import type { IntelligenceFragment, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const paragraph = (n: number, text: string): IntelligenceFragment => ({ id: `paragraph-${n}`, locator: `Абзац ${n}`, text });
const customer = "Акционерный коммерческий банк «Абсолют Банк» (Публичное акционерное общество) (АКБ) «Абсолют Банк» (ПАО)";
const subject = "поставка серверного оборудования в следующей конфигурации\n(далее – Товар):";
const source = (): IntelligenceSource => ({ id: "source", name: "Нельзя брать имя из имени файла.docx", text: "UNSELECTED", fragments: [paragraph(14, "ТЕХНИЧЕСКОЕ ЗАДАНИЕ"), paragraph(15, "на поставку серверного оборудования для нужд АКБ «Абсолют Банк»"), paragraph(48, `Заказчик – ${customer}, конечный пользователь, использующий оборудование в собственных целях.`), paragraph(50, `Предмет закупки: ${subject}`)] });
const item = (): IntelligenceItem => ({ id: "p", title: "Закупка", destination: "procurement", fields: {}, sourceIds: ["source"], selectedFields: [] });

describe("explicit procurement prose roles", () => {
  it("recovers only the explicit title/customer/subject with current literal evidence", () => {
    const sources = [source()], before = structuredClone(sources), result = completeSourceTextFields([item()], sources), prepared = result.items[0];
    expect(prepared.fields).toMatchObject({ name: "на поставку серверного оборудования для нужд АКБ «Абсолют Банк»", customer, subject });
    expect(prepared.evidence!.filter((entry) => entry.field === "name")).toEqual([{ field: "name", sourceId: "source", fragmentId: "paragraph-15", quote: sources[0].fragments![1].text }]);
    const report = auditIntelligenceResult(result.items, sources);
    for (const key of ["name", "customer", "subject"]) expect(report.fields.find((entry) => entry.field === key)?.status, key).toBe("confirmed");
    expect(report.findings.filter((entry) => entry.code === "evidence-does-not-support-value")).toEqual([]);
    expect(sources).toEqual(before);
  });
  it("does not overwrite meaningful model fields or infer parties from a heading", () => {
    const original = item(); original.fields = { customer: "Иное имя", subject: "Другой предмет", name: "Другая закупка" };
    expect(completeSourceTextFields([original], [source()]).items[0].fields).toEqual(original.fields);
    const onlyTitle = source(); onlyTitle.fragments = onlyTitle.fragments!.slice(0, 2);
    expect(completeSourceTextFields([item()], [onlyTitle]).items[0].fields.customer).toBeUndefined();
  });
  it("rejects a title across a hidden row, numeric gap or mismatched locator", () => {
    const variants = [source(), source(), source()];
    variants[0].fragments!.splice(1, 0, { ...paragraph(15, "Скрыто"), sheetState: "hidden" });
    variants[1].fragments![1] = paragraph(16, variants[1].fragments![1].text);
    variants[2].fragments![1].locator = "Абзац 16";
    for (const next of variants) expect(completeSourceTextFields([item()], [next]).items[0].fields.name).toBeUndefined();
  });
  it("does not assign conflicting roles or a shared source to multiple cards", () => {
    const conflicting = source(); conflicting.fragments!.push(paragraph(51, "Заказчик – ООО «Другая компания», конечный пользователь, использующий оборудование."));
    expect(completeSourceTextFields([item()], [conflicting]).items[0].fields.customer).toBeUndefined();
    const multi = completeSourceTextFields([item(), { ...item(), id: "p2" }], [source()]);
    expect(multi.items.every((entry) => Object.keys(entry.fields).length === 0)).toBe(true);
  });
  it("does not confirm a multiline subject assembled from different fragments, hidden text or a different role label", () => {
    const current = item(); current.fields.subject = subject; current.selectedFields = ["subject"];
    const variants = [source(), source(), source()];
    variants[0].fragments!.pop(); variants[0].fragments!.push(paragraph(50, "Предмет закупки: поставка серверного оборудования в следующей конфигурации"), paragraph(51, "(далее – Товар):"));
    variants[1].fragments![3].sheetState = "hidden";
    variants[2].fragments![3].text = `Справочная информация: ${subject}`;
    for (const input of variants) expect(auditIntelligenceResult([current], [input]).fields.find((entry) => entry.field === "subject")?.status).not.toBe("confirmed");
  });
  it("does not assign prose fields from a second document bundled after the technical heading", () => {
    const input = source(); input.fragments!.splice(2, 0, paragraph(40, "Договор № 17 от 01.01.2026"));
    expect(completeSourceTextFields([item()], [input]).items[0].fields).toEqual({});
  });
});
