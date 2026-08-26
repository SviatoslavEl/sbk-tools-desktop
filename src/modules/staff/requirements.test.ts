import { describe, expect, it } from "vitest";
import { emptyStaff, emptyStaffDocument } from "./types";
import { documentExpiry, staffRequirements } from "./requirements";

describe("staff requirements", () => {
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
});
