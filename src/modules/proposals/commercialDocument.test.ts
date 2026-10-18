import { describe, expect, it } from "vitest";
import { COMMERCIAL_DOCUMENT_LIMITS, commercialFingerprint, validateCommercialBody, validateCommercialDocument, validateCommercialQuoteHashes, type CommercialAppliedTermDecision, type CommercialBody, type CommercialClauseCoverage, type ProposalCommercialDocumentV1 } from "./commercialDocument";

async function document(): Promise<ProposalCommercialDocumentV1> {
  return { version: 1, revision: 1, body: { version: 1, sections: [{ id: "scope", kind: "scope", title: "Работы", blocks: [{ id: "block", kind: "paragraph", style: "body", content: [{ kind: "text", text: "Проверка по предоставленным материалам." }] }] }] }, privateAppendix: { version: 1, sourceSnapshotKey: await commercialFingerprint("snapshot"), documentId: "contract", extraction: { complete: true, requiresOcr: false, visualAssessment: "unassessed" }, containers: [{ id: "container", sourceId: "source", kind: "contract", heading: "Договор" }], clauses: [{ id: "clause", containerId: "container", sourceId: "source", sourceName: "Вход", locator: "Абзац 1", quote: "Проверка по предоставленным материалам.", quoteHash: await commercialFingerprint("Проверка по предоставленным материалам."), roles: ["scope"], classification: "commercial" }], references: [], coverage: [{ sourceClauseId: "clause", kind: "literal", targetBlockIds: ["block"] }] }, questions: [], decisions: [] };
}
async function receiptDecision(data: ProposalCommercialDocumentV1, sourceCoverageBefore: CommercialClauseCoverage[]): Promise<CommercialAppliedTermDecision> {
  const hash = await commercialFingerprint("binding");
  return { version: 1, id: "decision", questionId: "question", answer: { kind: "advance-days", dayKind: "business" }, origin: "user", appliedAt: "2030-01-01T00:00:00.000Z", sourceSnapshotKey: data.privateAppendix.sourceSnapshotKey, dependencyFingerprint: hash, sourceClauseIds: ["clause"], changedBlockIds: ["block"], beforeFingerprint: hash, afterFingerprint: hash, sourceCoverageBefore };
}

describe("commercial closed AST", () => {
  it("accepts the bounded paragraph/list/table AST and local forward references", () => {
    const body: CommercialBody = { version: 1, sections: [{ id: "s", kind: "scope", title: "Работы", blocks: [
      { id: "p", kind: "paragraph", style: "body", content: [{ kind: "local-ref", targetId: "table" }, { kind: "local-ref", targetId: "s" }] },
      { id: "list", kind: "list", style: "bullet", items: [[{ kind: "text", text: "При наличии доступа" }]] },
      { id: "table", kind: "table", columns: ["Проверка", "Условие"], rows: [[[{ kind: "text", text: "Код" }], [{ kind: "text", text: "При наличии репозитория" }]]] },
    ] }] };
    expect(validateCommercialBody(body)).toEqual([]);
  });
  it("rejects arbitrary nodes, HTML properties and rich-text recursion", () => {
    expect(validateCommercialBody({ version: 1, sections: [{ id: "s", kind: "scope", title: "x", blocks: [{ id: "p", kind: "paragraph", style: "body", content: [{ kind: "text", text: "x", html: "<script>" }] }] }] })).toHaveLength(1);
    expect(validateCommercialBody({ version: 1, sections: [{ id: "s", kind: "scope", title: "x", blocks: [{ id: "p", kind: "iframe", src: "file:///" }] }] })).toHaveLength(1);
  });
  it("does not mistake plain angle brackets for executable HTML", () => {
    expect(validateCommercialBody({ version: 1, sections: [{ id: "s", kind: "scope", title: "x", blocks: [{ id: "p", kind: "paragraph", style: "body", content: [{ kind: "text", text: "Значение < 5; <script> — буквальный исходный текст" }] }] }] })).toEqual([]);
  });
  it.each(["\u007f", "\u0085", "\u009f"])("rejects the same control character %j as the public renderer", async (control) => {
    const data = await document(); const block = data.body.sections[0].blocks[0];
    if (block.kind === "paragraph") block.content = [{ kind: "text", text: `До${control}после` }];
    expect(validateCommercialBody(data.body).some((issue) => issue.severity === "error")).toBe(true);
  });
  it("rejects duplicate ids and dangling targets", async () => {
    const data = await document(); data.body.sections[0].blocks.push({ id: "block", kind: "paragraph", style: "body", content: [{ kind: "local-ref", targetId: "missing" }] });
    expect(validateCommercialBody(data.body).map((issue) => issue.message)).toEqual(expect.arrayContaining([expect.stringMatching(/повторный/), expect.stringMatching(/не имеет цели/)]));
  });
  it.each(["sections", "blocks", "columns", "rows", "items", "element"] as const)("enforces %s without truncation", async (limit) => {
    const data = await document(), body = data.body;
    if (limit === "sections") body.sections = Array.from({ length: COMMERCIAL_DOCUMENT_LIMITS.sections + 1 }, (_x, i) => ({ id: `s${i}`, kind: "scope", title: "x", blocks: [] }));
    if (limit === "blocks") body.sections[0].blocks = Array.from({ length: COMMERCIAL_DOCUMENT_LIMITS.blocks + 1 }, (_x, i) => ({ id: `b${i}`, kind: "paragraph", style: "body", content: [] }));
    if (limit === "columns") body.sections[0].blocks = [{ id: "b", kind: "table", columns: Array(9).fill("x"), rows: [] }];
    if (limit === "rows") body.sections[0].blocks = [{ id: "b", kind: "table", columns: ["x"], rows: Array.from({ length: 2001 }, () => [[{ kind: "text", text: "x" }]]) }];
    if (limit === "items") body.sections[0].blocks = [{ id: "b", kind: "list", style: "bullet", items: Array.from({ length: 2001 }, () => [{ kind: "text", text: "x" }]) }];
    if (limit === "element") body.sections[0].blocks = [{ id: "b", kind: "paragraph", style: "body", content: [{ kind: "text", text: "я".repeat(20001) }] }];
    const before = JSON.stringify(body); expect(validateCommercialBody(body).length).toBeGreaterThan(0); expect(JSON.stringify(body)).toBe(before);
  });
  it("enforces global UTF-8 bytes, not only per-element characters", async () => {
    const data = await document(); data.body.sections[0].blocks = Array.from({ length: 300 }, (_x, i) => ({ id: `b${i}`, kind: "paragraph", style: "body", content: [{ kind: "text", text: "я".repeat(20000) }] }));
    expect(validateCommercialBody(data.body).some((issue) => /8 МБ/.test(issue.message))).toBe(true);
  });
});

describe("commercial private appendix", () => {
  it("validates exact quote hashes and does not claim semantic readiness", async () => {
    const data = await document(); expect(validateCommercialDocument(data)).toEqual([]); expect(await validateCommercialQuoteHashes(data)).toEqual([]);
    data.privateAppendix.clauses[0].quote += " Изменено.";
    expect((await validateCommercialQuoteHashes(data)).map((issue) => issue.code)).toContain("commercial-quote-hash");
  });
  it("canonical key ordering does not invalidate otherwise exact values", async () => {
    expect(await commercialFingerprint({ b: "2", a: "1" })).toBe(await commercialFingerprint({ a: "1", b: "2" }));
    expect(await commercialFingerprint(["1", "2"])).not.toBe(await commercialFingerprint(["2", "1"]));
  });
  it("rejects multi-node parent cycles", async () => {
    const data = await document(); data.privateAppendix.containers[0].parentId = "c";
    data.privateAppendix.containers.push({ id: "b", parentId: "container", sourceId: "source", kind: "appendix", heading: "B" }, { id: "c", parentId: "b", sourceId: "source", kind: "appendix", heading: "C" });
    expect(validateCommercialDocument(data).some((issue) => /цикл/.test(issue.message))).toBe(true);
  });
  it("requires a clause and its container to have the same source owner", async () => {
    const data = await document(); data.privateAppendix.clauses[0].sourceId = "another-source";
    expect(validateCommercialDocument(data).some((issue) => /другому namespace/.test(issue.message))).toBe(true);
  });
  it("rejects dangling decision receipts, including split parts", async () => {
    const data = await document(); data.privateAppendix.coverage = [{ sourceClauseId: "clause", kind: "superseded-by-decision", decisionId: "missing" }];
    expect(validateCommercialDocument(data).some((issue) => /отсутствует в журнале/.test(issue.message))).toBe(true);
  });
  it("validates a long acyclic namespace chain without repeated ancestor walks", async () => {
    const data = await document();
    for (let index = 1; index < 5000; index++) data.privateAppendix.containers.push({ id: `c${index}`, parentId: index === 1 ? "container" : `c${index - 1}`, sourceId: "source", kind: "appendix", heading: "Приложение" });
    expect(validateCommercialDocument(data)).toEqual([]);
  });
  it("requires one explicit coverage entry for every original fragment", async () => {
    const data = await document(); data.privateAppendix.coverage = [];
    expect(validateCommercialDocument(data).some((issue) => /Каждый исходный/.test(issue.message))).toBe(true);
  });
  it("binds reference spans exactly and accepts section or block targets", async () => {
    const data = await document(); const clause = data.privateAppendix.clauses[0];
    data.privateAppendix.references = [{ id: "r", sourceClauseId: "clause", kind: "section", span: { startUtf16: 0, endUtf16: 8 }, printed: clause.quote.slice(0, 8), candidateClauseIds: ["clause"], localTargetIds: ["scope", "block"] }];
    expect(validateCommercialDocument(data)).toEqual([]);
    data.privateAppendix.references[0].printed = "Не исходник";
    expect(validateCommercialDocument(data).some((issue) => /точному/.test(issue.message))).toBe(true);
  });
  it("requires split spans to cover the entire immutable clause", async () => {
    const data = await document(), length = data.privateAppendix.clauses[0].quote.length;
    data.body.sections[0].blocks.push({ id: "deadline", kind: "paragraph", style: "body", content: [{ kind: "text", text: "Срок" }] });
    data.privateAppendix.coverage = [{ sourceClauseId: "clause", kind: "split", parts: [
      { targetBlockId: "block", purpose: "advance-base", spans: [{ startUtf16: 0, endUtf16: 10 }] },
      { targetBlockId: "deadline", purpose: "advance-days", spans: [{ startUtf16: 10, endUtf16: length }] },
    ] }];
    expect(validateCommercialDocument(data)).toEqual([]);
    const entry = data.privateAppendix.coverage[0]; if (entry.kind === "split") entry.parts[1].spans[0].startUtf16++;
    expect(validateCommercialDocument(data).some((issue) => /покрытия/.test(issue.message))).toBe(true);
  });
  it("does not treat private classification as an approval flag", async () => {
    const data = await document(); data.privateAppendix.clauses[0].classification = "excluded-material";
    data.privateAppendix.coverage = [{ sourceClauseId: "clause", kind: "private-context", reason: "Сохранено для проверки, не разрешение исключить." }];
    expect(validateCommercialDocument(data)).toEqual([]);
    expect(data.privateAppendix.extraction.visualAssessment).toBe("unassessed");
    expect(data.decisions).toEqual([]);
  });
});

describe("private initial source coverage receipts", () => {
  it("accepts a clean bounded original layout without treating it as approval", async () => {
    const data = await document(); data.decisions = [await receiptDecision(data, structuredClone(data.privateAppendix.coverage))];
    expect(validateCommercialDocument(data)).toEqual([]);
    expect(data.decisions[0].sourceCoverageBefore).toEqual(data.privateAppendix.coverage);
  });
  it.each(["foreign-clause", "dangling-target", "duplicate", "superseded", "unknown-key"] as const)("rejects %s source layout receipts", async (kind) => {
    const data = await document(), receipt: CommercialClauseCoverage = { sourceClauseId: "clause", kind: "literal", targetBlockIds: ["block"] };
    let receipts: CommercialClauseCoverage[] = [receipt];
    if (kind === "foreign-clause") receipt.sourceClauseId = "missing";
    if (kind === "dangling-target") receipt.targetBlockIds = ["missing"];
    if (kind === "duplicate") receipts = [receipt, receipt];
    if (kind === "superseded") receipts = [{ sourceClauseId: "clause", kind: "superseded-by-decision", decisionId: "decision" }];
    if (kind === "unknown-key") Object.assign(receipt, { trusted: true });
    data.decisions = [await receiptDecision(data, receipts)];
    expect(validateCommercialDocument(data).some((issue) => issue.path.includes("sourceCoverageBefore"))).toBe(true);
  });
  it("rejects superseded markers anywhere in a split receipt", async () => {
    const data = await document(), length = data.privateAppendix.clauses[0].quote.length;
    data.body.sections[0].blocks.push({ id: "deadline", kind: "paragraph", style: "body", content: [{ kind: "text", text: "x" }] });
    const clean: CommercialClauseCoverage = { sourceClauseId: "clause", kind: "split", parts: [
      { targetBlockId: "block", purpose: "advance-base", spans: [{ startUtf16: 0, endUtf16: 10 }] },
      { targetBlockId: "deadline", purpose: "advance-days", spans: [{ startUtf16: 10, endUtf16: length }] },
    ] };
    data.decisions = [await receiptDecision(data, [clean])]; expect(validateCommercialDocument(data)).toEqual([]);
    clean.parts[0].supersededByDecisionId = "previous-decision";
    expect(validateCommercialDocument(data).some((issue) => issue.path.includes("sourceCoverageBefore"))).toBe(true);
  });
  it("binds snapshot references to this exact source clause", async () => {
    const data = await document(), first = data.privateAppendix.clauses[0];
    data.privateAppendix.clauses.push({ ...first, id: "other-clause" });
    data.privateAppendix.coverage.push({ sourceClauseId: "other-clause", kind: "private-context", reason: "Исходный контекст" });
    data.privateAppendix.references.push({ id: "other-ref", sourceClauseId: "other-clause", span: { startUtf16: 0, endUtf16: 8 }, printed: first.quote.slice(0, 8), kind: "clause", candidateClauseIds: ["clause"] });
    data.decisions = [await receiptDecision(data, [{ sourceClauseId: "clause", kind: "projected", targetBlockIds: ["block"], referenceIds: ["other-ref"] }])];
    expect(validateCommercialDocument(data).some((issue) => issue.path.includes("sourceCoverageBefore"))).toBe(true);
  });
  it("rejects incomplete source span coverage and out-of-range context", async () => {
    const data = await document(), length = data.privateAppendix.clauses[0].quote.length;
    data.body.sections[0].blocks.push({ id: "deadline", kind: "paragraph", style: "body", content: [] });
    data.decisions = [await receiptDecision(data, [{ sourceClauseId: "clause", kind: "split", parts: [
      { targetBlockId: "block", purpose: "advance-base", spans: [{ startUtf16: 0, endUtf16: 5 }] },
      { targetBlockId: "deadline", purpose: "advance-days", spans: [{ startUtf16: 6, endUtf16: length }], contextSpans: [{ startUtf16: 0, endUtf16: length + 1 }] },
    ] }])];
    expect(validateCommercialDocument(data).some((issue) => issue.path.includes("sourceCoverageBefore"))).toBe(true);
  });
});
