import { primaryAssignment, staffAssignments, type StaffData, type StaffDocument } from "./types";

export interface StaffSelectionCriteria {
  procurementTitle: string;
  keywords: string;
  legalEntity: string;
  department: string;
  position: string;
  status: StaffData["status"] | "";
  minExperienceYears: number;
  maxHourlyRate: number;
  location: string;
  travelRequired: boolean;
  availableFrom: string;
  availableTo: string;
  validDocumentsOnly: boolean;
  disclosureOnly: boolean;
  certificateMode?: "" | "any" | "valid";
  certificateQuery?: string;
  educationRequired?: boolean;
  educationQuery?: string;
  cooperationMode?: "" | "part-time" | "Внутреннее совместительство" | "Внешнее совместительство";
}

export interface StaffMatch { score: number; reasons: string[]; assignmentId?: string }

const genericStems = ["оказан", "услуг", "выполнен", "работ", "закуп", "договор", "постав", "провед", "организац"];
const words = (value: string) => [...new Set((value.toLowerCase().match(/[a-zа-яё0-9-]+/gi) || [])
  .filter((word) => word.length >= 3 && !genericStems.some((stem) => word.startsWith(stem))))];

export function staffDocumentsValid(item: StaffData, today = new Date().toISOString().slice(0, 10)): boolean {
  return item.documents.length > 0 && item.documents.every((document) => {
    if (document.unlimited) return true;
    if (document.category === "certificate" || document.category === "permit") return Boolean(document.expiresDate && document.expiresDate >= today);
    return !document.expiresDate || document.expiresDate >= today;
  });
}

function documentMatches(document: StaffDocument, query = ""): boolean {
  if (!query.trim()) return true;
  const searchable = [document.type, document.name, document.seriesNumber, document.issuer, document.comment]
    .join(" ")
    .toLowerCase();
  return words(query).every((word) => searchable.includes(word));
}

function documentIsValid(document: StaffDocument, today: string): boolean {
  return document.unlimited || Boolean(document.expiresDate && document.expiresDate >= today);
}

export function travelReady(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "нет" || /не\s+готов|невозмож|без\s+командиров|командиров\S*\s+нет/u.test(normalized)) return false;
  return /да|готов|люб|возмож/u.test(normalized);
}

export function matchStaff(item: StaffData, criteria: StaffSelectionCriteria, today?: string): StaffMatch {
  const effectiveToday = today || new Date().toISOString().slice(0, 10);
  const certificateQuery = criteria.certificateQuery || "";
  const educationQuery = criteria.educationQuery || "";
  const reasons: string[] = [];
  let score = 0;
  const assignments = staffAssignments(item);
  const primary = primaryAssignment(item);
  const matchingAssignments = assignments.filter((entry) =>
    (!criteria.legalEntity || entry.legalEntity === criteria.legalEntity)
    && (!criteria.department || entry.department === criteria.department)
    && (!criteria.position || entry.position === criteria.position)
    && (!criteria.status || entry.status === criteria.status)
    && (!criteria.cooperationMode
      || (criteria.cooperationMode === "part-time"
        ? ["Внутреннее совместительство", "Внешнее совместительство"].includes(entry.engagementType)
        : entry.engagementType === criteria.cooperationMode)));
  if ((criteria.legalEntity || criteria.department || criteria.position || criteria.status || criteria.cooperationMode) && !matchingAssignments.length) return { score: 0, reasons: [] };
  const matchedAssignment = matchingAssignments[0] || primary;
  if (item.experienceYears < criteria.minExperienceYears) return { score: 0, reasons: [] };
  if (criteria.maxHourlyRate > 0 && item.hourlyRate > criteria.maxHourlyRate) return { score: 0, reasons: [] };
  if (criteria.location && item.location !== criteria.location) return { score: 0, reasons: [] };
  if (criteria.travelRequired && !travelReady(item.travelReadiness)) return { score: 0, reasons: [] };
  if (criteria.availableFrom && item.availableFrom && item.availableFrom > criteria.availableFrom) return { score: 0, reasons: [] };
  if (criteria.availableTo && item.availableTo && item.availableTo < criteria.availableTo) return { score: 0, reasons: [] };
  if (criteria.validDocumentsOnly && !staffDocumentsValid(item, effectiveToday)) return { score: 0, reasons: [] };
  if (criteria.disclosureOnly && !item.disclosureAllowed) return { score: 0, reasons: [] };
  const certificates = item.documents.filter((document) => document.category === "certificate" && documentMatches(document, certificateQuery));
  const education = item.documents.filter((document) => document.category === "education" && documentMatches(document, educationQuery));
  if (criteria.certificateMode === "any" && !certificates.length) return { score: 0, reasons: [] };
  if (criteria.certificateMode === "valid" && !certificates.some((document) => documentIsValid(document, effectiveToday))) return { score: 0, reasons: [] };
  if (certificateQuery.trim() && !certificates.length) return { score: 0, reasons: [] };
  if ((criteria.educationRequired || educationQuery.trim()) && !education.length) return { score: 0, reasons: [] };

  const required = words(`${criteria.procurementTitle} ${criteria.keywords}`);
  const searchable = [...assignments.map((entry) => entry.position), primary.position, item.role, item.grade, item.primarySpecialization, item.qualification, item.experienceNotes, ...(item.additionalSpecializations || []), ...(item.competencies || []), ...(item.industries || []), ...(item.skills || [])].join(" ").toLowerCase();
  const matched = required.filter((word) => searchable.includes(word));
  if (required.length && !matched.length) return { score: 0, reasons: [] };
  if (matched.length) { score += Math.min(55, matched.length * 11); reasons.push(`Совпадают: ${matched.join(", ")}`); }
  if (item.experienceYears > 0) { score += Math.min(15, item.experienceYears); reasons.push(`Стаж ${item.experienceYears} лет`); }
  if (!item.availableFrom || !criteria.availableFrom || item.availableFrom <= criteria.availableFrom) { score += 8; reasons.push("Доступен к началу работ"); }
  if (!item.availableTo || !criteria.availableTo || item.availableTo >= criteria.availableTo) score += 7;
  if (staffDocumentsValid(item, effectiveToday)) { score += 8; reasons.push("Документы действуют"); }
  if (certificates.length) { score += 4; reasons.push(criteria.certificateMode === "valid" ? "Есть действующий сертификат" : "Есть сертификаты"); }
  if (education.length) { score += 4; reasons.push("Есть образование"); }
  if (criteria.cooperationMode) reasons.push(`Основание: ${matchedAssignment.engagementType}`);
  if (item.disclosureAllowed) { score += 7; reasons.push("Разрешено включать в заявку"); }
  return { score: Math.min(100, score), reasons, assignmentId: matchedAssignment.id };
}
