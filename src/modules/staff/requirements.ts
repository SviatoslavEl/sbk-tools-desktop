import { primaryAssignment, type StaffData, type StaffDocument } from "./types";

export type ExpiryCategory = "expired" | "expiring" | "valid" | "unlimited" | "missing";

const dayStart = (value = new Date()) => new Date(value.getFullYear(), value.getMonth(), value.getDate());

export function documentExpiry(document: StaffDocument, warningDays: number, now = new Date()): ExpiryCategory {
  if (document.unlimited) return "unlimited";
  if (!document.expiresDate) return "missing";
  const today = dayStart(now);
  const expires = new Date(`${document.expiresDate}T23:59:59`);
  if (expires < today) return "expired";
  return expires <= new Date(today.getTime() + warningDays * 86_400_000) ? "expiring" : "valid";
}

export function urgentDocument(documents: StaffDocument[], warningDays: number, now = new Date()) {
  const ranked = documents.map((document) => ({ document, category: documentExpiry(document, warningDays, now) }))
    .filter(({ category }) => category === "expired" || category === "expiring")
    .sort((left, right) => (left.document.expiresDate || "9999").localeCompare(right.document.expiresDate || "9999"));
  return ranked[0] ?? null;
}

export function staffRequirements(item: StaffData, warningDays = 60, now = new Date()) {
  const assignment = primaryAssignment(item);
  const requiredCategories: StaffDocument["category"][] = assignment.engagementType === "Штат" ? ["education", "contract"] : ["education", "contract", "certificate"];
  const checks = [
    { label: "ФИО", met: Boolean(item.fullName.trim()) },
    { label: "Должность или роль", met: Boolean(assignment.position.trim()) },
    { label: "Грейд", met: Boolean(item.grade?.trim()) },
    { label: "Навыки", met: Boolean(item.skills?.length) },
    { label: "Основание сотрудничества", met: Boolean(assignment.engagementType && (assignment.engagementType !== "Иное" || assignment.engagementOther.trim())) },
    { label: "Дата начала", met: Boolean(assignment.startDate) },
    { label: "Квалификация", met: Boolean(item.qualification.trim()) },
    ...requiredCategories.map((category) => ({ label: { education: "Диплом", contract: "Документ-основание", certificate: "Действующий сертификат", permit: "Допуск", other: "Документ" }[category], met: item.documents.some((document) => document.category === category && Boolean(document.name || document.type) && !["expired", "missing"].includes(documentExpiry(document, warningDays, now))) })),
  ];
  const met = checks.filter((check) => check.met).length;
  const missing = checks.filter((check) => !check.met).map((check) => check.label);
  const files = {
    attached: item.documents.filter((document) => Boolean(document.relativePath?.trim())).length,
    total: item.documents.length,
    missing: item.documents.filter((document) => !document.relativePath?.trim()).map((document) => document.name || document.type || "Документ без названия"),
  };
  // This is descriptive completeness, never a qualification/award decision.
  // Metadata and attached evidence remain separate; no legacy data is rewritten.
  return { met, total: checks.length, missing, ready: missing.length === 0, checks, files };
}

export function staffAttachmentSummary(files: { attached: number; total: number; missing: string[] }) {
  if (files.total === 0) return { label: "Документы не добавлены", title: "В карточке пока нет сведений о документах и подтверждающих файлов." };
  return {
    label: `Файлы: ${files.attached} из ${files.total}`,
    title: files.missing.length ? `Без файла: ${files.missing.join(", ")}` : "Все перечисленные документы имеют вложение; содержание не проверено",
  };
}
