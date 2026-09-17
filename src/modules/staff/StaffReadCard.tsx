import type { StoredRecord } from "../../lib/storage";
import { ReadAttachment, ReadFields, RegistryReadCard } from "../contracts/RegistryReadCard";
import { staffAssignments, type StaffData } from "./types";
import { staffAttachmentSummary, staffRequirements } from "./requirements";

export function StaffReadCard({ record, onClose }: { record: StoredRecord<StaffData>; onClose: () => void }) {
  const item = record.payload;
  const completeness = staffRequirements(item);
  const labels: Record<Exclude<keyof StaffData, "organizationalAssignments" | "documents">, string> = {
    fullName: "ФИО", birthDate: "Дата рождения", role: "Роль", grade: "Грейд", skills: "Навыки", qualification: "Квалификация", primarySpecialization: "Основная специализация", additionalSpecializations: "Другие специализации", competencies: "Компетенции", industries: "Отрасли", location: "Локация", travelReadiness: "Готовность к командировкам", basis: "Основное основание", basisOther: "Другое основание", basisNumber: "Номер основания", startDate: "Начало", endDate: "Окончание", status: "Статус", phone: "Телефон", email: "Email", experienceYears: "Стаж, лет", experienceNotes: "Опыт работы", availableFrom: "Доступен с", availableTo: "Доступен по", hourlyRate: "Ставка, ₽/ч", disclosureAllowed: "Разрешено раскрытие для заявки", notes: "Примечания",
  };
  return <RegistryReadCard title={item.fullName} module="staff" record={record} onClose={onClose}>
    <p className="notice">Полнота карточки: {completeness.met} из {completeness.total}. {staffAttachmentSummary(completeness.files).label}. Это не проверка соответствия конкретной закупке.</p>
    {completeness.missing.length > 0 && <p>Не заполнено: {completeness.missing.join(", ")}.</p>}
    <ReadFields fields={Object.entries(labels).map(([key, label]) => [label, item[key as keyof StaffData]])} />
    <h3>Места работы</h3>{staffAssignments(item).map((entry) => <ReadFields key={entry.id} fields={[["Юрлицо", entry.legalEntity], ["Отдел", entry.department], ["Должность", entry.position], ["Основание", entry.engagementType], ["Пояснение", entry.engagementOther], ["Номер основания", entry.basisNumber], ["Статус", entry.status], ["Начало", entry.startDate], ["Окончание", entry.endDate], ["Основное место", entry.isPrimary], ["Примечания", entry.notes]]} />)}
    <h3>Документы ({item.documents.length})</h3>{!item.documents.length && <p>Документы не добавлены.</p>}{item.documents.map((document) => <section className="registry-read-document" key={document.id}><ReadFields fields={[["Раздел", ({ education: "Образование", certificate: "Сертификат", contract: "Договор", permit: "Допуск", other: "Прочее" })[document.category]], ["Вид", document.type], ["Название", document.name], ["Серия и номер", document.seriesNumber], ["Кем выдан", document.issuer], ["Дата выдачи", document.issuedDate], ["Действует до", document.unlimited ? "Бессрочно" : document.expiresDate], ["Комментарий", document.comment]]} /><ReadAttachment {...document} /></section>)}
  </RegistryReadCard>;
}
