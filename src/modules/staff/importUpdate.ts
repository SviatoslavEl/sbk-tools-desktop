import type { StaffImportMapping } from "./import";
import { primaryAssignment, type StaffData, type StaffDocument } from "./types";

const normalizedDocumentName = (value: string) => value.trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/gu, " ");
const blank = (value: unknown) => typeof value === "string" ? !value.trim() : Array.isArray(value) ? value.length === 0 : value == null;
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

/** An update is additive: missing/blank cells and document lists never mean deletion. */
export function mergeImportedStaffData(previous: StaffData, imported: StaffData, mapping: StaffImportMapping, sourceRow?: readonly string[]): StaffData {
  const next = structuredClone(previous);
  const supplied = (field: keyof StaffImportMapping, value: unknown) => mapping[field] >= 0
    && (sourceRow ? Boolean(sourceRow[mapping[field]]?.trim()) : !blank(value));
  const copy = <K extends keyof StaffData>(field: keyof StaffImportMapping, key: K) => {
    if (supplied(field, imported[key]) && !blank(imported[key])) next[key] = structuredClone(imported[key]);
  };
  copy("fullName", "fullName"); copy("birthDate", "birthDate"); copy("role", "role"); copy("grade", "grade");
  copy("primarySpecialization", "primarySpecialization"); copy("additionalSpecializations", "additionalSpecializations"); copy("competencies", "competencies"); copy("industries", "industries");
  if (["skills", "additionalSpecializations", "competencies"].some((field) => supplied(field as keyof StaffImportMapping, imported.skills))) next.skills = [...new Set([...(next.skills || []), ...imported.skills])];
  copy("qualification", "qualification"); copy("location", "location"); copy("travelReadiness", "travelReadiness");
  copy("phone", "phone"); copy("email", "email");
  if (supplied("contacts", imported.phone || imported.email)) {
    if (imported.phone.trim()) next.phone = imported.phone;
    if (imported.email.trim()) next.email = imported.email;
  }
  copy("experienceYears", "experienceYears"); copy("experienceText", "experienceNotes"); copy("availableFrom", "availableFrom"); copy("availableTo", "availableTo");
  copy("hourlyRate", "hourlyRate"); copy("disclosureAllowed", "disclosureAllowed"); copy("notes", "notes");
  const assignmentFields: Array<keyof StaffImportMapping> = ["legalEntity", "department", "role", "basis", "basisOther", "basisNumber", "startDate", "endDate", "status"];
  if (assignmentFields.some((field) => mapping[field] >= 0)) {
    const current = primaryAssignment(next);
    const incoming = primaryAssignment(imported);
    const assignment = { ...current };
    const copyAssignment = (field: keyof StaffImportMapping, key: keyof typeof assignment) => {
      if (supplied(field, incoming[key]) && !blank(incoming[key])) assignment[key] = incoming[key] as never;
    };
    copyAssignment("legalEntity", "legalEntity"); copyAssignment("department", "department"); copyAssignment("role", "position"); copyAssignment("basis", "engagementType"); copyAssignment("basisOther", "engagementOther"); copyAssignment("basisNumber", "basisNumber"); copyAssignment("startDate", "startDate"); copyAssignment("endDate", "endDate"); copyAssignment("status", "status");
    next.organizationalAssignments = [assignment, ...(next.organizationalAssignments || []).filter((item) => item.id !== current.id)];
    next.basis = assignment.engagementType; next.basisOther = assignment.engagementOther; next.basisNumber = assignment.basisNumber; next.startDate = assignment.startDate; next.endDate = assignment.endDate; next.status = assignment.status;
  }

  const incomingCertificates = imported.documents.filter((document) => document.category === "certificate");
  if (mapping.certificateStatuses >= 0 && mapping.certificates < 0
    && (!sourceRow || Boolean(sourceRow[mapping.certificateStatuses]?.trim()))) {
    throw new Error("Для обновления сроков сертификатов нужна колонка с их названиями. Сроки не сопоставляются по порядку существующих документов.");
  }
  // Refuse unmatched positional lists rather than silently applying a date to
  // another certificate. Empty statuses still mean 'leave unchanged'.
  if (sourceRow && mapping.certificates >= 0 && mapping.certificateStatuses >= 0) {
    const statuses = (sourceRow[mapping.certificateStatuses] || "").split(/\r?\n|;/).map((value) => value.trim()).filter(Boolean);
    if (statuses.length && statuses.length !== incomingCertificates.length) throw new Error("Количество сроков не совпадает с количеством сертификатов. Укажите срок для каждого названия в том же порядке либо не импортируйте колонку сроков.");
  }
  const relevant = imported.documents.filter((document) =>
    (document.category === "certificate" && mapping.certificates >= 0)
    || (document.category === "education" && mapping.education >= 0));
  const seen = new Map<string, StaffDocument>();
  next.documents = structuredClone(previous.documents || []);
  for (const document of relevant) {
    const name = normalizedDocumentName(document.name);
    if (!name) continue;
    const key = `${document.category}:${name}`;
    const earlier = seen.get(key);
    if (earlier) {
      if (earlier.expiresDate !== document.expiresDate || earlier.unlimited !== document.unlimited || earlier.comment !== document.comment) throw new Error(`В файле несколько разных сроков для документа «${document.name}». Уточните названия или исправьте дубли.`);
      continue;
    }
    seen.set(key, document);
    const matches = next.documents.filter((entry) => entry.category === document.category && normalizedDocumentName(entry.name) === name);
    if (matches.length > 1) throw new Error(`Документ «${document.name}» неоднозначен: в карточке ${matches.length} одноимённых документов. Уточните названия в карточке или исключите эту колонку из обновления.`);
    const certificateStatusProvided = document.category === "certificate" && mapping.certificateStatuses >= 0
      && Boolean(document.comment.trim()) && document.comment !== "Срок действия не указан";
    if (certificateStatusProvided && !document.unlimited && !validDate(document.expiresDate)) throw new Error(`Не удалось распознать срок сертификата «${document.name}»: «${document.comment}». Укажите существующую дату, год или «бессрочно».`);
    if (!matches.length) {
      next.documents.push(structuredClone(document));
      continue;
    }
    const previousDocument = matches[0];
    // Identity, file and all manual metadata remain intact; only an explicitly
    // provided validity value is changed for a matched certificate.
    const merged = certificateStatusProvided ? { ...previousDocument, expiresDate: document.expiresDate, unlimited: document.unlimited } : previousDocument;
    next.documents = next.documents.map((entry) => entry.id === previousDocument.id ? merged : entry);
  }
  return next;
}
