import { describe, expect, it } from "vitest";
import { demoProcurements } from "./demo";

describe("демонстрационные закупки", () => {
  it("создаёт три разные и заполненные карточки с относительными сроками", () => {
    const rows = demoProcurements(new Date("2026-08-28T12:00:00Z"));
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(rows.every((row) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id))).toBe(true);
    expect(rows.every(({ item }) => item.name.startsWith("ДЕМО · ") && item.customer && item.subject && item.nmc > 0)).toBe(true);
    expect(rows[0].item.submissionDeadline).toBe("2026-09-06");
    expect(rows.every(({ item }) => item.requirements.length >= 3 && item.checklist.length >= 3)).toBe(true);
  });
});
