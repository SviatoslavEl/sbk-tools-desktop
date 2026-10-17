import { auditIntelligenceResult, type EvidenceExcerpt } from "./resultEvidence";
import { extractStaffCertificateFacts } from "./sourceStaffCertificates";
import type { SourcePreparationResult } from "./sourcePreparedFacts";
import type { IntelligenceItem, IntelligenceSource } from "./workbenchTypes";

const allowed: Record<string, ReadonlySet<string>> = {
  staff: new Set(["certificates", "education", "basis", "basisOther", "basisNumber", "experienceYears", "experienceNotes", "phone", "email"]),
  procurement: new Set(["licenses", "notes", "publishedDate", "submissionDeadline", "questionDeadline", "executionStartDate", "executionEndDate"]),
  proposals: new Set(["issuerName", "recipientName", "recipientAddress", "number"]),
};
const literal = (text: string) => text.replace(/\s+/gu, " ").trim();
const validIds = (values: readonly { id: string }[]) => values.every((value) => typeof value.id === "string" && Boolean(value.id.trim()) && Array.from(value.id).length <= 128 && !/[\u0000-\u001f]/u.test(value.id)) && new Set(values.map((value) => value.id)).size === values.length;

/** Quarantines independently audited, literal source contradictions. The only
 * absence rule is an unverified staff basis in an explicitly owned certificate
 * registry: certificate identity does not establish employment. Other unknown
 * values stay selected. No value, raw response, source, evidence or review
 * acknowledgment is rewritten or manufactured. */
export function quarantineConflictingFields(items: readonly IntelligenceItem[], sources: readonly IntelligenceSource[]): SourcePreparationResult {
  const unchanged = (): SourcePreparationResult => ({ items: [...items], changes: [], skipped: [], limited: false });
  const stop = (reason: string, message: string): SourcePreparationResult => ({ ...unchanged(), limited: true, skipped: [{ reason, message, requiresReview: true }] });
  if (!items.some((item) => item.selectedFields.some((field) => allowed[item.destination]?.has(field)))) return unchanged();
  const duplicateFragments = sources.some((source) => {
    const ids = (source.fragments || []).flatMap((fragment) => fragment.id ? [fragment.id] : []);
    return new Set(ids).size !== ids.length;
  });
  if (items.length > 100 || sources.length > 100 || !validIds(items) || !validIds(sources) || duplicateFragments) return stop("quarantine-input-identity", "Противоречивые поля не исключены автоматически: превышен предел или повторяются идентификаторы. Проверьте материалы вручную.");
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const fresh = (item: IntelligenceItem, proof: EvidenceExcerpt) => {
    if (!item.sourceIds.includes(proof.sourceId) || !proof.quote.trim() || Array.from(proof.quote).length > 4000) return false;
    const source = sourceMap.get(proof.sourceId);
    if (!source || source.name !== proof.sourceName) return false;
    const fragments = source.fragments === undefined ? [{ locator: "Текст источника", text: source.text, id: undefined, sheetState: undefined }] : source.fragments;
    return fragments.some((fragment) => fragment.sheetState !== "hidden" && fragment.sheetState !== "veryHidden" && fragment.id === proof.fragmentId && fragment.locator === proof.locator && literal(fragment.text).includes(literal(proof.quote)));
  };
  let audit;
  try { audit = auditIntelligenceResult(items, sources); }
  catch { return stop("quarantine-audit-failed", "Независимая проверка противоречий не завершилась. Выбор полей не изменён; проверьте материалы вручную."); }
  if (audit.findings.some((finding) => finding.code === "audit-limit")) return stop("quarantine-audit-limit", "Независимая проверка достигла предела. Выбор полей не изменён частично; разделите материалы или проверьте их вручную.");
  const registryBasis = items.filter((item) => item.destination === "staff" && item.selectedFields.includes("basis") && item.selectedFields.includes("fullName")
    && typeof item.fields.basis === "string" && item.fields.basis.trim() && typeof item.fields.fullName === "string"
    && audit.fields.some((field) => field.itemId === item.id && field.field === "basis" && field.status === "unverified")
    && audit.fields.some((field) => field.itemId === item.id && field.field === "fullName" && field.status === "confirmed" && field.evidence.length && field.evidence.every((proof) => fresh(item, proof))));
  const unsupportedBasis = new Map<string, EvidenceExcerpt>();
  if (registryBasis.length) {
    let registry;
    try { registry = extractStaffCertificateFacts(sources); }
    catch { return stop("quarantine-registry-failed", "Повторная проверка владельцев сертификатов не завершилась. Все выбранные поля сохранены для ручной проверки."); }
    if (registry.limited) return stop("quarantine-registry-limit", "Повторный разбор реестра сертификатов достиг предела. Вся операция исключения полей отменена без частичных изменений; разделите материалы или проверьте их вручную.");
    const ownerKey = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/\s+/gu, " ").trim();
    for (const item of registryBasis) {
      const document = registry.documents.find((entry) => item.sourceIds.includes(entry.sourceId) && ownerKey(entry.ownerFullName) === ownerKey(String(item.fields.fullName)));
      if (!document) continue;
      const source = sourceMap.get(document.sourceId), fragment = source?.fragments?.find((entry) => entry.id === document.fragmentId);
      if (!source || !fragment) continue;
      const proof: EvidenceExcerpt = { sourceId: source.id, sourceName: source.name, fragmentId: fragment.id, locator: fragment.locator, quote: document.quote };
      if (fresh(item, proof)) unsupportedBasis.set(item.id, proof);
    }
  }
  const result = unchanged();
  for (const [index, item] of items.entries()) {
    const removed = new Set<string>();
    for (const field of [...new Set(item.selectedFields)]) {
      if (!allowed[item.destination]?.has(field)) continue;
      const status = audit.fields.find((entry) => entry.itemId === item.id && entry.field === field && entry.status === "conflict");
      // Ownership context is not a substitute for an excluded/hidden value
      // quote. Require the whole returned proof set to remain current/visible.
      const absentBasisProof = field === "basis" ? unsupportedBasis.get(item.id) : undefined;
      const proof = status?.evidence.length && status.evidence.every((entry) => fresh(item, entry)) ? status.evidence[0] : absentBasisProof;
      if (!proof) continue;
      removed.add(field);
      result.changes.push({ ...proof, itemId: item.id, field, kind: "quarantined", previousValue: item.fields[field], requiresReview: true });
      if (absentBasisProof) result.skipped.push({ ...absentBasisProof, itemId: item.id, field: "basis", reason: "staff-basis-unverified", message: "Основание сотрудничества не подтверждено выбранным реестром сертификатов и исключено из передачи. Эта строка подтверждает ФИО и сертификат, но не подтверждает трудовые отношения. Исходное значение оставлено в поле без отметки; проверьте отдельный документ, прежде чем выбирать основание снова.", requiresReview: true });
    }
    if (removed.size) result.items[index] = { ...item, selectedFields: item.selectedFields.filter((field) => !removed.has(field)) };
    if (result.changes.length + result.skipped.length > 500) return stop("quarantine-result-limit", "Обнаружено слишком много противоречий или сведений для проверки. Вся операция отменена без частичного исключения полей; разделите материалы.");
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 8 * 1024 * 1024) return stop("quarantine-result-limit", "Результат проверки слишком велик. Вся операция отменена без усечения исходных значений и цитат.");
  return result;
}
