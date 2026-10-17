import { describe, expect, it } from "vitest";
import { contractIdentifiers } from "./contractIdentifiers";

describe("explicit compound contract identifiers", () => {
  const full = "QA-18/26 (8100-2026-00037)";
  it.each([`Договор № ${full} от 18.02.2026.`, `Контракт поставки № ${full}.`, `Номер договора: ${full}`])("retains both complete and primary registry forms: %s", (text) => {
    expect(contractIdentifiers(text)).toEqual([full.toLowerCase(), "qa-18/26"]);
  });
  it.each(["Доверенность", "Приложение", "Федеральный закон", "Спецификация"])("does not use a %s number", (kind) => {
    expect(contractIdentifiers(`${kind} № ${full}. Договор поставки № ____.`)).toEqual([]);
    expect(contractIdentifiers(`Договор поставки, ${kind.toLowerCase()} № ${full}`)).toEqual([]);
  });
  it.each(["редакция 2", "261", "ALT-37", "18-02-2026"])("retains a non-registry suffix without silently accepting a prefix: %s", (suffix) => {
    expect(contractIdentifiers(`Договор № QA-18/26 (${suffix}) от 18.02.2026`)).toEqual([`qa-18/26 (${suffix.toLowerCase()})`]);
  });
  it.each(["____", "TBD", "Договор", "QA___", "QA (___)", "QA (TBD)", "QA (доверенность 27)", "QA (8100-2026-00037"])("rejects incomplete or other-document suffixes: %s", (number) => {
    expect(contractIdentifiers(`Договор № ${number}`)).toEqual([]);
  });
  it("does not invent a shorter match on an overlong or underscore-ended token", () => {
    expect(contractIdentifiers(`Договор № ${"A".repeat(81)}`)).toEqual([]);
    expect(contractIdentifiers("Договор № 7___")).toEqual([]);
  });
  it("handles separate explicit contracts without conflating their suffixes", () => {
    expect(contractIdentifiers(`Договор № QA-1; Договор № ${full}`)).toEqual(["qa-1", full.toLowerCase(), "qa-18/26"]);
  });
});
