import { describe, expect, it, vi } from "vitest";
import { recordEntry, searchableFields, searchEntries, type SearchEntry } from "./index";
vi.mock("../../lib/storage", () => ({ listRecords: vi.fn(), readDraft: vi.fn() }));
const entry = (patch: Partial<SearchEntry> = {}): SearchEntry => ({ id: "1", title: "Договор №25", tool: "contracts", fields: ["ООО Ёлка", "ИНН 7712345678", "Сертификат Иванов"], archived: false, updatedAt: "2026-09-01", ...patch });
describe("local global search", () => {
  it("matches multiple words across business fields and normalizes ё", () => {
    expect(searchEntries([entry()], "елка ИВАНОВ")).toHaveLength(1);
    expect(searchEntries([entry()], "77123456")[0].snippet).toContain("7712345678");
    expect(searchEntries([entry()], "елка Сидоров")).toHaveLength(0);
  });
  it("filters archives and sections, ranks exact title first", () => {
    const all = [entry({ id: "archived", archived: true }), entry({ id: "staff", tool: "staff", title: "Иванов" }), entry()];
    expect(searchEntries(all, "Иванов").map((hit) => hit.id)).toEqual(["staff", "1"]);
    expect(searchEntries(all, "Иванов", "contracts", true)).toHaveLength(2);
    expect(searchEntries(all, " ")).toEqual([]);
  });
  it("does not index secrets, filesystem paths or attachment bytes", () => {
    const fields = searchableFields({ name: "КП", ownerPassword: "SECRET", verifier: "notKnown", relativePath: "C:/private/file.pdf", base64: "BYTES", dataUrl: "data:some", sourceSnapshot: {password: "SECRET2"}, documents: [{fileName:"certificate.pdf", sha256:"HASH"}] });
    expect(fields).toContain("certificate.pdf");
    for (const forbidden of ["SECRET", "C:/private/file.pdf", "BYTES", "data:some", "SECRET2", "HASH"]) expect(fields).not.toContain(forbidden);
  });
  it("makes excerpts from extracted document text rather than path", () => {
    const record = { id:"r", title:"Тендер", archived:false, createdAt:"", updatedAt:"", payload:{ documentVersions:[{fileName:"ТЗ.docx", extractedText:"a".repeat(500) + " уникальное требование заказчика " + "z".repeat(500)}] } };
    const hit = searchEntries([recordEntry(record, "procurement")], "требование")[0];
    expect(hit.snippet).toContain("требование заказчика"); expect(hit.snippet.length).toBeLessThan(240);
  });
});
