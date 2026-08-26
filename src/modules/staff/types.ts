export const cooperationBases = ["Штат", "Внешнее совместительство", "Внутреннее совместительство", "ГПХ", "ИП", "Самозанятый", "Подрядная организация", "Привлечённый специалист", "Иное"] as const;
export const workStatuses = ["Работает", "Временно не работает", "Сотрудничество завершено", "Кандидат"] as const;

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
  qualification: string;
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
  documents: StaffDocument[];
  notes: string;
}

export const emptyStaffDocument = (category: StaffDocument["category"] = "certificate"): StaffDocument => ({
  id: crypto.randomUUID(), category, type: "", name: "", seriesNumber: "", issuer: "", issuedDate: "", expiresDate: "", unlimited: false, comment: "",
});

export const emptyStaff = (): StaffData => ({
  fullName: "", birthDate: "", role: "", qualification: "", basis: "Штат", basisOther: "", basisNumber: "", startDate: "", endDate: "", status: "Работает", phone: "", email: "", experienceYears: 0, experienceNotes: "", documents: [], notes: "",
});
