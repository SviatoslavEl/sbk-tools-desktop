export const cooperationBases = ["Трудовой договор", "Штат", "Внешнее совместительство", "Внутреннее совместительство", "ГПХ", "ИП", "Самозанятый", "Подрядная организация", "Привлечённый специалист", "Иное"] as const;
export const workStatuses = ["Работает", "Временно не работает", "Сотрудничество завершено", "Кандидат", "Не указано"] as const;

export interface OrganizationalAssignment {
  id: string;
  legalEntity: string;
  department: string;
  position: string;
  engagementType: typeof cooperationBases[number];
  engagementOther: string;
  status: typeof workStatuses[number];
  basisNumber: string;
  startDate: string;
  endDate: string;
  isPrimary: boolean;
  notes: string;
}

export interface StaffDocument {
  id: string;
  category: "education" | "certificate" | "contract" | "permit" | "other";
  type: string;
  name: string;
  seriesNumber: string;
  issuer: string;
  issuedDate: string;
  expiresDate: string;
  unlimited: boolean;
  relativePath?: string;
  fileName?: string;
  sizeBytes?: number;
  sha256?: string;
  mimeType?: string;
  comment: string;
}

export interface StaffData {
  fullName: string;
  birthDate: string;
  role: string;
  grade: string;
  skills: string[];
  qualification: string;
  primarySpecialization: string;
  additionalSpecializations: string[];
  competencies: string[];
  industries: string[];
  location: string;
  travelReadiness: string;
  organizationalAssignments: OrganizationalAssignment[];
  basis: typeof cooperationBases[number];
  basisOther: string;
  basisNumber: string;
  startDate: string;
  endDate: string;
  status: typeof workStatuses[number];
  phone: string;
  email: string;
  experienceYears: number;
  experienceNotes: string;
  availableFrom: string;
  availableTo: string;
  hourlyRate: number;
  disclosureAllowed: boolean;
  documents: StaffDocument[];
  notes: string;
}

export const emptyStaffDocument = (category: StaffDocument["category"] = "certificate"): StaffDocument => ({
  id: crypto.randomUUID(), category, type: "", name: "", seriesNumber: "", issuer: "", issuedDate: "", expiresDate: "", unlimited: false, comment: "",
});

export const emptyOrganizationalAssignment = (): OrganizationalAssignment => ({
  id: crypto.randomUUID(), legalEntity: "", department: "", position: "", engagementType: "Трудовой договор", engagementOther: "", status: "Не указано", basisNumber: "", startDate: "", endDate: "", isPrimary: true, notes: "",
});

export function staffAssignments(item: StaffData): OrganizationalAssignment[] {
  if (item.organizationalAssignments?.length) return item.organizationalAssignments;
  return [{ ...emptyOrganizationalAssignment(), position: item.role || "", engagementType: item.basis || "Трудовой договор", engagementOther: item.basisOther || "", status: item.status || "Не указано", basisNumber: item.basisNumber || "", startDate: item.startDate || "", endDate: item.endDate || "" }];
}

export function primaryAssignment(item: StaffData): OrganizationalAssignment {
  const assignments = staffAssignments(item);
  return assignments.find((entry) => entry.isPrimary) || assignments[0];
}

export const emptyStaff = (): StaffData => ({
  fullName: "", birthDate: "", role: "", grade: "", skills: [], qualification: "", primarySpecialization: "", additionalSpecializations: [], competencies: [], industries: [], location: "", travelReadiness: "", organizationalAssignments: [], basis: "Трудовой договор", basisOther: "", basisNumber: "", startDate: "", endDate: "", status: "Не указано", phone: "", email: "", experienceYears: 0, experienceNotes: "", availableFrom: "", availableTo: "", hourlyRate: 0, disclosureAllowed: false, documents: [], notes: "",
});
