import { describe, expect, it } from "vitest";
import { auditIntelligenceResult } from "./resultEvidence";
import type { IntelligenceFieldValue, IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const issuerEmail = "office@vendor.example", buyerEmail = "office@buyer.example";
const issuerPhone = "+7 495 111-22-33", buyerPhone = "+7 495 444-55-66";
const card = (fields: Record<string, IntelligenceFieldValue>): IntelligenceItem => ({
  id: "proposal", destination: "proposals", title: "Проверка системы", fields,
  selectedFields: Object.keys(fields), sourceIds: ["source"],
});
const input = (text: string, extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({
  id: "source", name: "Исходные реквизиты.docx", text,
  fragments: [{ id: "table-row-2", locator: "Таблица, строка 2", text }], ...extra,
});
function audit(fields: Record<string, IntelligenceFieldValue>, source: IntelligenceSource) {
  return auditIntelligenceResult([card(fields)], [source]);
}
const status = (result: ReturnType<typeof audit>, field: string) => result.fields.find((entry) => entry.field === field)?.status;
function requisites(reverse = false, lineEnding = "\n") {
  const issuer = ["Исполнитель", "ООО «Проверка»", `Телефон: ${issuerPhone}`, `E-mail: ${issuerEmail}`].join(lineEnding);
  const buyer = ["Заказчик", "ООО «Клиент»", `Телефон: ${buyerPhone}`, `E-mail: ${buyerEmail}`].join(lineEnding);
  return reverse ? `${buyer}\t${issuer}` : `${issuer}\t${buyer}`;
}

describe("value-local party contact ownership", () => {
  it.each([false, true])("retains each contact's explicit column owner across a multiline TAB boundary (reverse %s)", (reverse) => {
    const source = input(requisites(reverse)), before = JSON.stringify(source);
    const result = audit({ contactEmail: issuerEmail, contactPhone: issuerPhone, recipientContact: buyerEmail }, source);
    expect(status(result, "contactEmail")).toBe("confirmed");
    expect(status(result, "contactPhone")).toBe("confirmed");
    expect(status(result, "recipientContact")).toBe("confirmed");
    expect(JSON.stringify(source)).toBe(before);
  });
  it("does not transfer the later buyer heading backwards onto the issuer's CRLF email row", () => {
    const result = audit({ contactEmail: issuerEmail, recipientContact: buyerEmail }, input(requisites(false, "\r\n")));
    expect(status(result, "contactEmail")).toBe("confirmed");
    expect(status(result, "recipientContact")).toBe("confirmed");
  });
  it.each([false, true])("still rejects the other party's contact (reverse %s)", (reverse) => {
    const result = audit({ contactEmail: buyerEmail, contactPhone: buyerPhone, recipientContact: issuerEmail }, input(requisites(reverse)));
    expect(status(result, "contactEmail")).toBe("conflict");
    expect(status(result, "contactPhone")).toBe("conflict");
    expect(status(result, "recipientContact")).toBe("conflict");
  });
  it.each(["\t", "; ", ". "])("does not claim an unowned preceding value from a future explicit role separated by %j", (separator) => {
    const source = input(`E-mail: ${issuerEmail}${separator}Заказчик: ООО «Клиент»`);
    const result = audit({ contactEmail: issuerEmail, recipientContact: issuerEmail }, source);
    expect(status(result, "contactEmail")).toBe("unverified");
    expect(status(result, "recipientContact")).toBe("unverified");
  });
  it("does not use a model-supplied party name to assign unlabelled corporate email", () => {
    const result = audit({ issuerName: "ООО «Проверка»", contactEmail: issuerEmail }, input(`ООО «Проверка»\nE-mail: ${issuerEmail}`));
    expect(status(result, "contactEmail")).toBe("unverified");
  });
  it("does not carry a role from a different source fragment", () => {
    const source = input("", { fragments: [
      { id: "p1", locator: "Абзац 1", text: "Исполнитель: ООО «Проверка»" },
      { id: "p2", locator: "Абзац 2", text: `E-mail: ${issuerEmail}\tЗаказчик: ООО «Клиент»` },
    ] });
    const result = audit({ contactEmail: issuerEmail, recipientContact: issuerEmail }, source);
    expect(status(result, "contactEmail")).toBe("unverified");
    expect(status(result, "recipientContact")).toBe("unverified");
  });
  it("does not confirm a list composed of contacts from opposite parties", () => {
    const result = audit({ contactEmail: `${issuerEmail}; ${buyerEmail}` }, input(requisites()));
    expect(status(result, "contactEmail")).not.toBe("confirmed");
  });
  it("does not turn corporate email into a person's name even with the correct party role", () => {
    const result = audit({ contactEmail: issuerEmail, contactName: issuerEmail, addresseeName: buyerEmail }, input(requisites()));
    expect(status(result, "contactEmail")).toBe("confirmed");
    expect(status(result, "contactName")).toBe("unverified");
    expect(status(result, "addresseeName")).toBe("unverified");
  });
  it("also keeps a comparison-normalized corporate email out of the person's-name field", () => {
    const result = audit({ contactName: "ｏｆｆｉｃｅ＠ｖｅｎｄｏｒ．ｅｘａｍｐｌｅ" }, input(requisites()));
    expect(status(result, "contactName")).toBe("unverified");
  });
  it("handles a long same-owner email list without an email-by-clause Cartesian comparison", () => {
    const emails = Array.from({ length: 400 }, (_value, index) => `contact${index}@vendor.example`).join("; ");
    const start = performance.now(), result = audit({ contactEmail: emails }, input(`Исполнитель: ООО «Проверка»\nE-mail: ${emails}\tЗаказчик\nООО «Клиент»`));
    expect(status(result, "contactEmail")).toBe("confirmed");
    expect(performance.now() - start).toBeLessThan(500);
  });
  it("never brings a hidden fragment back through aggregate source text", () => {
    const text = requisites(), result = audit({ contactEmail: issuerEmail }, input(text, { fragments: [{ id: "hidden", locator: "Скрытая история", text, sheetState: "hidden" }] }));
    expect(status(result, "contactEmail")).toBe("unverified");
  });
});
