import { describe, expect, it, vi } from "vitest";
import { taskSourceSnapshotKey } from "./taskSourceIdentity";
import { RESPONSE_PREPARATION_LIMITS } from "./responsePreparationBounds";
import type { IntelligenceSource } from "./workbenchTypes";

const source = (): IntelligenceSource => ({ id: "source-qa", name: "Материал QA", text: "PRIVATE-QA-BODY", sha256: "a".repeat(64), warnings: ["Проверьте полноту."], fragments: [{ id: "p1", locator: "Абзац 1", text: "PRIVATE-QA-FRAGMENT", sheetId: "sheet-1", sheetState: "visible", includedByUser: true }], coverage: { complete: true, requiresOcr: false, pagesWithoutText: [], pagesWithImages: [1] } });

describe("exact bounded task source identity", () => {
  it("returns a deterministic SHA-256 key without exposing source text, names or paths", async () => {
    const sources = [source()], before = structuredClone(sources);
    const first = await taskSourceSnapshotKey(sources), second = await taskSourceSnapshotKey(structuredClone(sources));
    expect(first).toBe(second); expect(first).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first).not.toContain("PRIVATE"); expect(first).not.toContain("Материал"); expect(first).not.toContain("source-qa");
    expect(sources).toEqual(before);
  });

  it("canonicalises object key order while preserving source and fragment array order", async () => {
    const first = source(), reversed = Object.fromEntries(Object.entries(first).reverse()) as unknown as IntelligenceSource;
    reversed.fragments = first.fragments!.map((fragment) => Object.fromEntries(Object.entries(fragment).reverse()) as unknown as NonNullable<IntelligenceSource["fragments"]>[number]);
    reversed.coverage = Object.fromEntries(Object.entries(first.coverage!).reverse()) as unknown as IntelligenceSource["coverage"];
    expect(await taskSourceSnapshotKey([first])).toBe(await taskSourceSnapshotKey([reversed]));
    const second = { ...source(), id: "source-second" };
    expect(await taskSourceSnapshotKey([first, second])).not.toBe(await taskSourceSnapshotKey([second, first]));
    const fragments = { ...first, fragments: [...first.fragments!, { id: "p2", locator: "Абзац 2", text: "Другая строка" }] };
    expect(await taskSourceSnapshotKey([fragments])).not.toBe(await taskSourceSnapshotKey([{ ...fragments, fragments: [...fragments.fragments].reverse() }]));
  });

  it.each(["id", "name", "text", "sha256", "fragment-id", "fragment-text", "fragment-locator", "fragment-sheet", "fragment-selection", "warning", "coverage", "ocr", "pages", "metadata"])("changes identity for changed %s, even when the declared file SHA is unchanged", async (field) => {
    const first = source(), next = structuredClone(first);
    if (field === "id") next.id = "other-source";
    if (field === "name") next.name = "Другой материал";
    if (field === "text") next.text += " — правка";
    if (field === "sha256") next.sha256 = "b".repeat(64);
    if (field === "fragment-id") next.fragments![0].id = "p2";
    if (field === "fragment-text") next.fragments![0].text += " — правка";
    if (field === "fragment-locator") next.fragments![0].locator = "Абзац 2";
    if (field === "fragment-sheet") next.fragments![0].sheetState = "hidden";
    if (field === "fragment-selection") next.fragments![0].includedByUser = false;
    if (field === "warning") next.warnings!.push("Есть изображения.");
    if (field === "coverage") next.coverage!.complete = false;
    if (field === "ocr") next.coverage!.requiresOcr = true;
    if (field === "pages") next.coverage!.pagesWithoutText = [2];
    if (field === "metadata") Object.assign(next.fragments![0], { section: { title: "Точная граница", order: 1 } });
    expect(await taskSourceSnapshotKey([first])).not.toBe(await taskSourceSnapshotKey([next]));
  });

  it("rejects the existing snapshot/shape bounds before calling crypto, without dropping metadata or truncating", async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    try {
      const oversized = { ...source(), text: "я".repeat(RESPONSE_PREPARATION_LIMITS.snapshotBytes / 2 + 1), fragments: [] };
      await expect(taskSourceSnapshotKey([oversized])).rejects.toThrow(/8 МБ/u);
      await expect(taskSourceSnapshotKey([source(), source()])).rejects.toThrow(/идентификатор/u);
      await expect(taskSourceSnapshotKey([{ ...source(), fragments: [{ locator: "Абзац", text: "Текст", unknownMetadata: "Нельзя молча отбросить" }] }] as unknown as IntelligenceSource[])).rejects.toThrow(/фрагмент/u);
      expect(digest).not.toHaveBeenCalled();
    } finally { digest.mockRestore(); }
  });

  it("fails closed without WebCrypto rather than substituting a weak identity", async () => {
    vi.stubGlobal("crypto", undefined);
    try { await expect(taskSourceSnapshotKey([source()])).rejects.toThrow(/WebCrypto/u); }
    finally { vi.unstubAllGlobals(); }
  });
});
