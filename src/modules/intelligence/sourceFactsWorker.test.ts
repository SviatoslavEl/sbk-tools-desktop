import { afterEach, describe, expect, it, vi } from "vitest";
import { collectSourceFacts, runSourceFacts, validSourceFactsInventory } from "./sourceFactsWorker";
import type { IntelligenceSource } from "./workbenchTypes";

const source = (text: string, extra: Partial<IntelligenceSource> = {}): IntelligenceSource => ({ id: "facts-qa", name: "Синтетические исходники QA", text, ...extra });
const rich = [source("Срок подачи: 03.08.2039 11:45 MSK\nАртикул: SRV-QA-11\nНаименование: Сервер QA\nСервер QA в составе:\n- CPU: тестовый 16 ядер\n- RAM: 64 ГБ\nУсловия оплаты: 100% предоплата.")];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("local source inventory worker protocol", () => {
  it("returns all three inventories without IO, model calls, persistence or source mutation", () => {
    const fetch = vi.fn(), storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal("fetch", fetch); vi.stubGlobal("window", { localStorage: storage, sessionStorage: storage });
    const before = structuredClone(rich);
    const reply = runSourceFacts({ revision: 9, sources: rich });
    expect(reply.revision).toBe(9); expect(reply.failed).toBeUndefined();
    expect(validSourceFactsInventory(reply.inventory)).toBe(true);
    expect(reply.inventory!.dates.facts).toHaveLength(1);
    expect(reply.inventory!.positions.positions).toHaveLength(1);
    expect(reply.inventory!.positions.configurations).toHaveLength(1);
    expect(reply.inventory!.conditions.facts.length).toBeGreaterThan(0);
    expect(rich).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    for (const method of Object.values(storage)) expect(method).not.toHaveBeenCalled();
  });
  it.each([null, undefined, 0, {}, { revision: Number.NaN }, { revision: -1 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 }])("fails closed without throwing for malformed request %j", (request) => {
    expect(() => runSourceFacts(request)).not.toThrow();
    expect(runSourceFacts(request)).toEqual({ revision: -1, failed: true });
  });
  it("rejects malformed, duplicated or oversized sources without serializing the exception or text", () => {
    for (const sources of [null, Array(101).fill(rich[0]), [rich[0], rich[0]], [{ ...rich[0], id: "bad\nsource" }], [{ ...rich[0], text: null }], [{ ...rich[0], fragments: [{ locator: "QA", text: null }] }]]) {
      const reply = runSourceFacts({ revision: 11, sources });
      expect(reply).toEqual({ revision: 11, failed: true });
      expect(JSON.stringify(reply)).not.toContain(rich[0].text);
    }
  });
  it("retains explicit budget flags instead of presenting a partial inventory as complete", () => {
    const reply = runSourceFacts({ revision: 2, sources: [source(Array.from({ length: 5001 }, () => "Строка QA").join("\n"))] });
    expect(reply.failed).toBeUndefined();
    expect(reply.inventory!.dates.limited).toBe(true);
    expect(reply.inventory!.positions.truncated).toBe(true);
    expect(reply.inventory!.conditions.limited).toBe(true);
    expect(validSourceFactsInventory(reply.inventory)).toBe(true);
  });
  it("rejects malformed nested UI data and oversized protocol arrays", () => {
    const base = collectSourceFacts(rich);
    expect(validSourceFactsInventory(base)).toBe(true);
    const invalid: unknown[] = [null, {}, { ...base, dates: null }, { ...base, conditions: { facts: [null], limited: false } }, { ...base, dates: { facts: Array(1001).fill(base.dates.facts[0]), limited: true } }];
    for (const mutate of [
      (copy: typeof base) => { (copy.dates.facts[0] as unknown as Record<string, unknown>).supportingEvidence = [null]; },
      (copy: typeof base) => { (copy.dates.facts[0] as unknown as Record<string, unknown>).event = "unknown"; },
      (copy: typeof base) => { (copy.positions.positions[0] as unknown as Record<string, unknown>).sku = {}; },
      (copy: typeof base) => { (copy.positions.configurations[0] as unknown as Record<string, unknown>).description = null; },
      (copy: typeof base) => { (copy.positions.positions[0] as unknown as Record<string, unknown>).associationProof = "model-order"; },
      (copy: typeof base) => { (copy.positions.configurations[0] as unknown as Record<string, unknown>).associationProof = {}; },
    ]) { const copy = structuredClone(base); mutate(copy); invalid.push(copy); }
    for (const value of invalid) expect(validSourceFactsInventory(value)).toBe(false);
  });
  it("accepts only the known source-layout proof tag without turning it into an acknowledgement", () => {
    const inventory = collectSourceFacts(rich);
    inventory.positions.positions[0].associationProof = "pdf-table-row";
    inventory.positions.configurations[0].associationProof = "pdf-table-row";
    expect(validSourceFactsInventory(inventory)).toBe(true);
    expect(JSON.stringify(inventory)).not.toContain("reviewedFindings");
  });
  it("does not overwrite window.onmessage when the pure module is imported by the browser", async () => {
    const original = vi.fn(), host = { onmessage: original, postMessage: vi.fn() };
    vi.stubGlobal("self", host); vi.stubGlobal("document", {});
    vi.resetModules(); await import("./sourceFactsWorker");
    expect(host.onmessage).toBe(original); expect(host.postMessage).not.toHaveBeenCalled();
  });
  it("installs the handler only in the document-free worker scope", async () => {
    const postMessage = vi.fn();
    const scope: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: typeof postMessage } = { onmessage: null, postMessage };
    vi.stubGlobal("self", scope); vi.stubGlobal("document", undefined);
    vi.resetModules(); await import("./sourceFactsWorker");
    expect(scope.onmessage).toBeTypeOf("function");
    scope.onmessage!({ data: { revision: 4, sources: rich } });
    expect(postMessage.mock.calls[0][0].revision).toBe(4);
    expect(validSourceFactsInventory(postMessage.mock.calls[0][0].inventory)).toBe(true);
  });
});
