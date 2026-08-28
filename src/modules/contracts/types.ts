export const contractStages = ["Подготовка", "Заключён", "Исполняется", "Выполнен", "Приостановлен", "Расторгнут", "Закрыт"] as const;
export const paymentStatuses = ["Не указано", "Не выставлено", "Ожидается", "Частично оплачено", "Полностью оплачено", "Просрочено", "Не применяется"] as const;
export const actsStatuses = ["Не указано", "Не требуются", "Не подготовлены", "Подготовлены", "Направлены", "Подписаны частично", "Подписаны полностью", "Есть замечания"] as const;

export interface ContractDocument {
  id: string;
  type: "Договор" | "Акт" | "Отзыв" | "Сертификат" | "Иное";
  name: string;
  relativePath?: string;
  fileName?: string;
  sizeBytes?: number;
  sha256?: string;
  mimeType?: string;
  comment: string;
}

export interface ContractData {
  performingLegalEntityId: string;
  performingLegalEntity: string;
  number: string;
  date: string;
  customer: string;
  customerCompanyId: string;
  subject: string;
  industry: string;
  serviceType: string;
  standards: string[];
  workScope: string;
  contractRole: string;
  amount: number;
  ourShareAmount: number;
  startDate: string;
  endDate: string;
  stage: typeof contractStages[number];
  paymentStatus: typeof paymentStatuses[number];
  actsStatus: typeof actsStatuses[number];
  paidAmount: number;
  paymentPlannedDate: string;
  paymentActualDate: string;
  nextImportantDate: string;
  responsible: string;
  contact: string;
  reviewAvailable: boolean;
  disclosureAllowed: boolean;
  discloseCustomer: boolean;
  discloseNumber: boolean;
  discloseSubject: boolean;
  discloseAmount: boolean;
  documents: ContractDocument[];
  notes: string;
}

export const emptyContractDocument = (): ContractDocument => ({
  id: crypto.randomUUID(), type: "Договор", name: "", comment: "",
});

export const emptyContract = (): ContractData => ({
  performingLegalEntityId: "",
  performingLegalEntity: "",
  number: "",
  date: new Date().toISOString().slice(0, 10),
  customer: "",
  customerCompanyId: "",
  subject: "", industry: "", serviceType: "", standards: [], workScope: "", contractRole: "Генеральный подрядчик",
  amount: 0,
  ourShareAmount: 0,
  startDate: "",
  endDate: "",
  stage: "Подготовка",
  paymentStatus: "Не выставлено",
  actsStatus: "Не подготовлены",
  paidAmount: 0,
  paymentPlannedDate: "",
  paymentActualDate: "",
  nextImportantDate: "",
  responsible: "",
  contact: "", reviewAvailable: false, disclosureAllowed: false, discloseCustomer: false, discloseNumber: false, discloseSubject: false, discloseAmount: false, documents: [],
  notes: "",
});
