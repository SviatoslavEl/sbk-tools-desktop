import {
  COMMERCIAL_DOCUMENT_LIMITS, commercialCanonicalJson, commercialFingerprint, commercialQuestionSourceFingerprint,
  isCommercialId, isCommercialSha256, validateCommercialDocument, validateCommercialQuoteHashes,
  type CommercialAgreedStage, type CommercialAppliedTermDecision, type CommercialBlock, type CommercialClauseCoverage, type CommercialInline,
  type CommercialIssue, type CommercialSha256, type CommercialTermAnswer, type CommercialTermQuestion,
  type ProposalCommercialDocumentV1,
} from "./commercialDocument";
import { collectCommercialStageCatalog, isCommercialStructuralHeading, validateCommercialSourceProjection } from "./commercialPreparation";
import { formatMoneyMinor, MAX_MONEY_MINOR, priceProposal } from "./pricing";
import type { ProposalData } from "./types";

/** Only applicable financial inputs, not contacts, UI state, model output or
 * a generic approval flag. Missing external party/price proofs remain review. */
export interface CommercialDecisionContext { pricing?: Readonly<Pick<ProposalData, "lines" | "currency">> }
export interface CommercialQuestionState {
  question: CommercialTermQuestion;
  sourceCurrent: boolean;
  dependencyFingerprint: CommercialSha256;
  status: "unresolved" | "resolved" | "stale" | "blocked";
  activeDecision?: CommercialAppliedTermDecision;
  issues: CommercialIssue[];
}
export interface CommercialAnswerValidation {
  valid: boolean; issues: CommercialIssue[]; dependencyFingerprint: CommercialSha256; previewBlocks: CommercialBlock[];
}
export interface CommercialApplyCommand {
  questionId: string; answer: CommercialTermAnswer; expectedRevision: number; expectedDependencyFingerprint: CommercialSha256;
  decisionId: string; appliedAt: string;
}
export interface CommercialApplyResult {
  document: ProposalCommercialDocumentV1; decision: CommercialAppliedTermDecision; changedBlockIds: string[];
  invalidatedDecisionIds: string[]; issues: CommercialIssue[];
}
export interface CommercialReadiness {
  canSaveDraft: boolean; canFinalize: boolean; issues: CommercialIssue[]; questions: CommercialQuestionState[];
  activeDecisionIds: string[]; staleDecisionIds: string[];
}
export class CommercialDecisionError extends Error {
  constructor(public readonly code: string, message: string, public readonly issues: readonly CommercialIssue[] = []) { super(message); this.name = "CommercialDecisionError"; }
}
const issue = (code: string, message: string, path = "commercialDocument", severity: CommercialIssue["severity"] = "error"): CommercialIssue => ({ code, message, path, severity });
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
const exact = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).length === fields.length && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
const requiredText = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= COMMERCIAL_DOCUMENT_LIMITS.element && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) && !/^(?:неизвестно|не\s+указано|уточнить|да|нет|n\/a|tbd)$/iu.test(value.trim());
const dayKind = (value: unknown) => value === "calendar" || value === "business";
const count = (value: unknown): value is string => typeof value === "string" && /^[1-9]\d{0,4}$/u.test(value);
const ids = (value: unknown, empty = false): value is string[] => Array.isArray(value) && (empty || value.length > 0) && value.length <= COMMERCIAL_DOCUMENT_LIMITS.blocks && value.every(isCommercialId) && new Set(value).size === value.length;
const allBlocks = (doc: ProposalCommercialDocumentV1) => doc.body.sections.flatMap((section) => section.blocks);
const paragraph = (id: string, text: string): CommercialBlock => ({ id, kind: "paragraph", style: "body", content: [{ kind: "text", text }] });
const durationText = (duration: { count: string; dayKind: "calendar" | "business" }) => `${duration.count} ${duration.dayKind === "business" ? "рабочих" : "календарных"} дней`;
/** This bounded editor represents an explicit positive milestone declaration,
 * not natural-language certification. Unknown wording (including future,
 * quoted, conditional or mixed positive/negative prose) stays unresolved. */
function supportedPermissionCondition(value: string): boolean {
  const scope = "(?:\\s+(?:работ|проверки|тестирования|оказания\\s+услуг))?";
  const boundary = `(?:границы${scope}\\s+(?:согласованы|утверждены|подписаны)|периметр${scope}\\s+(?:согласован|утвержд[её]н))`;
  const permit = "(?:письменное\\s+)?разрешение(?:\\s+на\\s+(?:проведение\\s+)?(?:работ|тестирования|проверки))?\\s+(?:получено|выдано|подписано)";
  const separator = "\\s*(?:[,;.]|\\s+и\\s+)\\s*";
  return new RegExp(`^\\s*(?:${boundary}${separator}${permit}|${permit}${separator}${boundary})\\s*[.!]?\\s*$`, "iu").test(value);
}
/** The two answer switches may replace only this CLOSED amount/base/tax form.
 * Unknown setoff/refund/other qualifiers are not erased by a growing denylist. */
function supportedAdvanceBase(value: string): string | undefined {
  const prefix = "(?:(?:Заказчик|Покупатель)\\s+)?(?:(?:оплачивает|уплачивает|перечисляет|вносит)\\s+)?(?:(?:Исполнителю|Поставщику|Подрядчику)\\s+)?(?:аванс|предоплат[ау]|авансовый\\s+плат[её]ж)(?:\\s+в\\s+размере)?\\s+";
  const percent = "(\\d{1,3}(?:[,.]\\d{1,2})?)\\s*(?:\\(([\\p{L}\\s-]+)\\)\\s*)?(?:%|процент(?:а|ов)?)";
  const pointer = "(?:(?:,\\s*указанн(?:ой|ого|ым)\\s+в\\s+|\\s+)(?:п\\.|пункт(?:а|е|ом)?)\\s*\\d+(?:\\.\\d+)*(?:\\s+(?:(?:настоящего|этого)\\s+)?(?:Договора|Контракта))?)?";
  const basis = `(?:\\s+от\\s+(?:суммы|стоимости|цены)(?:\\s+(?:услуг|предложения|договора|контракта))?${pointer})?`;
  const vat = "(?:(?:\\s*,\\s*|\\s+)(?:кроме\\s+того|в\\s+том\\s+числе|включая)\\s+(?:НДС|налог\\s+на\\s+добавленную\\s+стоимость)(?:\\s+по\\s+установленной\\s+законодательством\\s+(?:Российской\\s+Федерации|РФ)\\s+ставке|\\s+\\d+(?:[,.]\\d+)?\\s*%)?)?";
  const match = new RegExp(`^${prefix}${percent}${basis}${vat}\\s*[,;.]?\\s*$`, "iu").exec(value.trim().replace(/^\d+(?:\.\d+)*[.)]\s*/u, ""));
  if (!match) return;
  if (match[2]) {
    const words: Record<string, number> = { один: 1, одного: 1, одна: 1, одной: 1, два: 2, двух: 2, три: 3, трех: 3, четыре: 4, четырех: 4, пять: 5, пяти: 5, шесть: 6, шести: 6, семь: 7, семи: 7, восемь: 8, восьми: 8, девять: 9, девяти: 9, десять: 10, десяти: 10, одиннадцать: 11, одиннадцати: 11, двенадцать: 12, двенадцати: 12, тринадцать: 13, тринадцати: 13, четырнадцать: 14, четырнадцати: 14, пятнадцать: 15, пятнадцати: 15, шестнадцать: 16, шестнадцати: 16, семнадцать: 17, семнадцати: 17, восемнадцать: 18, восемнадцати: 18, девятнадцать: 19, девятнадцати: 19, двадцать: 20, двадцати: 20, тридцать: 30, тридцати: 30, сорок: 40, сорока: 40, пятьдесят: 50, пятидесяти: 50, шестьдесят: 60, шестидесяти: 60, семьдесят: 70, семидесяти: 70, восемьдесят: 80, восьмидесяти: 80, девяносто: 90, девяноста: 90, сто: 100, ста: 100 };
    const parts = match[2].trim().toLocaleLowerCase("ru").replace(/ё/gu, "е").split(/\s+/u).map((word) => words[word]);
    if (!parts.length || parts.length > 2 || parts.some((part) => part === undefined) || parts.length === 2 && (parts[0] < 20 || parts[0] % 10 !== 0 || parts[1] > 9) || parts.reduce((sum, part) => sum + part, 0) !== Number(match[1].replace(",", "."))) return;
  }
  return match[1].replace(",", ".");
}
const intersect = (a: readonly string[], b: readonly string[]) => a.some((id) => b.includes(id));
const uniqueIssues = (issues: CommercialIssue[]) => issues.filter((part, index) => issues.findIndex((other) => commercialCanonicalJson(other) === commercialCanonicalJson(part)) === index);
const targets = (doc: ProposalCommercialDocumentV1, question: CommercialTermQuestion) => question.targetBlockIds.map((id) => allBlocks(doc).find((block) => block.id === id)!).filter(Boolean);
const latestDecision = (doc: ProposalCommercialDocumentV1, question: CommercialTermQuestion) => [...doc.decisions].reverse().find((decision) => decision.questionId === question.id);
const questionFor = (doc: ProposalCommercialDocumentV1, id: string) => {
  const question = doc.questions.find((entry) => entry.id === id);
  if (!question) throw new CommercialDecisionError("commercial-question-missing", "Вопрос не найден в текущей редакции документа.");
  return question;
};

/** Closed discriminated union. Unknown keys, partial fifth stages and blanket
 * booleans never become user answers merely because JSON is syntactically valid. */
function answerShape(answer: unknown, question: CommercialTermQuestion): CommercialIssue[] {
  const fail = () => [issue("commercial-answer-shape", "Заполните все поля конкретного решения без неизвестных свойств.", `questions.${question.id}`)];
  if (!object(answer) || answer.kind !== question.kind) return fail();
  switch (answer.kind) {
    case "advance-base": return exact(answer, ["kind", "base", "vatTreatment"]) && ["net", "gross"].includes(String(answer.base)) && ["included", "additional"].includes(String(answer.vatTreatment)) ? [] : fail();
    case "advance-days": return exact(answer, ["kind", "dayKind"]) && dayKind(answer.dayKind) ? [] : fail();
    case "stage-plan": {
      if (!exact(answer, ["kind", "stages", "maximum"]) || !Array.isArray(answer.stages) || !answer.stages.length || answer.stages.length > 100 || !object(answer.maximum) || !exact(answer.maximum, ["count", "dayKind"]) || !count(answer.maximum.count) || !dayKind(answer.maximum.dayKind)) return fail();
      const seen = new Set<string>();
      for (const stage of answer.stages) {
        if (!object(stage) || !exact(stage, ["id", "title", "scope", "result", "duration"]) || !isCommercialId(stage.id) || seen.has(stage.id) || ![stage.title, stage.scope, stage.result].every(requiredText) || !object(stage.duration) || !exact(stage.duration, ["count", "dayKind"]) || !count(stage.duration.count) || !dayKind(stage.duration.dayKind)) return fail();
        seen.add(stage.id);
      }
      return [];
    }
    case "stage-parallelism": {
      if (!exact(answer, ["kind", "relations"]) || !Array.isArray(answer.relations) || answer.relations.length > 1000) return fail();
      for (const relation of answer.relations) {
        if (!object(relation) || relation.kind === "after" && (!exact(relation, ["kind", "stageId", "afterStageId"]) || !isCommercialId(relation.stageId) || !isCommercialId(relation.afterStageId))
          || relation.kind === "may-overlap" && (!exact(relation, ["kind", "stageIds", "conditions"]) || !ids(relation.stageIds) || relation.stageIds.length < 2 || !requiredText(relation.conditions)) || !["after", "may-overlap"].includes(String(relation.kind))) return fail();
      }
      return [];
    }
    case "boundary-protocol": {
      if (!exact(answer, ["kind", "milestones"]) || !Array.isArray(answer.milestones) || !answer.milestones.length || answer.milestones.length > 100) return fail();
      for (const milestone of answer.milestones) if (!object(milestone) || !exact(milestone, ["title", "condition", "beforeStageIds", "afterStageIds"]) || !requiredText(milestone.title) || !requiredText(milestone.condition) || !ids(milestone.beforeStageIds, true) || !ids(milestone.afterStageIds, true) || !milestone.beforeStageIds.length && !milestone.afterStageIds.length) return fail();
      return [];
    }
    case "source-reference": {
      if (!exact(answer, ["kind", "referenceIds", "resolution"]) || !ids(answer.referenceIds) || !object(answer.resolution)) return fail();
      const resolution = answer.resolution;
      if (resolution.kind === "body-target" && exact(resolution, ["kind", "targetIds"]) && ids(resolution.targetIds)) return [];
      if (resolution.kind === "governing-document" && exact(resolution, ["kind", "definitionTitle", "definitionText"]) && requiredText(resolution.definitionTitle) && requiredText(resolution.definitionText) && resolution.definitionText.trim().length >= 20) return [];
      if (resolution.kind === "replace-clauses" && exact(resolution, ["kind", "replacements"]) && Array.isArray(resolution.replacements) && resolution.replacements.length > 0 && resolution.replacements.length <= 100 && resolution.replacements.every((replacement) => object(replacement) && exact(replacement, ["blockId", "publicText"]) && isCommercialId(replacement.blockId) && requiredText(replacement.publicText)) && new Set(resolution.replacements.map((replacement) => (replacement as { blockId: string }).blockId)).size === resolution.replacements.length) return [];
      return fail();
    }
    default: return fail();
  }
}

function sourceTemplate(doc: ProposalCommercialDocumentV1, question: CommercialTermQuestion, blockId: string): string | undefined {
  const entries = initialCoverage(doc).flatMap((coverage) => {
    if (!coverage) return [];
    const clause = doc.privateAppendix.clauses.find((entry) => entry.id === coverage.sourceClauseId)!;
    if (coverage.kind === "split") return coverage.parts.filter((part) => part.targetBlockId === blockId && part.purpose === question.kind).map((part) => {
      const prefix = part.presentation?.[0]?.span.endUtf16 || 0;
      return `${(part.contextSpans || []).map((span) => clause.quote.slice(span.startUtf16, span.endUtf16)).join("")}${part.contextSpans?.length ? "\n" : ""}${part.spans.map((span) => clause.quote.slice(Math.max(prefix, span.startUtf16), span.endUtf16)).join("")}`;
    });
    if ((coverage.kind === "literal" || coverage.kind === "projected" || coverage.kind === "deduplicated") && question.sourceClauseIds.includes(clause.id)) {
      if (coverage.targetBlockIds.includes(blockId)) return [clause.quote.replace(/^\s*\d+(?:\.\d+)*[.)]\s+/u, "")];
    }
    return [];
  });
  const unique = [...new Set(entries)]; return unique.length === 1 ? unique[0] : undefined;
}
/** Restore original projection metadata, never a previous user answer. The
 * source snapshot, quote spans and validator independently bound this receipt. */
function initialCoverage(doc: ProposalCommercialDocumentV1): Array<CommercialClauseCoverage | undefined> {
  return doc.privateAppendix.coverage.map((coverage) => {
    if (coverage.kind === "superseded-by-decision") {
      const original = doc.decisions.find((decision) => decision.id === coverage.decisionId)?.sourceCoverageBefore?.find((entry) => entry.sourceClauseId === coverage.sourceClauseId);
      return original && original.kind !== "superseded-by-decision" ? original : undefined;
    }
    if (coverage.kind === "split") return { ...coverage, parts: coverage.parts.map(({ supersededByDecisionId: _removed, ...part }) => part) };
    return coverage;
  });
}
function sourceProjectionFor(doc: ProposalCommercialDocumentV1, question: CommercialTermQuestion): CommercialClauseCoverage[] {
  return initialCoverage(doc).filter((coverage): coverage is CommercialClauseCoverage => Boolean(coverage && (coverage.kind === "split" ? coverage.parts.some((part) => question.targetBlockIds.includes(part.targetBlockId)) : (coverage.kind === "literal" || coverage.kind === "projected" || coverage.kind === "deduplicated") && intersect(coverage.targetBlockIds, question.targetBlockIds))));
}
const decisionSourceIds = (doc: ProposalCommercialDocumentV1, question: CommercialTermQuestion) => [...new Set([...question.sourceClauseIds, ...sourceProjectionFor(doc, question).map((entry) => entry.sourceClauseId)])];
function sourceMaximums(doc: ProposalCommercialDocumentV1) {
  return doc.privateAppendix.clauses.filter((clause) => clause.roles.includes("schedule")).flatMap((clause) => {
    const match = /(?:общий\s+)?максимальн[\p{L}]*\s+срок[^\d]{0,70}(\d+)\s*(?:\([^)]{1,80}\)\s*)?(рабоч[\p{L}]*|календарн[\p{L}]*)\s+дн/iu.exec(clause.quote);
    return match ? [{ clause, count: match[1], dayKind: /^рабоч/iu.test(match[2]) ? "business" as const : "calendar" as const }] : [];
  });
}
/** Only explicit source stage IDs/printed labels establish predecessors. Split
 * parallel-rule spans are removed exactly; unrelated source conditions stay. */
function sourceStageRules(doc: ProposalCommercialDocumentV1, chosen: CommercialAgreedStage[]) {
  const catalog = collectCommercialStageCatalog(doc), issues: CommercialIssue[] = [...catalog.issues], durations = new Map<string, string>(), edges = new Map<string, Set<string>>(), coverage = initialCoverage(doc);
  for (const source of catalog.stages) {
    const clause = doc.privateAppendix.clauses.find((entry) => entry.id === source.sourceClauseId)!, selected = chosen.find((entry) => entry.id === source.id);
    let value = source.durationText, start = clause.quote.indexOf(value);
    const projection = coverage.find((entry) => entry?.sourceClauseId === source.id);
    const excluded = projection?.kind === "split" ? projection.parts.filter((part) => part.purpose === "stage-parallelism").flatMap((part) => part.spans) : [];
    if (excluded.length) {
      if (start < 0 || clause.quote.lastIndexOf(value) !== start || excluded.some((span) => span.startUtf16 < start || span.endUtf16 > start + value.length)) { issues.push(issue("commercial-stage-duration-layout", "Отдельное правило параллельности не сопоставлено с единственной ячейкой срока; план не восстановлен догадкой.")); continue; }
      for (const span of [...excluded].sort((a, b) => b.startUtf16 - a.startUtf16)) value = value.slice(0, span.startUtf16 - start) + value.slice(span.endUtf16 - start);
      value = value.trim();
    }
    const primary = /^\s*\d+\s*(?:\([^)]{1,80}\)\s*)?(?:рабоч[\p{L}]*|календарн[\p{L}]*)\s+дн[\p{L}]*/iu.exec(value), qualifier = primary ? value.slice(primary[0].length).trim().replace(/^[,;\s]+|[,;.\s]+$/gu, "") : value.trim();
    if (!qualifier) continue;
    if (/параллельн/iu.test(qualifier)) { issues.push(issue("commercial-stage-parallel-unpartitioned", "Параллельность не выделена в отдельный исходный блок. Она не возвращена в таблицу плана и не заменена автоматически.")); continue; }
    if (!selected || !source.duration || selected.duration.count !== source.duration.count || selected.duration.dayKind !== source.duration.dayKind) { issues.push(issue("commercial-stage-trigger-unrepresentable", "У исходного срока этапа есть самостоятельное условие начала / завершения. Сохраните его stage ID и длительность либо вынесите условие в отдельное предметное решение; оно не удалено автоматически.")); continue; }
    durations.set(source.id, value);
    const trigger = /(?:с\s+момента\s+завершения|после\s+завершения)\s+этап(?:ов|а)?\s+(\d+(?:\s*[–—-]\s*\d+)?(?:\s*(?:,|и)\s*\d+(?:\s*[–—-]\s*\d+)?)*)/iu.exec(qualifier);
    if (!trigger) { issues.push(issue("commercial-stage-trigger-unassessed", "Исходное условие срока сохранено дословно, но его связь с новым планом не разобрана в этом режиме; требуется предметное рассмотрение.", `privateAppendix.clauses.${source.id}`, "review")); continue; }
    const labels: string[] = [];
    for (const group of trigger[1].matchAll(/\d+(?:\s*[–—-]\s*\d+)?/gu)) {
      const ends = group[0].split(/\s*[–—-]\s*/u).map(Number);
      if (ends.length === 1) labels.push(String(ends[0]));
      else if (ends[1] >= ends[0] && ends[1] - ends[0] < 100) for (let label = ends[0]; label <= ends[1]; label++) labels.push(String(label));
      else issues.push(issue("commercial-stage-trigger-range", "Диапазон исходных предшественников не установлен однозначно."));
    }
    for (const label of new Set(labels)) {
      const predecessors = catalog.stages.filter((entry) => entry.printedNumber === label), predecessor = predecessors.length === 1 ? predecessors[0] : undefined;
      const agreed = predecessor && chosen.find((entry) => entry.id === predecessor.id);
      if (!predecessor || !agreed || !new RegExp(`^\\s*(?:Этап|Стадия)\\s+${label}(?:[.\\s]|$)`, "iu").test(agreed.title)) issues.push(issue("commercial-stage-trigger-owner", "Исходный предшественник утрачен / переименован без представимой связи. Нельзя переносить условие по порядку строк."));
      else addEdge(edges, agreed.id, selected.id);
    }
    if (qualifier.replace(trigger[0], "").trim()) issues.push(issue("commercial-stage-trigger-unassessed", "Дополнительная часть исходного условия срока сохранена и требует отдельного рассмотрения.", `privateAppendix.clauses.${source.id}`, "review"));
  }
  return { issues, durations, edges };
}
function cycle(edges: Map<string, Set<string>>): boolean {
  const active = new Set<string>(), done = new Set<string>();
  const visit = (id: string): boolean => { if (active.has(id)) return true; if (done.has(id)) return false; active.add(id); for (const next of edges.get(id) || []) if (visit(next)) return true; active.delete(id); done.add(id); return false; };
  return [...edges.keys()].some(visit);
}
const addEdge = (edges: Map<string, Set<string>>, from: string, to: string) => { const next = edges.get(from) || new Set<string>(); next.add(to); edges.set(from, next); };
function targetIssues(doc: ProposalCommercialDocumentV1, question: CommercialTermQuestion): CommercialIssue[] {
  const issues: CommercialIssue[] = [];
  if (!question.targetBlockIds.length || targets(doc, question).length !== question.targetBlockIds.length) issues.push(issue("commercial-target-missing", "Для решения нет полного набора собственных блоков.", `questions.${question.id}`));
  // An unsupported numeric-reference question must not deadlock its upstream
  // amount/plan answer. Only that overlapping reference Apply is blocked;
  // ordinary term questions still cannot rewrite one another's blocks.
  const overlap = doc.questions.filter((other) => other.id !== question.id && intersect(other.targetBlockIds, question.targetBlockIds) && !(question.kind !== "source-reference" && other.kind === "source-reference"));
  if (overlap.length) issues.push(issue("commercial-decision-target-overlap", `Решение пересекает блоки других вопросов: ${overlap.map((entry) => entry.id).join(", ")}. Сначала разделите условия; применение не выполнено.`, `questions.${question.id}`));
  return issues;
}

type Evaluation = { states: Map<string, CommercialQuestionState>; issues: CommercialIssue[] };
function dependencyQuestions(doc: ProposalCommercialDocumentV1, question: CommercialTermQuestion, answer?: CommercialTermAnswer): CommercialTermQuestion[] {
  if (question.kind === "stage-parallelism") return doc.questions.filter((entry) => entry.kind === "stage-plan");
  if (question.kind === "boundary-protocol") return doc.questions.filter((entry) => ["stage-plan", "stage-parallelism"].includes(entry.kind));
  if (question.kind !== "source-reference") return [];
  const refs = doc.privateAppendix.references.filter((ref) => question.sourceReferenceIds.includes(ref.id));
  const sourceIds = [...question.sourceClauseIds, ...refs.flatMap((ref) => ref.candidateClauseIds)];
  const selected = answer?.kind === "source-reference" && answer.resolution.kind === "body-target" ? answer.resolution.targetIds : [];
  const selectedBlocks = [...selected, ...doc.body.sections.filter((section) => selected.includes(section.id)).flatMap((section) => section.blocks.map((block) => block.id))];
  return doc.questions.filter((entry) => entry.id !== question.id && (intersect(entry.targetBlockIds, selectedBlocks) || entry.kind !== "source-reference" && intersect(entry.sourceClauseIds, sourceIds)));
}
function stagesFor(doc: ProposalCommercialDocumentV1, states: Map<string, CommercialQuestionState>): { stages: CommercialAgreedStage[]; issues: CommercialIssue[] } {
  const plans = doc.questions.filter((question) => question.kind === "stage-plan");
  if (plans.length) {
    const active = plans.length === 1 ? states.get(plans[0].id)?.activeDecision?.answer : undefined;
    return active?.kind === "stage-plan" ? { stages: active.stages, issues: [] } : { stages: [], issues: [issue("commercial-stage-plan-required", "Сначала примените единственный полный согласованный план этапов; исходные четыре/пять этапов автоматически не выбраны.")] };
  }
  const catalog = collectCommercialStageCatalog(doc);
  if (!catalog.stages.length || catalog.issues.length || catalog.stages.some((stage) => !stage.duration || !requiredText(stage.scope) || !requiredText(stage.result))) return { stages: [], issues: [...catalog.issues, issue("commercial-stage-catalog-unresolved", "Исходный каталог этапов не даёт однозначного полного плана.")] };
  return { stages: catalog.stages.map((stage) => ({ id: stage.id, title: stage.title, scope: stage.scope, result: stage.result, duration: stage.duration! })), issues: [] };
}

function preview(doc: ProposalCommercialDocumentV1, question: CommercialTermQuestion, answer: CommercialTermAnswer, context: CommercialDecisionContext, states: Map<string, CommercialQuestionState>): { blocks: CommercialBlock[]; issues: CommercialIssue[] } {
  const issues = [...answerShape(answer, question), ...targetIssues(doc, question)];
  if (issues.length) return { blocks: [], issues };
  const own = targets(doc, question), fail = (code: string, message: string) => { issues.push(issue(code, message, `questions.${question.id}`)); return { blocks: [], issues }; };
  if (answer.kind === "advance-base") {
    if (!context.pricing || context.pricing.currency !== "RUB") return fail("commercial-financial-context", "Нужна действующая цена предложения в рублях; исходная цена сама не применяется.");
    const amounts = own.map((block) => { const source = sourceTemplate(doc, question, block.id); return source === undefined ? undefined : supportedAdvanceBase(source); });
    if (amounts.some((amount) => amount === undefined)) return fail("commercial-advance-closed-form", "Исходный пункт суммы аванса содержит неразобранное условие (например, зачёт, возврат или иную оговорку). Двух переключателей недостаточно: исходный пункт сохранён, нужна отдельная предметная редакция.");
    const percentages = [...new Set(amounts as string[])];
    if (percentages.length !== 1) return fail("commercial-advance-percent", "Размер аванса в связанных исходных условиях не установлен однозначно.");
    const [whole, fraction = ""] = percentages[0].split("."), percent = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (percent <= 0n || percent > 10000n) return fail("commercial-advance-percent", "Размер аванса должен быть больше нуля и не превышать 100%.");
    try {
      const priced = priceProposal([...context.pricing.lines]), round = (n: bigint, d: bigint) => (n * 2n + d) / (2n * d);
      let base = 0n, vat = 0n, gross = 0n;
      for (const group of priced.totals.byTax) {
        const part = round(BigInt(answer.base === "net" ? group.netMinor : group.grossMinor) * percent, 10000n), rate = group.tax.kind === "vat" ? BigInt(group.tax.rate) : 0n;
        const tax = round(part * rate, answer.vatTreatment === "included" ? 100n + rate : 100n);
        base += part; vat += tax; gross += answer.vatTreatment === "included" ? part : part + tax;
      }
      if (!gross || gross > MAX_MONEY_MINOR || gross > BigInt(priced.totals.grossMinor)) return fail("commercial-advance-amount", "Рассчитанный аванс равен нулю или превышает полную цену предложения; проверьте базу и НДС.");
      const noVat = priced.totals.byTax.every((group) => group.tax.kind === "none");
      const text = noVat ? `Аванс составляет ${percentages[0]}% от цены предложения без НДС: ${formatMoneyMinor(base.toString())}. НДС не применяется. Всего к оплате аванса: ${formatMoneyMinor(gross.toString())}.` : `Аванс составляет ${percentages[0]}% от ${answer.base === "net" ? "цены предложения без НДС" : "цены предложения с НДС по облагаемым позициям"}: ${formatMoneyMinor(base.toString())}. ${answer.vatTreatment === "additional" ? `НДС начисляется дополнительно: ${formatMoneyMinor(vat.toString())}. Всего к оплате аванса: ${formatMoneyMinor(gross.toString())}.` : `В эту сумму включён НДС: ${formatMoneyMinor(vat.toString())}. Всего к оплате аванса: ${formatMoneyMinor(gross.toString())}.`}`;
      if (noVat) issues.push(issue("commercial-advance-no-vat-context", "Текущая цена предложения без НДС. Переключатель включённого / дополнительного НДС здесь неприменим; налоговая база требует отдельного согласования, это не ставка НДС 0%.", `questions.${question.id}`, "review"));
      if (answer.base === "gross" && answer.vatTreatment === "additional" && vat) issues.push(issue("commercial-gross-additional-vat", "Пользователь выбрал начисление НДС поверх базы с НДС. Это отдельное финансовое условие требует согласования, не автоматическое устранение неоднозначности.", `questions.${question.id}`, "review"));
      return { blocks: own.map((block) => paragraph(block.id, text)), issues };
    } catch (error) { return fail("commercial-financial-context", error instanceof Error ? error.message : "Цена предложения не рассчитана."); }
  }
  if (answer.kind === "advance-days") {
    const blocks: CommercialBlock[] = [];
    for (const block of own) {
      const source = sourceTemplate(doc, question, block.id);
      const expression = /(\d+\s*(?:\([^)]{1,80}\)\s*)?)(?:(?:рабоч[\p{L}]*|календарн[\p{L}]*)\s+)?дн(?:я|ей)/giu;
      if (!source || [...source.matchAll(expression)].length !== 1) return fail("commercial-advance-days-bounds", "Срок аванса не выделен одним отдельным исходным условием. Соседние сроки не изменены.");
      blocks.push(paragraph(block.id, source.replace(expression, (_all, number: string) => `${number}${answer.dayKind === "business" ? "рабочих" : "календарных"} дней`)));
    }
    return { blocks, issues };
  }
  if (answer.kind === "stage-plan") {
    const maximums = sourceMaximums(doc), unique = new Set(maximums.map((part) => `${part.count}:${part.dayKind}`));
    if (unique.size > 1 || maximums.some((part) => part.count !== answer.maximum.count || part.dayKind !== answer.maximum.dayKind)) return fail("commercial-stage-maximum", "Максимальный срок не совпадает с отдельным исходным условием. Начало, ожидание и общий максимум не заменяются суммой этапов.");
    const table = own.find((block) => block.kind === "table") || own[0], paragraphs = own.filter((block) => block.id !== table.id);
    if (own.filter((block) => block.kind === "table").length > 1) return fail("commercial-stage-target-shape", "Несколько независимых таблиц нельзя заменить одним планом автоматически.");
    if (answer.stages.some((stage) => stage.duration.dayKind === answer.maximum.dayKind && Number(stage.duration.count) > Number(answer.maximum.count))) return fail("commercial-stage-maximum", "Длительность одного этапа уже превышает общий максимум в том же виде дней.");
    const rules = sourceStageRules(doc, answer.stages); issues.push(...rules.issues);
    if (rules.issues.some((part) => part.severity === "error") || cycle(rules.edges)) return fail("commercial-stage-trigger-plan", "Исходные условия начала этапов не образуют представимый согласованный план.");
    const rows: CommercialInline[][][] = answer.stages.map((stage) => [stage.title, stage.scope, rules.durations.get(stage.id) || durationText(stage.duration), stage.result].map((text) => [{ kind: "text", text }]));
    if (!paragraphs.length) rows.push(["Общий максимальный срок", "", durationText(answer.maximum), ""].map((text) => [{ kind: "text", text }]));
    const blocks: CommercialBlock[] = [{ id: table.id, kind: "table", columns: ["Этап", "Состав работ", "Срок", "Результат"], rows }];
    blocks.push(...paragraphs.map((block) => paragraph(block.id, `Услуги оказываются в ${answer.stages.length} этапах по согласованному перечню. Общий максимальный срок — ${durationText(answer.maximum)}.`)));
    return { blocks: own.map((block) => blocks.find((next) => next.id === block.id)!), issues };
  }
  const plan = answer.kind === "stage-parallelism" || answer.kind === "boundary-protocol" ? stagesFor(doc, states) : undefined;
  if (plan?.issues.length) return { blocks: [], issues: [...issues, ...plan.issues] };
  const stages = plan?.stages || [], stageIds = stages.map((stage) => stage.id), stageName = (id: string) => stages.find((stage) => stage.id === id)!.title;
  if (answer.kind === "stage-parallelism") {
    const rules = sourceStageRules(doc, stages), edges = rules.edges, used = new Set<string>(); issues.push(...rules.issues);
    if (rules.issues.some((part) => part.severity === "error")) return { blocks: [], issues };
    for (const relation of answer.relations) {
      const related = relation.kind === "after" ? [relation.stageId, relation.afterStageId] : relation.stageIds;
      if (related.some((id) => !stageIds.includes(id)) || new Set(related).size !== related.length) return fail("commercial-stage-relation-owner", "Связь содержит неизвестный этап или ссылку этапа на себя.");
      related.forEach((id) => used.add(id)); if (relation.kind === "after") addEdge(edges, relation.afterStageId, relation.stageId);
    }
    if (cycle(edges)) return fail("commercial-stage-relation-cycle", "Последовательность этапов образует цикл.");
    const reaches = (from: string, to: string, visited = new Set<string>()): boolean => { if (from === to) return true; if (visited.has(from)) return false; visited.add(from); return [...(edges.get(from) || [])].some((next) => reaches(next, to, visited)); };
    if (answer.relations.some((relation) => relation.kind === "may-overlap" && relation.stageIds.some((a) => relation.stageIds.some((b) => a !== b && (reaches(a, b) || reaches(b, a)))))) return fail("commercial-stage-relation-conflict", "Одни и те же этапы одновременно требуют завершения друг друга и разрешают параллельное выполнение.");
    if (stages.length > 1 && stageIds.some((id) => !used.has(id))) return fail("commercial-stage-relation-incomplete", "Укажите конкретные связи для всех согласованных этапов.");
    const activePlan = [...states.values()].find((state) => state.activeDecision?.answer.kind === "stage-plan")?.activeDecision?.answer, sourceMax = sourceMaximums(doc);
    const maximum = activePlan?.kind === "stage-plan" ? activePlan.maximum : sourceMax.length === 1 ? sourceMax[0] : undefined;
    if (maximum && stages.every((stage) => stage.duration.dayKind === maximum.dayKind)) {
      const memo = new Map<string, number>(), longest = (id: string): number => { const known = memo.get(id); if (known !== undefined) return known; const value = Number(stages.find((stage) => stage.id === id)!.duration.count) + Math.max(0, ...[...(edges.get(id) || [])].map(longest)); memo.set(id, value); return value; };
      if (Math.max(0, ...stageIds.map(longest)) > Number(maximum.count)) issues.push(issue("commercial-stage-maximum-consistency", "Согласованная цепочка длительностей превышает отдельный общий максимум. Уточните план; новая дата или суммарное обещание срока не вычислены и в документ не подставлены.", `questions.${question.id}`, "review"));
    } else issues.push(issue("commercial-stage-maximum-unassessed", "Сопоставление плана с общим максимумом требует рассмотрения: вид дней / максимум не установлен однозначно.", `questions.${question.id}`, "review"));
    const text = answer.relations.map((relation) => relation.kind === "after" ? `Этап «${stageName(relation.stageId)}» начинается после завершения этапа «${stageName(relation.afterStageId)}».` : `Этапы ${relation.stageIds.map((id) => `«${stageName(id)}»`).join(", ")} могут выполняться параллельно при условии: ${relation.conditions}`).join("\n") || "Услуги выполняются в одном согласованном этапе.";
    return { blocks: own.map((block) => paragraph(block.id, text)), issues };
  }
  if (answer.kind === "boundary-protocol") {
    // Source completion triggers remain operative even when the explicit
    // parallelism answer only adds some after-edges. A milestone must not form
    // a cycle with an untouched, literal source condition in the plan table.
    const rules = sourceStageRules(doc, stages), edges = rules.edges;
    issues.push(...rules.issues);
    if (rules.issues.some((part) => part.severity === "error")) return { blocks: [], issues };
    const parallel = [...states.values()].filter((state) => state.activeDecision?.answer.kind === "stage-parallelism").flatMap((state) => state.activeDecision!.answer.kind === "stage-parallelism" ? state.activeDecision!.answer.relations : []);
    parallel.forEach((relation) => { if (relation.kind === "after") addEdge(edges, relation.afterStageId, relation.stageId); });
    const testing = stages.filter((stage) => /(?:пентест|тестирован|pentest|penetration|проверк[\p{L}\s]{0,50}(?:безопасност|уязвим))/iu.test(`${stage.title} ${stage.scope}`)).map((stage) => stage.id);
    for (const [index, milestone] of answer.milestones.entries()) {
      if ([...milestone.beforeStageIds, ...milestone.afterStageIds].some((id) => !stageIds.includes(id))) return fail("commercial-protocol-stage-owner", "Контрольная точка содержит неизвестный этап.");
      milestone.beforeStageIds.forEach((id) => addEdge(edges, `milestone-${index}`, id)); milestone.afterStageIds.forEach((id) => addEdge(edges, id, `milestone-${index}`));
    }
    if (cycle(edges)) return fail("commercial-protocol-cycle", "Контрольные точки и последовательность этапов противоречат друг другу.");
    const permission = answer.milestones.filter((milestone) => supportedPermissionCondition(milestone.condition));
    if (answer.milestones.some((milestone) => /границ|периметр|разрешени/iu.test(milestone.condition) && !supportedPermissionCondition(milestone.condition))) return fail("commercial-protocol-condition-unrepresentable", "Условие границ / разрешения не представлено однозначным положительным решением этого редактора. Поддерживаемая форма: «Границы согласованы, письменное разрешение получено». Отрицания, будущее, цитаты, дополнительные оговорки и иные формулировки требуют предметного рассмотрения; исходные пункты сохранены для проверочного черновика.");
    if (testing.length && !permission.some((milestone) => testing.every((id) => milestone.beforeStageIds.includes(id)))) return fail("commercial-protocol-before-testing", "Согласование границ и разрешения должно предшествовать всем этапам тестирования; тесты до этой точки не допускаются.");
    if (!testing.length) issues.push(issue("commercial-protocol-testing-unknown", "Этапы, выполняющие тестирование, не определены по содержанию плана; безопасность последовательности требует отдельного рассмотрения.", `questions.${question.id}`, "review"));
    const text = answer.milestones.map((milestone) => `${milestone.title}. Условие: ${milestone.condition}.${milestone.afterStageIds.length ? ` После завершения: ${milestone.afterStageIds.map(stageName).join(", ")}.` : ""}${milestone.beforeStageIds.length ? ` До начала: ${milestone.beforeStageIds.map(stageName).join(", ")}.` : ""}`).join("\n");
    const blocks: CommercialBlock[] = [];
    for (const [index, block] of own.entries()) {
      const source = sourceTemplate(doc, question, block.id), expression = /(?:по\s+итогам|после\s+завершения)\s+этапа\s+\d+|на\s+этапе\s+старта\s+работ|на\s+старте\s+работ|до\s+начала\s+(?:работ|тестирования)/giu;
      if (!source || !expression.test(source)) return fail("commercial-protocol-target-shape", "Исходная формулировка момента протокола не выделена однозначно. Условие не заменено общим подтверждением.");
      expression.lastIndex = 0; const retained = source.replace(expression, "в согласованной контрольной точке");
      blocks.push(paragraph(block.id, `${retained}${index === 0 ? `\n\n${text}\nТестирование допускается только после согласования границ и получения разрешения.` : ""}`));
    }
    return { blocks, issues };
  }
  if (answer.kind === "source-reference") {
    if (commercialCanonicalJson([...answer.referenceIds].sort()) !== commercialCanonicalJson([...question.sourceReferenceIds].sort())) return fail("commercial-reference-selection", "Решение должно явно охватывать все ссылки данного вопроса, не чужие или только удобные occurrences.");
    const resolution = answer.resolution;
    if (resolution.kind === "replace-clauses") {
      if (commercialCanonicalJson(resolution.replacements.map((entry) => entry.blockId).sort()) !== commercialCanonicalJson([...question.targetBlockIds].sort())) return fail("commercial-reference-replacement-target", "Прямое редактирование чужих / upstream блоков не поддерживается этим решением. Выберите собственные блоки вопроса.");
      return { blocks: own.map((block) => paragraph(block.id, resolution.replacements.find((entry) => entry.blockId === block.id)!.publicText)), issues };
    }
    if (resolution.kind === "governing-document") return { blocks: own.map((block) => paragraph(block.id, `${resolution.definitionTitle}\n${resolution.definitionText}`)), issues };
    const localIds = [...doc.body.sections.map((section) => section.id), ...allBlocks(doc).map((block) => block.id)];
    if (resolution.targetIds.some((id) => !localIds.includes(id) || question.targetBlockIds.includes(id) || doc.body.sections.some((section) => section.id === id && section.blocks.some((block) => question.targetBlockIds.includes(block.id))))) return fail("commercial-reference-target", "Цель ссылки отсутствует или ссылается на собственное определение.");
    const printed = question.sourceReferenceIds.map((id) => doc.privateAppendix.references.find((ref) => ref.id === id)!.printed);
    const content: CommercialInline[] = [{ kind: "text", text: `Исходные ссылки ${[...new Set(printed)].map((part) => `«${part}»`).join(", ")} в этой редакции относятся к: ` }];
    resolution.targetIds.forEach((targetId, index) => { if (index) content.push({ kind: "text", text: ", " }); content.push({ kind: "local-ref", targetId }); });
    return { blocks: own.map((block) => ({ id: block.id, kind: "paragraph", style: "body", content: structuredClone(content) })), issues };
  }
  return fail("commercial-answer-unsupported", "Это решение не представлено ограниченным редактором условий.");
}

async function evaluate(doc: ProposalCommercialDocumentV1, context: CommercialDecisionContext, proposed?: { id: string; answer: CommercialTermAnswer }): Promise<Evaluation> {
  const structural = validateCommercialDocument(doc), states = new Map<string, CommercialQuestionState>();
  if (structural.some((part) => part.severity === "error")) return { states, issues: structural };
  const issues = await validateCommercialQuoteHashes(doc), decisions = new Set<string>(), priorByQuestion = new Map<string, CommercialAppliedTermDecision>();
  for (const decision of doc.decisions) {
    const prior = priorByQuestion.get(decision.questionId);
    if (decisions.has(decision.id) || decision.supersedesDecisionId !== prior?.id || !doc.questions.some((question) => question.id === decision.questionId)) issues.push(issue("commercial-decision-history", "История решений неоднозначна, повторена или ссылается не на своего предшественника."));
    decisions.add(decision.id); priorByQuestion.set(decision.questionId, decision);
  }
  const visiting = new Set<string>();
  const stateFor = async (question: CommercialTermQuestion): Promise<CommercialQuestionState> => {
    const cached = states.get(question.id); if (cached) return cached;
    if (visiting.has(question.id)) throw new CommercialDecisionError("commercial-dependency-cycle", "Зависимости вопросов образуют цикл; решения не могут подтверждать друг друга.");
    visiting.add(question.id);
    const latest = latestDecision(doc, question), answer = proposed?.id === question.id ? proposed.answer : latest?.answer;
    const safeAnswer = answer && !answerShape(answer, question).length ? answer : undefined;
    const ownIssues = [...targetIssues(doc, question)], source = await commercialQuestionSourceFingerprint(doc.privateAppendix, question), sourceCurrent = source === question.dependencyFingerprint;
    const originalProjection = sourceProjectionFor(doc, question);
    const initial = initialCoverage(doc);
    if (doc.privateAppendix.coverage.some((coverage, index) => coverage.kind === "superseded-by-decision" && !initial[index] && doc.decisions.find((decision) => decision.id === coverage.decisionId)?.changedBlockIds.some((id) => question.targetBlockIds.includes(id)))) ownIssues.push(issue("commercial-source-layout-missing", "Исходная связь пунктов с блоками утрачена. Решение нельзя восстановить по порядку строк.", `questions.${question.id}`));
    if (!sourceCurrent) ownIssues.push(issue("commercial-question-source-stale", "Исходные условия вопроса изменились. Обновите подготовку, прежний ответ не переносится автоматически.", `questions.${question.id}`));
    const dependencies: CommercialQuestionState[] = [];
    for (const dependency of dependencyQuestions(doc, question, safeAnswer)) dependencies.push(await stateFor(dependency));
    if (dependencies.some((state) => !state.activeDecision)) ownIssues.push(issue("commercial-upstream-unresolved", `Сначала рассмотрите связанные вопросы: ${dependencies.filter((state) => !state.activeDecision).map((state) => state.question.id).join(", ")}.`, `questions.${question.id}`));
    let financial: unknown;
    if (question.kind === "advance-base") {
      try {
        const totals = context.pricing?.currency === "RUB" ? priceProposal([...context.pricing.lines]).totals : undefined;
        financial = totals ? { ...totals, byTax: [...totals.byTax].sort((a, b) => commercialCanonicalJson(a.tax).localeCompare(commercialCanonicalJson(b.tax))) } : null;
      }
      catch { financial = null; }
      if (!financial) ownIssues.push(issue("commercial-financial-context", "Текущая применяемая цена предложения не рассчитана.", `questions.${question.id}`));
    }
    const selected = safeAnswer?.kind === "source-reference" && safeAnswer.resolution.kind === "body-target" ? safeAnswer.resolution.targetIds : [];
    const referenceTargets = selected.map((id) => doc.body.sections.find((section) => section.id === id) || allBlocks(doc).find((block) => block.id === id) || { id, missing: true });
    const dependencyFingerprint = await commercialFingerprint({ version: 1, source, originalProjection, financial, maximums: question.kind === "stage-plan" ? sourceMaximums(doc).map((part) => part.clause) : undefined,
      upstream: dependencies.map((state) => ({ questionId: state.question.id, activeDecisionId: state.activeDecision?.id, afterFingerprint: state.activeDecision?.afterFingerprint, dependencyFingerprint: state.dependencyFingerprint, status: state.status })), referenceTargets });
    let activeDecision: CommercialAppliedTermDecision | undefined;
    if (latest) {
      const generated = preview(doc, question, answer || latest.answer, context, states);
      ownIssues.push(...generated.issues);
      if ((!proposed || proposed.id !== question.id || commercialCanonicalJson(proposed.answer) === commercialCanonicalJson(latest.answer)) && latest.sourceSnapshotKey === doc.privateAppendix.sourceSnapshotKey && commercialCanonicalJson(latest.sourceClauseIds) === commercialCanonicalJson(decisionSourceIds(doc, question)) && commercialCanonicalJson(latest.sourceCoverageBefore || []) === commercialCanonicalJson(originalProjection)
        && commercialCanonicalJson(latest.changedBlockIds) === commercialCanonicalJson(question.targetBlockIds) && latest.dependencyFingerprint === dependencyFingerprint
        && latest.afterFingerprint === await commercialFingerprint({ version: 1, blocks: targets(doc, question) }) && generated.blocks.length && commercialCanonicalJson(generated.blocks) === commercialCanonicalJson(targets(doc, question)) && !generated.issues.some((part) => part.severity === "error") && !ownIssues.some((part) => part.severity === "error") && !issues.some((part) => part.severity === "error")) activeDecision = latest;
      else ownIssues.push(issue("commercial-decision-stale", "Прежнее решение не соответствует текущим источникам, зависимостям или изменённым блокам.", `questions.${question.id}`, "review"));
    }
    visiting.delete(question.id);
    const state: CommercialQuestionState = { question, sourceCurrent, dependencyFingerprint, status: ownIssues.some((part) => part.severity === "error") || issues.some((part) => part.severity === "error") ? "blocked" : activeDecision ? "resolved" : latest ? "stale" : "unresolved", activeDecision, issues: uniqueIssues(ownIssues) };
    states.set(question.id, state); return state;
  };
  try { for (const question of doc.questions) await stateFor(question); }
  catch (error) { issues.push(issue("commercial-dependency-cycle", error instanceof Error ? error.message : "Не удалось проверить зависимости решений.")); }
  return { states, issues: uniqueIssues(issues) };
}

/** `proposedAnswer` binds newly chosen reference targets for preview/Apply. It
 * does not store an answer or turn a draft choice into an applied decision. */
export async function currentQuestionState(doc: ProposalCommercialDocumentV1, questionId: string, context: CommercialDecisionContext = {}, proposedAnswer?: CommercialTermAnswer): Promise<CommercialQuestionState> {
  const question = questionFor(doc, questionId), result = await evaluate(doc, context, proposedAnswer ? { id: questionId, answer: proposedAnswer } : undefined);
  return result.states.get(questionId) || { question, sourceCurrent: false, dependencyFingerprint: await commercialFingerprint({ invalid: true, questionId }), status: "blocked", issues: result.issues };
}
export async function validateTermAnswer(doc: ProposalCommercialDocumentV1, questionId: string, answer: CommercialTermAnswer, context: CommercialDecisionContext = {}): Promise<CommercialAnswerValidation> {
  const question = questionFor(doc, questionId), shape = answerShape(answer, question), evaluated = await evaluate(doc, context, shape.length ? undefined : { id: questionId, answer });
  const state = evaluated.states.get(questionId);
  if (!state) return { valid: false, issues: [...evaluated.issues, ...shape], dependencyFingerprint: await commercialFingerprint({ invalid: true, questionId }), previewBlocks: [] };
  if (shape.length) return { valid: false, issues: [...evaluated.issues, ...shape], dependencyFingerprint: state.dependencyFingerprint, previewBlocks: [] };
  const generated = preview(doc, state.question, answer, context, evaluated.states), issues = uniqueIssues([...evaluated.issues, ...state.issues.filter((part) => part.code !== "commercial-decision-stale"), ...generated.issues]);
  return { valid: !issues.some((part) => part.severity === "error"), issues, dependencyFingerprint: state.dependencyFingerprint, previewBlocks: generated.blocks };
}
function freeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

/** Called only by an explicit user Apply action. No model response, source
 * classifier, preview render or persistence event calls this automatically. */
export async function applyTermDecision(doc: ProposalCommercialDocumentV1, command: CommercialApplyCommand, context: CommercialDecisionContext = {}): Promise<CommercialApplyResult> {
  if (command.expectedRevision !== doc.revision) throw new CommercialDecisionError("commercial-stale-revision", "Документ изменился после открытия решения. Обновите вопрос.");
  if (!isCommercialId(command.decisionId) || doc.decisions.some((entry) => entry.id === command.decisionId) || typeof command.appliedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(command.appliedAt) || !Number.isFinite(Date.parse(command.appliedAt))) throw new CommercialDecisionError("commercial-decision-replay", "Некорректный / повторный идентификатор решения или время применения.");
  const before = await evaluate(doc, context), question = questionFor(doc, command.questionId), validation = await validateTermAnswer(doc, question.id, command.answer, context);
  if (command.expectedRevision !== doc.revision) throw new CommercialDecisionError("commercial-stale-revision", "Документ изменился во время проверки решения. Обновите вопрос.");
  if (!isCommercialSha256(command.expectedDependencyFingerprint) || command.expectedDependencyFingerprint !== validation.dependencyFingerprint) throw new CommercialDecisionError("commercial-stale-dependency", "Цена, источники или связанные решения изменились. Повторно рассмотрите текущий вариант.");
  if (!validation.valid) throw new CommercialDecisionError("commercial-answer-invalid", "Решение не применено: остались конкретные ошибки / неизвестные зависимости.", validation.issues);
  const previous = latestDecision(doc, question), document = structuredClone(doc), afterBlocks = validation.previewBlocks, coverageBefore = sourceProjectionFor(doc, question);
  const decision: CommercialAppliedTermDecision = { version: 1, id: command.decisionId, questionId: question.id, answer: structuredClone(command.answer), origin: "user", appliedAt: command.appliedAt,
    sourceSnapshotKey: doc.privateAppendix.sourceSnapshotKey, dependencyFingerprint: validation.dependencyFingerprint, sourceClauseIds: decisionSourceIds(doc, question), ...(coverageBefore.length ? { sourceCoverageBefore: structuredClone(coverageBefore) } : {}), changedBlockIds: [...question.targetBlockIds],
    beforeFingerprint: await commercialFingerprint({ version: 1, blocks: targets(doc, question) }), afterFingerprint: await commercialFingerprint({ version: 1, blocks: afterBlocks }), ...(previous ? { supersedesDecisionId: previous.id } : {}) };
  document.body.sections = document.body.sections.map((section) => ({ ...section, blocks: section.blocks.map((block) => afterBlocks.find((next) => next.id === block.id) || block) }));
  document.privateAppendix.coverage = document.privateAppendix.coverage.map((coverage) => {
    if (coverage.kind === "split") return { ...coverage, parts: coverage.parts.map((part) => question.targetBlockIds.includes(part.targetBlockId) && part.purpose === question.kind ? { ...part, supersededByDecisionId: decision.id } : part) };
    if ((coverage.kind === "literal" || coverage.kind === "projected" || coverage.kind === "deduplicated") && coverage.targetBlockIds.every((id) => question.targetBlockIds.includes(id))) return { sourceClauseId: coverage.sourceClauseId, kind: "superseded-by-decision" as const, decisionId: decision.id };
    if (coverage.kind === "superseded-by-decision" && previous && coverage.decisionId === previous.id) return { ...coverage, decisionId: decision.id };
    return coverage;
  });
  document.revision += 1; document.decisions.push(decision); freeze(document.privateAppendix); freeze(document.decisions);
  const invalid = validateCommercialDocument(document); if (invalid.some((part) => part.severity === "error")) throw new CommercialDecisionError("commercial-applied-structure", "Редакция решения не помещается в безопасную структуру документа; изменения не сохранены.", invalid);
  const after = await evaluate(document, context), current = after.states.get(question.id);
  if (!current?.activeDecision || current.activeDecision.id !== decision.id) throw new CommercialDecisionError("commercial-self-invalidated", "Решение не образовало устойчивую собственную редакцию. Исходный документ не изменён.", current?.issues || after.issues);
  const activeAfter = new Set([...after.states.values()].flatMap((state) => state.activeDecision ? [state.activeDecision.id] : []));
  return { document, decision, changedBlockIds: [...question.targetBlockIds], invalidatedDecisionIds: [...before.states.values()].flatMap((state) => state.activeDecision && !activeAfter.has(state.activeDecision.id) ? [state.activeDecision.id] : []), issues: validation.issues };
}

/** Readiness is recomputed from current source, targets and dependency graph.
 * Partial drafts remain saveable; source.complete and coverage labels are not
 * semantic approval, visual review, or verification of external public fields. */
export async function projectReadiness(doc: ProposalCommercialDocumentV1, context: CommercialDecisionContext = {}): Promise<CommercialReadiness> {
  const validation = validateCommercialDocument(doc);
  if (validation.some((part) => part.severity === "error")) return { canSaveDraft: false, canFinalize: false, issues: validation, questions: [], activeDecisionIds: [], staleDecisionIds: [] };
  const evaluated = await evaluate(doc, context), questions = doc.questions.flatMap((question) => evaluated.states.get(question.id) ? [evaluated.states.get(question.id)!] : []), issues = [...evaluated.issues, ...validateCommercialSourceProjection(doc)];
  if (!doc.privateAppendix.clauses.length || !allBlocks(doc).some((block) => block.kind === "paragraph" ? block.content.some((part) => part.kind === "text" && part.text.trim()) : block.kind === "list" ? block.items.length > 0 : block.rows.length > 0)) issues.push(issue("commercial-empty-document", "Пустой исходный комплект / документ не является готовым предложением.", "body", "review"));
  if (!doc.privateAppendix.extraction.complete || doc.privateAppendix.extraction.requiresOcr) issues.push(issue("commercial-incomplete-material", "Текст / OCR исходных материалов не подтверждён как полный.", "privateAppendix.extraction", "review"));
  if (doc.privateAppendix.extraction.visualAssessment !== "reviewed-by-user") issues.push(issue("commercial-visual-unresolved", "Визуальная полнота исходных страниц не проверена; найденный текст не заменяет эту проверку.", "privateAppendix.extraction", "review"));
  for (const state of questions) {
    issues.push(...state.issues);
    if (state.question.material && !state.activeDecision) issues.push(issue("commercial-material-question", state.question.message, `questions.${state.question.id}`, "review"));
  }
  const active = new Map(questions.flatMap((state) => state.activeDecision ? [[state.activeDecision.id, state.activeDecision] as const] : []));
  for (const coverage of doc.privateAppendix.coverage) {
    const clause = doc.privateAppendix.clauses.find((entry) => entry.id === coverage.sourceClauseId)!;
    if (coverage.kind === "external-field") issues.push(issue("commercial-external-field-unverified", `Актуальное внешнее поле «${coverage.field}» требует отдельного подтверждения связи с источником.`, `privateAppendix.coverage.${clause.id}`, "review"));
    if (coverage.kind === "unmapped" || ["unclassified", "excluded-material"].includes(clause.classification)) issues.push(issue("commercial-unmapped-material", "Исходный фрагмент не распределён / не проверен. Его классификация не разрешает исключить существенное условие.", `privateAppendix.coverage.${clause.id}`, "review"));
    if (coverage.kind === "private-context") {
      const structural = !clause.quote.trim() || isCommercialStructuralHeading(clause.quote);
      if (!structural) issues.push(issue("commercial-private-material-review", "Частно сохранённый исходный контекст требует предметного рассмотрения; само слово «служебный» или classification не является разрешением исключить его.", `privateAppendix.coverage.${clause.id}`, "review"));
    }
    if (coverage.kind === "superseded-by-decision" && !active.has(coverage.decisionId) || coverage.kind === "split" && coverage.parts.some((part) => part.supersededByDecisionId && !active.has(part.supersededByDecisionId))) issues.push(issue("commercial-stale-coverage-decision", "Исходное условие изменено неактуальным решением; прежняя отметка покрытия не подтверждает текущую редакцию.", `privateAppendix.coverage.${clause.id}`, "review"));
  }
  for (const ref of doc.privateAppendix.references) {
    const resolved = ref.localTargetIds?.length || questions.some((state) => state.activeDecision?.answer.kind === "source-reference" && state.activeDecision.answer.referenceIds.includes(ref.id));
    const coverage = doc.privateAppendix.coverage.find((entry) => entry.sourceClauseId === ref.sourceClauseId);
    if (!resolved && coverage && !["unmapped", "private-context", "external-field"].includes(coverage.kind)) issues.push(issue("commercial-unresolved-reference", `Ссылка «${ref.printed}» не имеет действующего однозначного определения.`, `privateAppendix.references.${ref.id}`, "review"));
  }
  const finalIssues = uniqueIssues(issues);
  return { canSaveDraft: true, canFinalize: finalIssues.length === 0 && questions.every((state) => !state.question.material || Boolean(state.activeDecision)), issues: finalIssues, questions,
    activeDecisionIds: questions.flatMap((state) => state.activeDecision ? [state.activeDecision.id] : []), staleDecisionIds: questions.filter((state) => !state.activeDecision && latestDecision(doc, state.question)).map((state) => latestDecision(doc, state.question)!.id) };
}
