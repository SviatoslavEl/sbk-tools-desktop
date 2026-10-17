import { emptyStaffDocument, type StaffDocument } from "../staff/types";
import { extractStaffCertificateFacts } from "./sourceStaffCertificates";
import type { IntelligenceItem, IntelligenceSource, IntelligenceStaffDocument } from "./workbenchTypes";

const metadataKeys: ReadonlyArray<keyof IntelligenceStaffDocument> = ["id", "ownerFullName", "category", "name", "seriesNumber", "examDate", "reportedValidity", "sourceId", "fragmentId", "headerFragmentId", "quote", "headerQuote"];
const ownerKey = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/\s+/gu, " ").trim();
const stale = () => new Error("Сведения о сертификатах не подтверждены текущими выбранными материалами или владельцем карточки. Повторите подготовку результата; номера, даты экзамена и статусы не перенесены по старым данным.");
const documentShape = (candidate: IntelligenceStaffDocument) => Boolean(candidate && typeof candidate === "object" && !Array.isArray(candidate)
  && Object.keys(candidate).length === metadataKeys.length && metadataKeys.every((key) => Object.prototype.hasOwnProperty.call(candidate, key) && typeof candidate[key] === "string") && candidate.category === "certificate");
const sameDocument = (candidate: IntelligenceStaffDocument, fresh: IntelligenceStaffDocument) => documentShape(candidate) && metadataKeys.every((key) => candidate[key] === fresh[key]);

/** Metadata is a source-owned candidate, never persisted proof. Re-extract the
 * current selected snapshot before creating unsaved receiving documents. */
export function staffCertificateHandoffDocuments(item: IntelligenceItem, sources: readonly IntelligenceSource[], provenance: string): StaffDocument[] {
  if (item.destination !== "staff" || !item.selectedFields.includes("certificates")) return [];
  const names = Array.isArray(item.fields.certificates) ? item.fields.certificates : [];
  const metadata = item.staffDocuments;
  if (metadata === undefined || Array.isArray(metadata) && !metadata.length) return names.map((name) => ({ ...emptyStaffDocument("certificate"), name, comment: provenance }));
  if (!Array.isArray(metadata) || metadata.length > 100 || metadata.some((entry) => !documentShape(entry)) || new Set(metadata.map((entry) => entry.id)).size !== metadata.length) throw stale();
  const selectedNames = new Set(names);
  const fresh = extractStaffCertificateFacts(sources);
  if (fresh.limited) throw stale();
  // Removing a name from the selected list removes its metadata from this
  // handoff, but cannot silently transfer it to another certificate or owner.
  const requested = metadata.filter((entry) => selectedNames.has(entry.name) || fresh.documents.some((document) => document.id === entry.id && selectedNames.has(document.name)));
  if (!requested.length) return names.map((name) => ({ ...emptyStaffDocument("certificate"), name, comment: provenance }));
  const fullName = item.selectedFields.includes("fullName") && typeof item.fields.fullName === "string" ? ownerKey(item.fields.fullName) : "";
  if (!fullName) throw stale();
  const verified = requested.map((candidate) => {
    const matches = fresh.documents.filter((document) => document.id === candidate.id && sameDocument(candidate, document));
    if (matches.length !== 1 || !item.sourceIds.includes(candidate.sourceId) || ownerKey(candidate.ownerFullName) !== fullName
      || candidate.category !== "certificate" || candidate.reportedValidity !== "Да" && candidate.reportedValidity !== "Нет") throw stale();
    return matches[0];
  });
  const enrichedNames = new Set(verified.map((document) => document.name));
  for (const name of enrichedNames) {
    const expected = fresh.documents.filter((document) => document.name === name && ownerKey(document.ownerFullName) === fullName && item.sourceIds.includes(document.sourceId));
    const ids = new Set(verified.filter((document) => document.name === name).map((document) => document.id));
    if (expected.length !== ids.size || expected.some((document) => !ids.has(document.id))) throw new Error("Состав сертификатов изменился: не все отдельные записи с выбранным названием подтверждены подготовленными метаданными. Повторите подготовку результата; разные номера не объединяются в один документ.");
  }
  return [
    ...verified.map((document) => ({ ...emptyStaffDocument("certificate"), type: "Сертификат", name: document.name, seriesNumber: document.seriesNumber,
      examDate: document.examDate, reportedValidity: document.reportedValidity as "Да" | "Нет", comment: provenance })),
    ...names.filter((name) => !enrichedNames.has(name)).map((name) => ({ ...emptyStaffDocument("certificate"), name, comment: provenance })),
  ];
}
