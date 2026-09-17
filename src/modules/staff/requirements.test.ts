import { describe, expect, it } from "vitest";
import { emptyStaff, emptyStaffDocument } from "./types";
import { documentExpiry, staffAttachmentSummary, staffRequirements } from "./requirements";

describe("staff requirements", () => {
  it("describes zero documents neutrally instead of claiming all evidence is attached", () => {
    const summary = staffAttachmentSummary(staffRequirements(emptyStaff()).files);
    expect(summary.label).toBe("Документы не добавлены");
    expect(summary.title).not.toContain("Все перечисленные документы имеют вложение");
    expect(staffAttachmentSummary({ attached: 0, total: 1, missing: ["Диплом"] })).toEqual({ label: "Файлы: 0 из 1", title: "Без файла: Диплом" });
    expect(staffAttachmentSummary({ attached: 1, total: 1, missing: [] }).title).toContain("содержание не проверено");
  });
  it("keeps a document valid through the end of its expiry date", () => {
    const document = { ...emptyStaffDocument(), expiresDate: "2026-08-26" };
    expect(documentExpiry(document, 60, new Date("2026-08-26T12:00:00"))).toBe("expiring");
    expect(documentExpiry(document, 60, new Date("2026-08-27T00:00:00"))).toBe("expired");
  });

  it("lists missing procurement evidence", () => {
    const result = staffRequirements({ ...emptyStaff(), fullName: "Иванов", role: "Эксперт" });
    expect(result.ready).toBe(false);
    expect(result.missing).toContain("Диплом");
    expect(result.total).toBeGreaterThan(result.met);
  });
  it("counts document metadata separately from attached files without claiming procurement compliance", () => {
    const document = { ...emptyStaffDocument("education"), name: "Диплом", unlimited: true };
    const item = { ...emptyStaff(), documents: [document] };
    const withoutFile = staffRequirements(item);
    expect(withoutFile.missing).not.toContain("Диплом");
    expect(withoutFile.files).toEqual({ attached: 0, total: 1, missing: ["Диплом"] });
    const withFile = staffRequirements({ ...item, documents: [{ ...document, relativePath: "attachments/degree.pdf" }] });
    expect(withFile.met).toBe(withoutFile.met);
    expect(withFile.files).toEqual({ attached: 1, total: 1, missing: [] });
    expect(document).not.toHaveProperty("relativePath");
  });
});
