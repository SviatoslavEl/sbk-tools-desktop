export const tenderComplexities = ["Низкая", "Средняя", "Высокая", "Экспертная"] as const;
export const preparationStatuses = ["Не начата", "В работе", "На проверке", "Готова", "Подана", "Приостановлена"] as const;
export const assignmentRoles = ["Руководитель заявки", "Менеджер", "Специалист", "Проверяющий"] as const;

export type TenderComplexity = typeof tenderComplexities[number];
export type PreparationStatus = typeof preparationStatuses[number];
export type AssignmentRole = typeof assignmentRoles[number];

export interface TenderAssignment {
  id: string;
  staffId: string;
  role: AssignmentRole;
  startDate: string;
  endDate: string;
  plannedHours: number;
  comment: string;
}

export interface TenderMilestone {
  id: string;
  title: string;
  dueDate: string;
  responsibleStaffId: string;
  done: boolean;
}

export interface TenderScheduleData {
  schemaVersion: 2;
  source: "procurement" | "manual";
  procurementId: string;
  procurementTitle: string;
  customer: string;
  preparationStart: string;
  submissionDeadline: string;
  internalDeadline: string;
  complexity: TenderComplexity;
  priority: "Обычный" | "Высокий" | "Критический";
  status: PreparationStatus;
  estimatedHours: number;
  requiredSkills: string[];
  assignments: TenderAssignment[];
  milestones: TenderMilestone[];
  notes: string;
}

const id = () => crypto.randomUUID();

export const emptyAssignment = (): TenderAssignment => ({
  id: id(), staffId: "", role: "Менеджер", startDate: "", endDate: "", plannedHours: 16, comment: "",
});

export const emptyMilestone = (): TenderMilestone => ({
  id: id(), title: "", dueDate: "", responsibleStaffId: "", done: false,
});

export const emptyTenderSchedule = (): TenderScheduleData => ({
  schemaVersion: 2,
  source: "manual",
  procurementId: "",
  procurementTitle: "",
  customer: "",
  preparationStart: new Date().toISOString().slice(0, 10),
  submissionDeadline: "",
  internalDeadline: "",
  complexity: "Средняя",
  priority: "Обычный",
  status: "Не начата",
  estimatedHours: 40,
  requiredSkills: [],
  assignments: [],
  milestones: [],
  notes: "",
});
