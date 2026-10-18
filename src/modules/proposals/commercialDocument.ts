/** Versioned, private working document. Nothing in this file is model-issued
 * approval, a public DTO, a legal conclusion or filesystem authorization. */
export type CommercialSha256 = `sha256:${string}`;
export type CommercialId = string;
export type CommercialSectionKind = "summary" | "subject" | "scope" | "perimeter" | "deliverables" | "schedule" | "customer-inputs" | "exclusions" | "payment" | "acceptance" | "requisites" | "definitions" | "other";
export type CommercialInline = { kind: "text"; text: string } | { kind: "local-ref"; targetId: CommercialId };
export type CommercialBlock =
  | { id: CommercialId; kind: "paragraph"; style: "body" | "lead" | "subheading" | "caveat"; content: CommercialInline[] }
  | { id: CommercialId; kind: "list"; style: "bullet" | "ordered"; items: CommercialInline[][] }
  | { id: CommercialId; kind: "table"; columns: string[]; rows: CommercialInline[][][] };
export interface CommercialSection { id: CommercialId; kind: CommercialSectionKind; title: string; blocks: CommercialBlock[] }
export interface CommercialBody { version: 1; sections: CommercialSection[] }
export interface CommercialSourceContainer { id: CommercialId; sourceId: CommercialId; parentId?: CommercialId; kind: "contract" | "technical-task" | "appendix" | "unknown"; heading: string }
export type CommercialClauseClassification = "commercial" | "identity" | "financial" | "legal-context" | "editorial" | "structural" | "unclassified" | "excluded-material";
export interface CommercialSourceClause {
  id: CommercialId; containerId: CommercialId; sourceId: CommercialId; sourceName: string; fragmentId?: CommercialId; locator: string;
  /** quoteHash is SHA-256 of canonical JSON(quote), not raw file/text bytes. */
  printedLabel?: string; quote: string; quoteHash: CommercialSha256; roles: CommercialSectionKind[];
  /** Excluded/unknown material is retained, not silently declared irrelevant. */
  classification: CommercialClauseClassification; classificationReason?: string;
}
export interface CommercialSourceReference {
  id: CommercialId; sourceClauseId: CommercialId; span: { startUtf16: number; endUtf16: number }; printed: string;
  kind: "clause" | "section" | "document" | "event"; scopeHint?: "contract" | "technical-task" | "current-container";
  labels?: string[]; candidateClauseIds: CommercialId[];
  /** Only a fresh, unique and fully projected source target can set this. */
  localTargetIds?: CommercialId[];
}
export interface CommercialProjectionPart {
  targetBlockId: CommercialId;
  purpose: CommercialTermQuestionKind | "source-text";
  spans: Array<{ startUtf16: number; endUtf16: number }>;
  /** Context repeated from the same clause, e.g. the stage name for a rule. */
  contextSpans?: Array<{ startUtf16: number; endUtf16: number }>;
  presentation?: CommercialPresentationTransform[];
  supersededByDecisionId?: CommercialId;
}
export interface CommercialPresentationTransform { kind: "leading-label"; span: { startUtf16: number; endUtf16: number } }
export type CommercialClauseCoverage =
  | { sourceClauseId: CommercialId; kind: "literal"; targetBlockIds: CommercialId[] }
  | { sourceClauseId: CommercialId; kind: "projected"; targetBlockIds: CommercialId[]; referenceIds?: CommercialId[]; presentation?: CommercialPresentationTransform[] }
  | { sourceClauseId: CommercialId; kind: "split"; parts: CommercialProjectionPart[]; referenceIds?: CommercialId[] }
  | { sourceClauseId: CommercialId; kind: "deduplicated"; canonicalClauseId: CommercialId; targetBlockIds: CommercialId[] }
  | { sourceClauseId: CommercialId; kind: "external-field"; field: "parties" | "pricing" }
  | { sourceClauseId: CommercialId; kind: "private-context"; reason: string }
  | { sourceClauseId: CommercialId; kind: "superseded-by-decision"; decisionId: CommercialId }
  | { sourceClauseId: CommercialId; kind: "unmapped"; reason: string };
export interface CommercialPrivateAppendix {
  version: 1; sourceSnapshotKey: CommercialSha256; documentId: CommercialId;
  /** This describes extracted/selected TEXT only, never full visual/OCR fidelity. */
  extraction: { complete: boolean; requiresOcr: boolean; visualAssessment: "unassessed" | "unresolved" | "reviewed-by-user" };
  containers: CommercialSourceContainer[]; clauses: CommercialSourceClause[]; references: CommercialSourceReference[]; coverage: CommercialClauseCoverage[];
}
export type CommercialTermQuestionKind = "advance-base" | "advance-days" | "stage-plan" | "stage-parallelism" | "boundary-protocol" | "source-reference";
export interface CommercialTermQuestion {
  id: CommercialId; kind: CommercialTermQuestionKind; sectionId: CommercialId; targetBlockIds: CommercialId[];
  sourceClauseIds: CommercialId[]; sourceReferenceIds: CommercialId[]; message: string; material: boolean; dependencyFingerprint: CommercialSha256;
}
export type CommercialDayKind = "calendar" | "business";
export interface CommercialAgreedStage { id: CommercialId; title: string; scope: string; result: string; duration: { count: string; dayKind: CommercialDayKind } }
export type CommercialStageRelation = { kind: "after"; stageId: CommercialId; afterStageId: CommercialId } | { kind: "may-overlap"; stageIds: CommercialId[]; conditions: string };
export type CommercialTermAnswer =
  | { kind: "advance-base"; base: "net" | "gross"; vatTreatment: "included" | "additional" }
  | { kind: "advance-days"; dayKind: CommercialDayKind }
  | { kind: "stage-plan"; stages: CommercialAgreedStage[]; maximum: { count: string; dayKind: CommercialDayKind } }
  | { kind: "stage-parallelism"; relations: CommercialStageRelation[] }
  | { kind: "boundary-protocol"; milestones: Array<{ title: string; condition: string; beforeStageIds: CommercialId[]; afterStageIds: CommercialId[] }> }
  | { kind: "source-reference"; referenceIds: CommercialId[]; resolution:
      | { kind: "body-target"; targetIds: CommercialId[] }
      | { kind: "governing-document"; definitionTitle: string; definitionText: string }
      | { kind: "replace-clauses"; replacements: Array<{ blockId: CommercialId; publicText: string }> } };
export interface CommercialAppliedTermDecision {
  version: 1; id: CommercialId; questionId: CommercialId; answer: CommercialTermAnswer; origin: "user"; appliedAt: string;
  sourceSnapshotKey: CommercialSha256; dependencyFingerprint: CommercialSha256; sourceClauseIds: CommercialId[]; changedBlockIds: CommercialId[];
  beforeFingerprint: CommercialSha256; afterFingerprint: CommercialSha256; supersedesDecisionId?: CommercialId;
  /** Clean initial source-layout receipts for replay, never authority or
   * approval. Already-superseded snapshots cannot establish original layout. */
  sourceCoverageBefore?: CommercialClauseCoverage[];
}
export interface ProposalCommercialDocumentV1 {
  version: 1; revision: number; body: CommercialBody; privateAppendix: CommercialPrivateAppendix;
  questions: CommercialTermQuestion[]; decisions: CommercialAppliedTermDecision[];
}
export interface CommercialIssue { code: string; path: string; message: string; severity: "error" | "review"; sectionId?: CommercialId }
export const COMMERCIAL_DOCUMENT_LIMITS = Object.freeze({ sections: 64, blocks: 2000, columns: 8, rows: 2000, items: 2000, element: 20_000, bytes: 8 * 1024 * 1024, id: 128, sourceClauses: 5000, references: 20_000, questions: 2000, decisions: 2000 });
const sectionKinds: CommercialSectionKind[] = ["summary", "subject", "scope", "perimeter", "deliverables", "schedule", "customer-inputs", "exclusions", "payment", "acceptance", "requisites", "definitions", "other"];
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && Object.keys(value).every((key) => [...required, ...optional].includes(key));
export const isCommercialId = (value: unknown): value is CommercialId => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
export const isCommercialSha256 = (value: unknown): value is CommercialSha256 => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const text = (value: unknown, required = false): value is string => typeof value === "string" && Array.from(value).length <= COMMERCIAL_DOCUMENT_LIMITS.element && (!required || Boolean(value.trim())) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
const list = (value: unknown, maximum: number): value is unknown[] => Array.isArray(value) && value.length <= maximum;
const ids = (value: unknown, maximum: number = COMMERCIAL_DOCUMENT_LIMITS.blocks): value is CommercialId[] => list(value, maximum) && value.every(isCommercialId) && new Set(value).size === value.length;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Count JSON bytes incrementally, before allocating one giant JSON string.
 * The iterative active-path check permits shared values but rejects cycles. */
function sizeIssue(value: unknown): string | undefined {
  const encoder = new TextEncoder(), active = new Set<object>(); let total = 0;
  const stack: Array<{ value: unknown; exit?: boolean }> = [{ value }];
  while (stack.length) {
    const part = stack.pop()!;
    if (part.exit) { active.delete(part.value as object); continue; }
    if (part.value && typeof part.value === "object") {
      if (active.has(part.value)) return "Некорректная или циклическая структура документа.";
      active.add(part.value); stack.push({ value: part.value, exit: true });
      const entries = Array.isArray(part.value) ? part.value.map((child) => [undefined, child] as const) : Object.entries(part.value);
      total += 2 + Math.max(0, entries.length - 1);
      for (const [key, child] of entries) {
        if (key !== undefined) total += encoder.encode(JSON.stringify(key)).byteLength + 1;
        stack.push({ value: child });
      }
    } else {
      if (typeof part.value === "string" && part.value.length > COMMERCIAL_DOCUMENT_LIMITS.bytes) return "Документ превышает 8 МБ; ничего не усечено.";
      total += encoder.encode(JSON.stringify(part.value) ?? "null").byteLength;
    }
    if (total > COMMERCIAL_DOCUMENT_LIMITS.bytes) return "Документ превышает 8 МБ; ничего не усечено.";
  }
  return;
}

/** Canonical values, not insertion order. This is binding/invalidation, not an
 * authentication mechanism for a writable network folder. */
export function commercialCanonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => object(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry);
}
export async function commercialFingerprint(value: unknown): Promise<CommercialSha256> {
  const invalid = sizeIssue(value); if (invalid) throw new Error(invalid);
  const canonical = commercialCanonicalJson(value);
  if (typeof canonical !== "string") throw new Error("Для отпечатка нужно явное JSON-значение.");
  const encoded = new TextEncoder().encode(canonical);
  if (encoded.byteLength > COMMERCIAL_DOCUMENT_LIMITS.bytes) throw new Error("Документ превышает 8 МБ; ничего не усечено.");
  if (typeof globalThis.crypto?.subtle?.digest !== "function") throw new Error("Для привязки документа требуется SHA-256.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
/** Stable source-side dependency only. The decision ledger separately binds
 * applicable prices/related decisions and the exact changed output blocks. */
export async function commercialQuestionSourceFingerprint(appendix: CommercialPrivateAppendix, question: Pick<CommercialTermQuestion, "kind" | "sourceClauseIds" | "sourceReferenceIds">): Promise<CommercialSha256> {
  const clauses = question.sourceClauseIds.map((id) => appendix.clauses.find((clause) => clause.id === id));
  const references = question.sourceReferenceIds.map((id) => appendix.references.find((ref) => ref.id === id));
  if (clauses.some((clause) => !clause) || references.some((ref) => !ref)) throw new Error("Зависимые исходные условия вопроса не найдены.");
  return commercialFingerprint({ version: 1, kind: question.kind, sourceSnapshotKey: appendix.sourceSnapshotKey, clauses, references });
}

/** Closed AST validation, including forward/local targets. No HTML execution
 * or string replacement is part of validation. */
export function validateCommercialBody(value: unknown): CommercialIssue[] {
  const budget = sizeIssue(value); if (budget) return [{ code: "commercial-ast-budget", path: "body", message: budget, severity: "error" }];
  const issues: CommercialIssue[] = [], allIds = new Set<string>(), refs: Array<{ id: string; path: string }> = [];
  const error = (path: string, message: string) => issues.push({ code: "commercial-ast", path, message, severity: "error" });
  const ownId = (value: unknown, path: string) => { if (!isCommercialId(value) || allIds.has(value)) error(path, "Некорректный или повторный локальный идентификатор."); else allIds.add(value); };
  const inline = (value: unknown, path: string) => {
    if (!list(value, COMMERCIAL_DOCUMENT_LIMITS.items)) { error(path, "Слишком большой или некорректный текстовый элемент."); return; }
    for (const [index, part] of value.entries()) {
      const at = `${path}[${index}]`;
      if (!object(part)) error(at, "Разрешены только текст и локальная ссылка.");
      else if (part.kind === "text" && keys(part, ["kind", "text"]) && text(part.text)) { /* literal text only */ }
      else if (part.kind === "local-ref" && keys(part, ["kind", "targetId"]) && isCommercialId(part.targetId)) refs.push({ id: part.targetId, path: at });
      else error(at, "Недопустимый элемент текста; HTML и произвольные поля запрещены.");
    }
  };
  if (!object(value) || !keys(value, ["version", "sections"]) || value.version !== 1 || !list(value.sections, COMMERCIAL_DOCUMENT_LIMITS.sections)) return [{ code: "commercial-ast", path: "body", message: "Неподдерживаемая структура коммерческого документа.", severity: "error" }];
  let blockCount = 0;
  for (const [si, section] of value.sections.entries()) {
    const path = `body.sections[${si}]`;
    if (!object(section) || !keys(section, ["id", "kind", "title", "blocks"]) || !sectionKinds.includes(section.kind as CommercialSectionKind) || !text(section.title, true) || !list(section.blocks, COMMERCIAL_DOCUMENT_LIMITS.blocks)) { error(path, "Некорректный раздел документа."); continue; }
    ownId(section.id, `${path}.id`);
    for (const [bi, block] of section.blocks.entries()) {
      const at = `${path}.blocks[${bi}]`;
      if (++blockCount > COMMERCIAL_DOCUMENT_LIMITS.blocks) { error(at, "В документе более 2000 блоков; ничего не усечено."); break; }
      if (!object(block)) { error(at, "Некорректный блок."); continue; }
      ownId(block.id, `${at}.id`);
      if (block.kind === "paragraph" && keys(block, ["id", "kind", "style", "content"]) && ["body", "lead", "subheading", "caveat"].includes(String(block.style))) inline(block.content, `${at}.content`);
      else if (block.kind === "list" && keys(block, ["id", "kind", "style", "items"]) && ["bullet", "ordered"].includes(String(block.style)) && list(block.items, COMMERCIAL_DOCUMENT_LIMITS.items)) block.items.forEach((item, index) => inline(item, `${at}.items[${index}]`));
      else if (block.kind === "table" && keys(block, ["id", "kind", "columns", "rows"]) && list(block.columns, COMMERCIAL_DOCUMENT_LIMITS.columns) && block.columns.length > 0 && block.columns.every((column) => text(column, true)) && list(block.rows, COMMERCIAL_DOCUMENT_LIMITS.rows)) {
        for (const [ri, row] of block.rows.entries()) {
          if (!Array.isArray(row) || row.length !== block.columns.length) error(`${at}.rows[${ri}]`, "Ширина строки не совпадает с заголовками таблицы.");
          else row.forEach((cell, ci) => inline(cell, `${at}.rows[${ri}][${ci}]`));
        }
      } else error(at, "Разрешены только ограниченные абзацы, списки и таблицы.");
    }
  }
  for (const ref of refs) if (!allIds.has(ref.id)) issues.push({ code: "commercial-dangling-reference", path: ref.path, message: "Локальная ссылка не имеет цели в действующем документе.", severity: "error" });
  try { if (new TextEncoder().encode(commercialCanonicalJson(value)).byteLength > COMMERCIAL_DOCUMENT_LIMITS.bytes) error("body", "Документ превышает 8 МБ; ничего не усечено."); } catch { error("body", "Некорректная или циклическая структура документа."); }
  return issues;
}

/** Validates the persisted envelope. Decision meaning/freshness belongs to the
 * separate ledger; a well-formed stored decision never approves itself. */
export function validateCommercialDocument(value: unknown): CommercialIssue[] {
  const budget = sizeIssue(value); if (budget) return [{ code: "commercial-envelope-budget", path: "commercialDocument", message: budget, severity: "error" }];
  const issues: CommercialIssue[] = [], error = (path: string, message: string) => issues.push({ code: "commercial-envelope", path, message, severity: "error" });
  if (!object(value) || !keys(value, ["version", "revision", "body", "privateAppendix", "questions", "decisions"]) || value.version !== 1 || !integer(value.revision) || value.revision < 1) return [{ code: "commercial-envelope", path: "commercialDocument", message: "Неподдерживаемая версия документа.", severity: "error" }];
  issues.push(...validateCommercialBody(value.body));
  const appendix = value.privateAppendix;
  if (!object(appendix) || !keys(appendix, ["version", "sourceSnapshotKey", "documentId", "extraction", "containers", "clauses", "references", "coverage"]) || appendix.version !== 1 || !isCommercialSha256(appendix.sourceSnapshotKey) || !isCommercialId(appendix.documentId) || !list(appendix.containers, COMMERCIAL_DOCUMENT_LIMITS.sourceClauses) || !list(appendix.clauses, COMMERCIAL_DOCUMENT_LIMITS.sourceClauses) || !list(appendix.references, COMMERCIAL_DOCUMENT_LIMITS.references) || !list(appendix.coverage, COMMERCIAL_DOCUMENT_LIMITS.sourceClauses)) { error("privateAppendix", "Некорректное частное приложение источника."); return issues; }
  if (!object(appendix.extraction) || !keys(appendix.extraction, ["complete", "requiresOcr", "visualAssessment"]) || typeof appendix.extraction.complete !== "boolean" || typeof appendix.extraction.requiresOcr !== "boolean" || !["unassessed", "unresolved", "reviewed-by-user"].includes(String(appendix.extraction.visualAssessment))) error("privateAppendix.extraction", "Не указаны честные границы извлечения текста.");
  const containers = new Set<string>(), clauses = new Map<string, Record<string, unknown>>(), references = new Set<string>(), referenceOwners = new Map<string, string>(), blocks = new Set<string>(), localTargets = new Set<string>();
  if (object(value.body) && Array.isArray(value.body.sections)) for (const section of value.body.sections) if (object(section) && Array.isArray(section.blocks)) {
    if (typeof section.id === "string") localTargets.add(section.id);
    for (const block of section.blocks) if (object(block) && typeof block.id === "string") { blocks.add(block.id); localTargets.add(block.id); }
  }
  for (const [index, container] of appendix.containers.entries()) {
    if (!object(container) || !keys(container, ["id", "sourceId", "kind", "heading"], ["parentId"]) || !isCommercialId(container.id) || containers.has(container.id) || !isCommercialId(container.sourceId) || !["contract", "technical-task", "appendix", "unknown"].includes(String(container.kind)) || !text(container.heading) || container.parentId !== undefined && !isCommercialId(container.parentId)) error(`privateAppendix.containers[${index}]`, "Некорректный namespace исходного документа.");
    else containers.add(container.id);
  }
  for (const container of appendix.containers) if (object(container) && container.parentId !== undefined && (!containers.has(String(container.parentId)) || container.parentId === container.id)) error("privateAppendix.containers", "Родительский namespace не найден или циклический.");
  const parents = new Map(appendix.containers.flatMap((container) => object(container) && typeof container.id === "string" && typeof container.parentId === "string" ? [[container.id, container.parentId] as const] : []));
  const finished = new Set<string>();
  for (const start of containers) {
    const visited = new Set<string>(); let cursor: string | undefined = start;
    while (cursor !== undefined) {
      if (finished.has(cursor)) break;
      if (visited.has(cursor)) { error("privateAppendix.containers", "Обнаружен цикл родительских namespace."); break; }
      visited.add(cursor); cursor = parents.get(cursor);
    }
    for (const id of visited) finished.add(id);
  }
  const containerOwners = new Map(appendix.containers.flatMap((container) => object(container) ? [[container.id, container.sourceId] as const] : []));
  for (const container of appendix.containers) if (object(container) && container.parentId !== undefined && containerOwners.get(container.parentId) !== container.sourceId) error("privateAppendix.containers", "Родительский namespace принадлежит другому источнику.");
  const classifications: CommercialClauseClassification[] = ["commercial", "identity", "financial", "legal-context", "editorial", "structural", "unclassified", "excluded-material"];
  for (const [index, clause] of appendix.clauses.entries()) {
    if (!object(clause) || !keys(clause, ["id", "containerId", "sourceId", "sourceName", "locator", "quote", "quoteHash", "roles", "classification"], ["fragmentId", "printedLabel", "classificationReason"]) || !isCommercialId(clause.id) || clauses.has(clause.id) || !containers.has(String(clause.containerId)) || !isCommercialId(clause.sourceId) || !text(clause.sourceName) || !text(clause.locator) || !text(clause.quote) || !isCommercialSha256(clause.quoteHash) || !list(clause.roles, sectionKinds.length) || clause.roles.some((role) => !sectionKinds.includes(role as CommercialSectionKind)) || !classifications.includes(clause.classification as CommercialClauseClassification) || clause.fragmentId !== undefined && !isCommercialId(clause.fragmentId) || [clause.printedLabel, clause.classificationReason].some((part) => part !== undefined && !text(part))) error(`privateAppendix.clauses[${index}]`, "Некорректная или утраченная исходная цитата.");
    else if (containerOwners.get(clause.containerId) !== clause.sourceId) error(`privateAppendix.clauses[${index}].sourceId`, "Исходный пункт принадлежит другому namespace / источнику.");
    else clauses.set(clause.id, clause);
  }
  for (const [index, ref] of appendix.references.entries()) {
    const clause = object(ref) ? clauses.get(String(ref.sourceClauseId)) : undefined;
    if (!object(ref) || !keys(ref, ["id", "sourceClauseId", "span", "printed", "kind", "candidateClauseIds"], ["scopeHint", "labels", "localTargetIds"]) || !isCommercialId(ref.id) || references.has(ref.id) || !clause || !object(ref.span) || !keys(ref.span, ["startUtf16", "endUtf16"]) || !integer(ref.span.startUtf16) || !integer(ref.span.endUtf16) || ref.span.endUtf16 <= ref.span.startUtf16 || !text(ref.printed, true) || (clause.quote as string).slice(ref.span.startUtf16, ref.span.endUtf16) !== ref.printed || !["clause", "section", "document", "event"].includes(String(ref.kind)) || ref.scopeHint !== undefined && !["contract", "technical-task", "current-container"].includes(String(ref.scopeHint)) || ref.labels !== undefined && (!list(ref.labels, COMMERCIAL_DOCUMENT_LIMITS.items) || !ref.labels.every((label) => text(label, true))) || !ids(ref.candidateClauseIds) || ref.candidateClauseIds.some((id) => !clauses.has(id)) || ref.localTargetIds !== undefined && (!ids(ref.localTargetIds) || ref.localTargetIds.some((id) => !localTargets.has(id)))) error(`privateAppendix.references[${index}]`, "Ссылка не привязана к точному исходному фрагменту и существующим целям.");
    else { references.add(ref.id); referenceOwners.set(ref.id, String(ref.sourceClauseId)); }
  }
  const covered = new Set<string>();
  const validPresentation = (value: unknown, quote: string) => list(value, COMMERCIAL_DOCUMENT_LIMITS.items) && value.length > 0 && value.every((transform) => object(transform) && keys(transform, ["kind", "span"]) && transform.kind === "leading-label" && object(transform.span) && keys(transform.span, ["startUtf16", "endUtf16"]) && transform.span.startUtf16 === 0 && integer(transform.span.endUtf16) && transform.span.endUtf16 === /^\s*\d+(?:\.\d+)*[.)]\s+/u.exec(quote)?.[0].length);
  for (const [index, entry] of appendix.coverage.entries()) {
    const at = `privateAppendix.coverage[${index}]`;
    if (!object(entry) || !clauses.has(String(entry.sourceClauseId)) || covered.has(String(entry.sourceClauseId))) { error(at, "Неоднозначное покрытие исходного пункта."); continue; }
    covered.add(String(entry.sourceClauseId));
    const targets = () => ids(entry.targetBlockIds) && entry.targetBlockIds.length > 0 && entry.targetBlockIds.every((id) => blocks.has(id));
    if (entry.kind === "literal" && keys(entry, ["sourceClauseId", "kind", "targetBlockIds"]) && targets()) continue;
    if (entry.kind === "projected" && keys(entry, ["sourceClauseId", "kind", "targetBlockIds"], ["referenceIds", "presentation"]) && targets() && (entry.referenceIds === undefined || ids(entry.referenceIds, COMMERCIAL_DOCUMENT_LIMITS.references) && entry.referenceIds.every((id) => references.has(id))) && (entry.presentation === undefined || validPresentation(entry.presentation, clauses.get(String(entry.sourceClauseId))!.quote as string)) && (Array.isArray(entry.referenceIds) && entry.referenceIds.length > 0 || Array.isArray(entry.presentation) && entry.presentation.length > 0)) continue;
    if (entry.kind === "split" && keys(entry, ["sourceClauseId", "kind", "parts"], ["referenceIds"]) && list(entry.parts, COMMERCIAL_DOCUMENT_LIMITS.blocks) && entry.parts.length > 1) {
      const quote = clauses.get(String(entry.sourceClauseId))!.quote as string, spans: Array<{ startUtf16: number; endUtf16: number }> = [];
      const validSpans = (value: unknown) => list(value, COMMERCIAL_DOCUMENT_LIMITS.items) && value.length > 0 && value.every((span) => object(span) && keys(span, ["startUtf16", "endUtf16"]) && integer(span.startUtf16) && integer(span.endUtf16) && span.startUtf16 < span.endUtf16 && span.endUtf16 <= quote.length);
      const valid = entry.parts.every((part) => object(part) && keys(part, ["targetBlockId", "purpose", "spans"], ["contextSpans", "supersededByDecisionId", "presentation"]) && blocks.has(String(part.targetBlockId)) && ["source-text", "advance-base", "advance-days", "stage-plan", "stage-parallelism", "boundary-protocol", "source-reference"].includes(String(part.purpose)) && validSpans(part.spans) && (part.contextSpans === undefined || validSpans(part.contextSpans)) && (part.presentation === undefined || validPresentation(part.presentation, quote)) && (part.supersededByDecisionId === undefined || isCommercialId(part.supersededByDecisionId)));
      if (valid) {
        for (const part of entry.parts) spans.push(...(part as unknown as CommercialProjectionPart).spans);
        spans.sort((a, b) => a.startUtf16 - b.startUtf16); let end = 0;
        for (const span of spans) { if (span.startUtf16 > end) break; end = Math.max(end, span.endUtf16); }
        if (end === quote.length && (entry.referenceIds === undefined || ids(entry.referenceIds, COMMERCIAL_DOCUMENT_LIMITS.references) && entry.referenceIds.every((id) => references.has(id)))) continue;
      }
    }
    if (entry.kind === "deduplicated" && keys(entry, ["sourceClauseId", "kind", "canonicalClauseId", "targetBlockIds"]) && clauses.has(String(entry.canonicalClauseId)) && entry.canonicalClauseId !== entry.sourceClauseId && targets()) continue;
    if (entry.kind === "external-field" && keys(entry, ["sourceClauseId", "kind", "field"]) && ["parties", "pricing"].includes(String(entry.field))) continue;
    if (["private-context", "unmapped"].includes(String(entry.kind)) && keys(entry, ["sourceClauseId", "kind", "reason"]) && text(entry.reason, true)) continue;
    if (entry.kind === "superseded-by-decision" && keys(entry, ["sourceClauseId", "kind", "decisionId"]) && isCommercialId(entry.decisionId)) continue;
    error(at, "Некорректная запись покрытия.");
  }
  if (covered.size !== clauses.size) error("privateAppendix.coverage", "Каждый исходный пункт должен иметь явное покрытие или классификацию; пункты не удаляются.");
  if (!list(value.questions, COMMERCIAL_DOCUMENT_LIMITS.questions)) error("questions", "Некорректный список вопросов.");
  else {
    const seen = new Set<string>(), sections = object(value.body) && Array.isArray(value.body.sections) ? value.body.sections.flatMap((section) => object(section) ? [section.id] : []) : [];
    for (const [index, question] of value.questions.entries()) {
      if (!object(question) || !keys(question, ["id", "kind", "sectionId", "targetBlockIds", "sourceClauseIds", "sourceReferenceIds", "message", "material", "dependencyFingerprint"]) || !isCommercialId(question.id) || seen.has(question.id) || !["advance-base", "advance-days", "stage-plan", "stage-parallelism", "boundary-protocol", "source-reference"].includes(String(question.kind)) || !sections.includes(question.sectionId) || !ids(question.targetBlockIds) || question.targetBlockIds.some((id) => !blocks.has(id)) || !ids(question.sourceClauseIds, COMMERCIAL_DOCUMENT_LIMITS.sourceClauses) || question.sourceClauseIds.some((id) => !clauses.has(id)) || !ids(question.sourceReferenceIds, COMMERCIAL_DOCUMENT_LIMITS.references) || question.sourceReferenceIds.some((id) => !references.has(id)) || !text(question.message, true) || typeof question.material !== "boolean" || !isCommercialSha256(question.dependencyFingerprint)) error(`questions[${index}]`, "Вопрос не связан с точными условиями документа.");
      else seen.add(question.id);
    }
  }
  // The ledger validates the discriminated answer and its current dependency
  // binding. Reject unknown envelope fields here without claiming an approval.
  if (!list(value.decisions, COMMERCIAL_DOCUMENT_LIMITS.decisions)) error("decisions", "Некорректный журнал решений.");
  else for (const [index, decision] of value.decisions.entries()) {
    if (!object(decision) || !keys(decision, ["version", "id", "questionId", "answer", "origin", "appliedAt", "sourceSnapshotKey", "dependencyFingerprint", "sourceClauseIds", "changedBlockIds", "beforeFingerprint", "afterFingerprint"], ["supersedesDecisionId", "sourceCoverageBefore"]) || decision.version !== 1 || !isCommercialId(decision.id) || !isCommercialId(decision.questionId) || !object(decision.answer) || decision.origin !== "user" || !text(decision.appliedAt, true) || !isCommercialSha256(decision.sourceSnapshotKey) || !isCommercialSha256(decision.dependencyFingerprint) || !isCommercialSha256(decision.beforeFingerprint) || !isCommercialSha256(decision.afterFingerprint) || !ids(decision.sourceClauseIds, COMMERCIAL_DOCUMENT_LIMITS.sourceClauses) || !ids(decision.changedBlockIds) || decision.supersedesDecisionId !== undefined && !isCommercialId(decision.supersedesDecisionId)) { error(`decisions[${index}]`, "Некорректный журнал пользовательского решения."); continue; }
    if (decision.sourceCoverageBefore !== undefined) {
      const snapshots = decision.sourceCoverageBefore, seen = new Set<string>();
      if (!list(snapshots, COMMERCIAL_DOCUMENT_LIMITS.sourceClauses) || !snapshots.length) { error(`decisions[${index}].sourceCoverageBefore`, "Нужны ограниченные исходные записи покрытия для повтора проверки."); continue; }
      for (const [si, receipt] of snapshots.entries()) {
        const path = `decisions[${index}].sourceCoverageBefore[${si}]`;
        if (!object(receipt) || !isCommercialId(receipt.sourceClauseId) || seen.has(receipt.sourceClauseId) || !decision.sourceClauseIds.includes(receipt.sourceClauseId) || !clauses.has(receipt.sourceClauseId)) { error(path, "Исходная запись покрытия не принадлежит условиям этого решения."); continue; }
        seen.add(receipt.sourceClauseId);
        const quote = clauses.get(receipt.sourceClauseId)!.quote as string;
        const targetIds = () => ids(receipt.targetBlockIds) && receipt.targetBlockIds.length > 0 && receipt.targetBlockIds.every((id) => blocks.has(id));
        const sourceRefs = (value: unknown) => ids(value, COMMERCIAL_DOCUMENT_LIMITS.references) && value.every((id) => referenceOwners.get(id) === receipt.sourceClauseId);
        const boundedSpans = (value: unknown) => list(value, COMMERCIAL_DOCUMENT_LIMITS.items) && value.length > 0 && value.every((span) => object(span) && keys(span, ["startUtf16", "endUtf16"]) && integer(span.startUtf16) && integer(span.endUtf16) && span.startUtf16 < span.endUtf16 && span.endUtf16 <= quote.length);
        if (receipt.kind === "literal" && keys(receipt, ["sourceClauseId", "kind", "targetBlockIds"]) && targetIds()) continue;
        if (receipt.kind === "projected" && keys(receipt, ["sourceClauseId", "kind", "targetBlockIds"], ["referenceIds", "presentation"]) && targetIds() && (receipt.referenceIds === undefined || sourceRefs(receipt.referenceIds)) && (receipt.presentation === undefined || validPresentation(receipt.presentation, quote)) && (Array.isArray(receipt.referenceIds) && receipt.referenceIds.length > 0 || Array.isArray(receipt.presentation) && receipt.presentation.length > 0)) continue;
        if (receipt.kind === "deduplicated" && keys(receipt, ["sourceClauseId", "kind", "canonicalClauseId", "targetBlockIds"]) && targetIds()) {
          const canonical = clauses.get(String(receipt.canonicalClauseId)), original = clauses.get(receipt.sourceClauseId)!;
          if (canonical && canonical.id !== original.id && canonical.containerId === original.containerId && canonical.quote === original.quote) continue;
        }
        if (receipt.kind === "split" && keys(receipt, ["sourceClauseId", "kind", "parts"], ["referenceIds"]) && list(receipt.parts, COMMERCIAL_DOCUMENT_LIMITS.blocks) && receipt.parts.length > 1 && (receipt.referenceIds === undefined || sourceRefs(receipt.referenceIds))) {
          const spans: Array<{ startUtf16: number; endUtf16: number }> = [];
          const valid = receipt.parts.every((part) => object(part) && keys(part, ["targetBlockId", "purpose", "spans"], ["contextSpans", "presentation"]) && blocks.has(String(part.targetBlockId)) && ["source-text", "advance-base", "advance-days", "stage-plan", "stage-parallelism", "boundary-protocol", "source-reference"].includes(String(part.purpose)) && boundedSpans(part.spans) && (part.contextSpans === undefined || boundedSpans(part.contextSpans)) && (part.presentation === undefined || validPresentation(part.presentation, quote)));
          if (valid) {
            for (const part of receipt.parts) spans.push(...(part as unknown as CommercialProjectionPart).spans);
            spans.sort((a, b) => a.startUtf16 - b.startUtf16); let end = 0;
            for (const span of spans) { if (span.startUtf16 > end) break; end = Math.max(end, span.endUtf16); }
            if (end === quote.length) continue;
          }
        }
        if (receipt.kind === "external-field" && keys(receipt, ["sourceClauseId", "kind", "field"]) && ["parties", "pricing"].includes(String(receipt.field))) continue;
        if (["private-context", "unmapped"].includes(String(receipt.kind)) && keys(receipt, ["sourceClauseId", "kind", "reason"]) && text(receipt.reason, true)) continue;
        error(path, "Нужна чистая привязанная исходная схема покрытия без superseded markers; запись не является подтверждением условий.");
      }
    }
  }
  const decisionIds = new Set(Array.isArray(value.decisions) ? value.decisions.flatMap((decision) => object(decision) && isCommercialId(decision.id) ? [decision.id] : []) : []);
  if (Array.isArray(value.decisions) && decisionIds.size !== value.decisions.length) error("decisions", "Идентификаторы решений должны быть корректными и уникальными.");
  for (const entry of appendix.coverage) if (object(entry)) {
    if (entry.kind === "superseded-by-decision" && !decisionIds.has(String(entry.decisionId))) error("privateAppendix.coverage", "Изменившее условие решение отсутствует в журнале.");
    if (entry.kind === "split" && Array.isArray(entry.parts)) for (const part of entry.parts) if (object(part) && part.supersededByDecisionId !== undefined && !decisionIds.has(String(part.supersededByDecisionId))) error("privateAppendix.coverage", "Решение для части условия отсутствует в журнале.");
  }
  try { if (new TextEncoder().encode(commercialCanonicalJson(value)).byteLength > COMMERCIAL_DOCUMENT_LIMITS.bytes) error("commercialDocument", "Документ превышает 8 МБ; ничего не усечено."); } catch { error("commercialDocument", "Некорректная или циклическая структура документа."); }
  return issues;
}

/** Immutable quote consistency, independently of model claims or decisions. */
export async function validateCommercialQuoteHashes(document: ProposalCommercialDocumentV1): Promise<CommercialIssue[]> {
  const issues = validateCommercialDocument(document);
  if (issues.some((issue) => issue.severity === "error")) return issues;
  const hashes = await Promise.all(document.privateAppendix.clauses.map((clause) => commercialFingerprint(clause.quote)));
  hashes.forEach((hash, index) => { if (hash !== document.privateAppendix.clauses[index].quoteHash) issues.push({ code: "commercial-quote-hash", path: `privateAppendix.clauses[${index}].quoteHash`, message: "Исходная цитата изменилась; прежнее доказательство не применяется.", severity: "error" }); });
  return issues;
}
