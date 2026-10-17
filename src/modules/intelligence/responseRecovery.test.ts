import { describe, expect, it } from "vitest";
import { diagnoseResponseSources, evidenceSourceIssue, failedIntelligenceResponse, sourceListIssue, sourceReferenceMessage } from "./responseRecovery";
import { parseIntelligenceResult } from "./workbenchModel";

const good = "13de4002-86b5-40c0-8fe3-62eb6a45035b", bad = "13de4002-86b5-40c-8fe3-62eb6a45035b";
const sources = [{ id: good, name: "Исходный документ QA" }];
const item = { destination: "staff", title: "Синтетическая карточка", fields: { fullName: "Бетов Борис Борисович", notes: "PRIVATE-FIELD" }, sourceIds: [good], evidence: [{ field: "fullName", sourceId: good, quote: "PRIVATE-QUOTE" }] };
const raw = (value: unknown = item) => JSON.stringify({ items: [value] });
describe("read-only recovery of a rejected source reference", () => {
  it("names the exact unknown ID and locations but never emits field values or quotes", () => {
    const text = raw({ ...item, sourceIds: [bad], evidence: [{ ...item.evidence[0], sourceId: bad }] }), before = text;
    const result = diagnoseResponseSources(text, [good]);
    expect(result).toEqual({ issues: [{ kind: "unknown", path: "items[0].sourceIds[0]", sourceId: bad }, { kind: "unknown", path: "items[0].evidence[0].sourceId", sourceId: bad }], moreIssues: false });
    const explanation = result.issues.map(sourceReferenceMessage).join(" ");
    expect(explanation).toContain(bad); expect(explanation).not.toContain("PRIVATE"); expect(text).toBe(before);
    expect(() => parseIntelligenceResult(text, [good], { editableFields: true })).toThrow(bad);
  });
  it("distinguishes duplicate, malformed and uncited references without guessing a replacement", () => {
    expect(sourceListIssue([good, good], [good], "items[0].sourceIds")).toEqual({ kind: "duplicate", path: "items[0].sourceIds[1]", sourceId: good });
    expect(sourceListIssue([{}], [good], "items[0].sourceIds")).toEqual({ kind: "invalid", path: "items[0].sourceIds[0]" });
    expect(evidenceSourceIssue(good, [good], [], "items[0].evidence[0].sourceId")).toEqual({ kind: "uncited", path: "items[0].evidence[0].sourceId", sourceId: good });
    expect(() => parseIntelligenceResult(raw({ ...item, sourceIds: [good, good] }), [good], { editableFields: true })).toThrow(/Повторяющаяся.*sourceIds\[1\]/u);
    expect(() => parseIntelligenceResult(raw({ ...item, sourceIds: [null] }), [good], { editableFields: true })).toThrow(/Недопустимый формат.*sourceIds\[0\]/u);
    expect(() => parseIntelligenceResult(raw({ ...item, sourceIds: [] }), [good], { editableFields: true })).toThrow(/отсутствует в sourceIds/u);
  });
  it.each(["", "\n", "x".repeat(129), {}, null, 7])("does not echo a malformed reference %j", (value) => {
    const issue = sourceListIssue([value], [good], "items[0].sourceIds")!;
    expect(issue.kind).toBe("invalid"); expect(issue.sourceId).toBeUndefined(); expect(sourceReferenceMessage(issue)).toContain("Недопустимый формат");
  });
  it("does not diagnose duplicate-key/invalid JSON as recoverable cards", () => {
    for (const text of ['{"items":[],"items":[]}', "not JSON", "[]", raw({ ...item, evidence: [] })]) expect(diagnoseResponseSources(text, [good])).toEqual({ issues: [], moreIssues: false });
  });
  it("supports the existing single fenced JSON envelope without changing its bytes", () => {
    const text = `\n\`\`\`json\n${raw({ ...item, sourceIds: [bad], evidence: [] })}\n\`\`\`\n`;
    const snapshot = failedIntelligenceResponse(text, sources, "Ошибка", "manual")!;
    expect(snapshot.raw).toBe(text); expect(snapshot.issues[0].sourceId).toBe(bad);
  });
  it("retains the exact bounded raw answer, mode and stage without storing any source text", () => {
    const text = raw({ ...item, sourceIds: [bad] }), snapshot = failedIntelligenceResponse(text, sources, "e".repeat(2000), "json", "Кадры")!;
    expect(snapshot.raw).toBe(text); expect(snapshot.message).toHaveLength(1000); expect(snapshot.format).toBe("json"); expect(snapshot.stage).toBe("Кадры");
    expect(Object.keys(snapshot).sort()).toEqual(["format", "issues", "message", "moreIssues", "raw", "sources", "stage"]);
    expect(failedIntelligenceResponse("я".repeat(1024 * 1024 + 1), sources, "Ошибка", "json")).toBeNull();
  });
  it("clones and freezes source identities/display names, excluding all document bodies", () => {
    const selected = [{ id: good, name: "Исходное имя QA", text: "PRIVATE-SOURCE-CONTENT", fragments: [{ text: "PRIVATE-SOURCE-QUOTE" }] }];
    const snapshot = failedIntelligenceResponse(raw(), selected, "Ошибка", "schema")!;
    selected[0].id = bad; selected[0].name = "Новое имя QA"; selected.push({ ...selected[0] });
    expect(snapshot.sources).toEqual([{ id: good, name: "Исходное имя QA" }]); expect(Object.isFrozen(snapshot.sources)).toBe(true); expect(Object.isFrozen(snapshot.sources[0])).toBe(true);
    expect(JSON.stringify(snapshot.sources)).not.toContain("PRIVATE"); expect(snapshot.raw).toBe(raw());
  });
  it("keeps IDs exact and marks only shortened display names, with explicit source/metadata bounds", () => {
    const name = "😀".repeat(201), snapshot = failedIntelligenceResponse(raw(), [{ id: good, name }], "Ошибка", "json")!;
    expect(snapshot.sources).toEqual([{ id: good, name: "😀".repeat(200), nameTruncated: true }]); expect(snapshot.sources[0].id).toBe(good);
    expect(failedIntelligenceResponse(raw(), [{ id: good, name: "x".repeat(20_001) }], "Ошибка", "json")).toBeNull();
    expect(failedIntelligenceResponse(raw(), [...sources, ...sources], "Ошибка", "json")).toBeNull();
    expect(failedIntelligenceResponse(raw(), Array.from({ length: 101 }, (_, index) => ({ id: `source-${index}`, name: "QA" })), "Ошибка", "json")).toBeNull();
    const maximal = Array.from({ length: 100 }, (_, index) => ({ id: `${index}-${"😀".repeat(120)}`, name: "😀".repeat(10_000) }));
    const result = failedIntelligenceResponse(raw(), maximal, "Ошибка", "json")!;
    expect(result.sources).toHaveLength(100); expect(new TextEncoder().encode(JSON.stringify(result.sources)).byteLength).toBeLessThanOrEqual(256 * 1024);
  });
  it("caps diagnostics explicitly, rejects oversized envelopes and does not use duplicate available IDs", () => {
    const text = raw({ ...item, sourceIds: [], evidence: Array.from({ length: 20 }, () => ({ ...item.evidence[0], sourceId: bad })) });
    expect(diagnoseResponseSources(text, [good])).toMatchObject({ moreIssues: true }); expect(diagnoseResponseSources(text, [good]).issues).toHaveLength(12);
    expect(diagnoseResponseSources(text, [good, good]).issues).toHaveLength(0);
    expect(diagnoseResponseSources("x".repeat(2 * 1024 * 1024 + 1), [good]).issues).toHaveLength(0);
  });
  it("does not bind a known-but-unselected ID or a near-match automatically", () => {
    expect(diagnoseResponseSources(raw(), [bad]).issues[0]).toEqual({ kind: "unknown", path: "items[0].sourceIds[0]", sourceId: good });
    expect(() => parseIntelligenceResult(raw(), [bad], { editableFields: true })).toThrow();
    expect(parseIntelligenceResult(raw(), [good], { editableFields: true })).toHaveLength(1);
  });
});
