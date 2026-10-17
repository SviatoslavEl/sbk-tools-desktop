import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGroundedIntelligenceSchema } from "./sourceGrounding";
import { buildGroundedAnalysisInput } from "./groundedAnalysis";
import { buildAnalysisPlan } from "./analysisPlan";
import { runIntelligenceAnalysis, type ConnectionProfile } from "./connectionApi";
import { auditIntelligenceResult } from "./resultEvidence";
import * as model from "./workbenchModel";
import type { IntelligenceDestination, IntelligenceSource } from "./workbenchTypes";

const ipc = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));
type Node = Record<string, unknown>;
const node = (value: unknown) => value as Node;
const destinations: IntelligenceDestination[] = ["procurement", "contracts", "staff", "counterparties", "proposals"];
const first = "13de4002-86b5-40c0-8fe3-62eb6a45035b", second = "24819b8e-28f7-4420-a37d-b7c91aa25dec";
const source = (id = first): IntelligenceSource => ({ id, name: "Синтетический источник QA", text: "ФИО: Бетов Борис Борисович" });
function variants(schema: Node): Node[] {
  const item = node(node(node(schema.properties).items).items);
  return (Array.isArray(item.anyOf) ? item.anyOf : [item]) as Node[];
}
function sourceEnums(variant: Node) {
  const props = node(variant.properties);
  return { item: node(node(props.sourceIds).items).enum, evidence: node(node(node(props.evidence).items).properties).sourceId as Node };
}
const freeze = <T,>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; };
beforeEach(() => { ipc.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("exact selected-source identifiers in the grounded schema", () => {
  it.each(destinations)("constrains both reference locations in %s without inferring entity ownership", (destination) => {
    const inputs = [source(), source(second)], before = structuredClone(inputs), schema = buildGroundedIntelligenceSchema(inputs, [destination]).schema;
    const refs = sourceEnums(variants(schema)[0]);
    expect(refs.item).toEqual([first, second]); expect(refs.evidence.enum).toEqual([first, second]);
    expect(refs.evidence.type).toBe("string"); expect(inputs).toEqual(before);
  });

  it("constrains every selected destination branch independently and keeps source/destination filtering exact", () => {
    const selected = [source(second)], dirs: IntelligenceDestination[] = ["staff", "proposals"];
    const steps = buildAnalysisPlan("Подготовь карточки QA", selected, dirs, "by-destination");
    expect(steps).toHaveLength(2);
    for (const [index, step] of steps.entries()) {
      const branch = variants(step.responseSchema);
      expect(branch).toHaveLength(1); expect(node(node(branch[0].properties).destination).enum).toEqual([dirs[index]]);
      expect(sourceEnums(branch[0]).item).toEqual([second]); expect(sourceEnums(branch[0]).evidence.enum).toEqual([second]);
      expect(step.prompt).not.toContain(first);
    }
    const all = variants(buildGroundedIntelligenceSchema([source(), source(second)], destinations).schema);
    expect(all).toHaveLength(5);
    for (const branch of all) { expect(sourceEnums(branch).item).toEqual([first, second]); expect(sourceEnums(branch).evidence.enum).toEqual([first, second]); }
  });

  it("does not mutate a frozen base schema, source selection, or reference arrays belonging to other schema branches", () => {
    const inputs = [source()], dirs: IntelligenceDestination[] = ["staff", "proposals"], base = model.buildIntelligenceResponseSchema(dirs), before = structuredClone({ inputs, dirs, base });
    freeze(base); vi.spyOn(model, "buildIntelligenceResponseSchema").mockReturnValue(base);
    const schema = buildGroundedIntelligenceSchema(inputs, dirs).schema;
    expect({ inputs, dirs, base }).toEqual(before);
    const branches = variants(schema); (sourceEnums(branches[0]).item as string[]).push("LOCAL-CHANGE");
    expect(sourceEnums(branches[0]).evidence.enum).toEqual([first]); expect(sourceEnums(branches[1]).item).toEqual([first]); expect(inputs[0].id).toBe(first);
    expect(sourceEnums(variants(base)[0]).item).toBeUndefined();
  });

  it.each(["", " ", "bad\nsource", "x".repeat(129), undefined, null, 42])("rejects an invalid source ID %j rather than inventing or silently dropping it", (id) => {
    const bad = { ...source(), id } as unknown as IntelligenceSource;
    expect(() => buildGroundedIntelligenceSchema([source(second), bad], ["staff"])).toThrow(/источник/u);
  });

  it("rejects all-invalid or duplicate source selections, including duplicates with different names", () => {
    expect(() => buildGroundedIntelligenceSchema([source(""), source(" ")], ["staff"])).toThrow(/источник/u);
    expect(() => buildGroundedIntelligenceSchema([source(), { ...source(), name: "Другой файл" }], ["staff"])).toThrow(/источник/u);
    expect(() => buildGroundedIntelligenceSchema(Array.from({ length: 101 }, (_, index) => source(`source-${index}`)), ["staff"])).toThrow(/источник/u);
  });

  it("keeps a source-free utility schema valid without an invalid empty enum or a fabricated reference", () => {
    const schema = buildGroundedIntelligenceSchema([], destinations).schema;
    expect(node(node(schema.properties).items).maxItems).toBe(0);
    for (const variant of variants(schema)) {
      const props = node(variant.properties);
      expect(node(props.sourceIds).maxItems).toBe(0); expect(node(props.evidence).maxItems).toBe(0);
      expect(sourceEnums(variant).item).toBeUndefined(); expect(sourceEnums(variant).evidence.enum).toBeUndefined();
    }
    expect(JSON.stringify(schema)).not.toContain('"enum":[]');
  });

  it.each(["hidden", "excluded"])("does not make %s fragments or aggregate text into source facts merely by whitelisting the selected document ID", (kind) => {
    const input = { ...source(), text: "Срок подачи: 03.08.2039\nЗаказчик: Скрытая Компания QA", fragments: kind === "excluded" ? [] : [{ id: "old", locator: "История", text: "Срок подачи: 03.08.2039\nЗаказчик: Скрытая Компания QA", sheetState: "hidden" as const }] };
    const grounded = buildGroundedAnalysisInput("Подготовь закупку", [input], ["procurement"]), branch = variants(grounded.responseSchema)[0];
    expect(sourceEnums(branch).item).toEqual([first]); expect(grounded.prompt).not.toContain("Скрытая Компания QA");
    expect(node(node(node(branch.properties).fields).properties).submissionDeadline).toMatchObject({ enum: [null] });
    const [item] = model.parseIntelligenceResult(JSON.stringify({ items: [{ destination: "procurement", title: "QA", fields: { customer: "Скрытая Компания QA" }, sourceIds: [first], evidence: [{ field: "customer", sourceId: first, fragmentId: "old", quote: "Заказчик: Скрытая Компания QA" }] }] }), [first]);
    const report = auditIntelligenceResult([item], [input]);
    expect(report.fields.find((field) => field.field === "customer")?.status).not.toBe("confirmed");
    expect(report.findings.some((finding) => finding.code === "invalid-evidence-quote")).toBe(true);
  });

  it("fails closed at the 64 KiB ceiling instead of weakening the exact source enums", () => {
    const inputs = Array.from({ length: 100 }, (_, index) => source(`${index.toString().padStart(3, "0")}-${"x".repeat(124)}`));
    expect(() => buildGroundedIntelligenceSchema(inputs, destinations)).toThrow(/64 КБ/u);
    const single = buildGroundedIntelligenceSchema(inputs, ["staff"]).schema;
    expect(sourceEnums(variants(single)[0]).item).toHaveLength(100);
  });

  it("continues rejecting the native typo, unknown IDs, evidence typos and duplicate references without changing raw JSON", () => {
    const item = { destination: "staff", title: "QA", fields: { fullName: "Бетов Борис Борисович" }, sourceIds: [first], evidence: [{ field: "fullName", sourceId: first, fragmentId: null, quote: "Бетов Борис Борисович" }] };
    const typo = first.replace("40c0", "40c");
    const invalid = [{ ...item, sourceIds: [typo] }, { ...item, sourceIds: ["unknown"] }, { ...item, sourceIds: [first, first] }, { ...item, evidence: [{ ...item.evidence[0], sourceId: typo }] }];
    for (const entry of invalid) { const raw = JSON.stringify({ items: [entry] }), before = raw; expect(() => model.parseIntelligenceResult(raw, [first], { editableFields: true, destinations: ["staff"] })).toThrow(/источник|подтверждени/u); expect(raw).toBe(before); }
    expect(model.parseIntelligenceResult(JSON.stringify({ items: [item] }), [first], { editableFields: true, destinations: ["staff"] })).toHaveLength(1);
  });

  it.each(["ollama", "openai-compatible"] as const)("passes the same exact schema through the %s structured-output API without any model call", async (protocol) => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} }); ipc.mockResolvedValue({ text: '{"items":[]}', model: "qa" });
    const grounded = buildGroundedAnalysisInput("Подготовь кадры QA", [source()], ["staff"]);
    const profile: ConnectionProfile = { id: "qa-profile", name: "QA", scope: "local", protocol, endpoint: "http://127.0.0.1:11434", model: "qa", timeoutSeconds: 120, outputMode: "schema" };
    await runIntelligenceAnalysis(profile, grounded.prompt, undefined, "00000000-0000-4000-8000-000000000001", grounded.responseSchema);
    expect(ipc).toHaveBeenCalledTimes(1);
    const sent = ipc.mock.calls[0][1].responseSchema as Node;
    expect(sourceEnums(variants(sent)[0]).item).toEqual([first]); expect(sourceEnums(variants(sent)[0]).evidence.enum).toEqual([first]);
    expect(ipc.mock.calls[0][1].prompt).toBe(grounded.prompt);
  });
});
