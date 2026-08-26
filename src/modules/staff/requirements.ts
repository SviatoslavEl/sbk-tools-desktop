import type { StaffData, StaffDocument } from "./types";

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
  const requiredCategories: StaffDocument["category"][] = item.basis === "Штат" ? ["education", "contract"] : ["education", "contract", "certificate"];
  const checks = [
    { label: "ФИО", met: Boolean(item.fullName.trim()) },
    { label: "Должность или роль", met: Boolean(item.role.trim()) },
    { label: "Грейд", met: Boolean(item.grade?.trim()) },
    { label: "Навыки", met: Boolean(item.skills?.length) },
    { label: "Основание сотрудничества", met: Boolean(item.basis && (item.basis !== "Иное" || item.basisOther.trim())) },
    { label: "Дата начала", met: Boolean(item.startDate) },
    { label: "Квалификация", met: Boolean(item.qualification.trim()) },
    ...requiredCategories.map((category) => ({ label: { education: "Диплом", contract: "Документ-основание", certificate: "Действующий сертификат", permit: "Допуск", other: "Документ" }[category], met: item.documents.some((document) => document.category === category && Boolean(document.name || document.type) && !["expired", "missing"].includes(documentExpiry(document, warningDays, now))) })),
  ];
  const met = checks.filter((check) => check.met).length;
  const missing = checks.filter((check) => !check.met).map((check) => check.label);
  return { met, total: checks.length, missing, ready: missing.length === 0 };
}
