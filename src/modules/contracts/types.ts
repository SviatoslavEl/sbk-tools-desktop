export const contractStages = ["Подготовка", "Заключён", "Исполняется", "Выполнен", "Приостановлен", "Расторгнут", "Закрыт"] as const;
export const paymentStatuses = ["Не указано", "Не выставлено", "Ожидается", "Частично оплачено", "Полностью оплачено", "Просрочено", "Не применяется"] as const;
export const actsStatuses = ["Не указано", "Не требуются", "Не подготовлены", "Подготовлены", "Направлены", "Подписаны частично", "Подписаны полностью", "Есть замечания"] as const;

export interface ContractData {
  performingLegalEntity: string;
  number: string;
  date: string;
  customer: string;
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
  notes: string;
}

export const emptyContract = (): ContractData => ({
  performingLegalEntity: "",
  number: "",
  date: new Date().toISOString().slice(0, 10),
  customer: "",
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
  contact: "", reviewAvailable: false, disclosureAllowed: false, discloseCustomer: false, discloseNumber: false, discloseSubject: false, discloseAmount: false,
  notes: "",
});
