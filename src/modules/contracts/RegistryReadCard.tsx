import { useState, type ReactNode } from "react";
import { openPath } from "@tauri-apps/plugin-opener";
import { DrawerBackdrop } from "../../components/DrawerBackdrop";
import { VersionHistory } from "../../components/VersionHistory";
import { getWorkspaceInfo, type ModuleId, type StoredRecord } from "../../lib/storage";
import { WorkspaceAccessProvider } from "../../lib/workspaceAccess";
import type { ContractData } from "./types";
import type { CompanyCard } from "./companies";
import "./registry.css";

export function ReadFields({ fields }: { fields: Array<[string, unknown]> }) {
  return <dl className="registry-read-fields">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{typeof value === "boolean" ? value ? "Да" : "Нет" : Array.isArray(value) ? value.join(", ") || "—" : String(value ?? "") || "—"}</dd></div>)}</dl>;
}

export function ReadAttachment({ relativePath, fileName }: { relativePath?: string; fileName?: string }) {
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const open = async () => {
    if (!relativePath || opening) return;
    setOpening(true); setError("");
    try {
      const workspace = await getWorkspaceInfo();
      const separator = workspace.root.includes("\\") ? "\\" : "/";
      await openPath(`${workspace.root}${separator}${relativePath.replace(/\//g, separator)}`);
    } catch (reason) { setError(`Не удалось открыть вложение: ${String(reason)}`); }
    finally { setOpening(false); }
  };
  return <div data-workspace-viewer-allowed>{relativePath ? <button className="secondary small" type="button" disabled={opening} onClick={() => void open()}>{opening ? "Открываем…" : `Открыть ${fileName || "вложение"}`}</button> : <span className="help-text">Файл не приложен</span>}{error && <p className="field-error" role="alert">{error}</p>}</div>;
}

export function RegistryReadCard({ title, module, record, children, onClose }: { title: string; module: ModuleId; record: StoredRecord<unknown>; children: ReactNode; onClose: () => void }) {
  return <DrawerBackdrop onClose={onClose}><aside className="detail-drawer registry-read-card" role="dialog" aria-modal="true" aria-label={`Просмотр: ${title}`} data-workspace-viewer-allowed>
    <header><div><h2>{title}</h2><p>Просмотр карточки · вложения и история доступны без прав редактора</p></div><button className="icon-button" type="button" aria-label="Закрыть просмотр" onClick={onClose}>×</button></header>
    <div className="drawer-body">{children}<h3>История</h3><ReadFields fields={[["Создано", new Date(record.createdAt).toLocaleString("ru-RU")], ["Обновлено", new Date(record.updatedAt).toLocaleString("ru-RU")]]} /><WorkspaceAccessProvider editor={false} message="Карточка открыта для просмотра"><VersionHistory module={module} id={record.id} title={title} payload={record.payload} /></WorkspaceAccessProvider></div>
    <footer><button className="secondary" type="button" onClick={onClose}>Закрыть</button></footer>
  </aside></DrawerBackdrop>;
}

export function ContractReadCard({ record, onClose }: { record: StoredRecord<ContractData>; onClose: () => void }) {
  const item = record.payload;
  const labels: Record<Exclude<keyof ContractData, "documents" | "performingLegalEntityId" | "customerCompanyId">, string> = {
    performingLegalEntity: "Юрлицо-исполнитель", number: "Номер", date: "Дата", customer: "Заказчик", subject: "Предмет", industry: "Отрасль", serviceType: "Вид услуги", standards: "Стандарты", workScope: "Состав работ", contractRole: "Роль в договоре", amount: "Сумма, ₽", ourShareAmount: "Стоимость нашей части, ₽", startDate: "Начало", endDate: "Окончание", stage: "Стадия", paymentStatus: "Оплата", actsStatus: "Акты", paidAmount: "Оплачено, ₽", paymentPlannedDate: "Плановая дата оплаты", paymentActualDate: "Фактическая дата оплаты", nextImportantDate: "Ближайшая важная дата", responsible: "Ответственный", contact: "Дополнительные контакты", contactName: "Контактное лицо", contactPosition: "Должность контакта", contactPhone: "Телефон", contactEmail: "Email", reviewAvailable: "Есть отзыв", disclosureAllowed: "Раскрытие разрешено", discloseCustomer: "Разрешено раскрывать заказчика", discloseNumber: "Разрешено раскрывать номер", discloseSubject: "Разрешено раскрывать предмет", discloseAmount: "Разрешено раскрывать стоимость", notes: "Примечания",
  };
  return <RegistryReadCard title={`Договор ${item.number}`} module="contract-experience" record={record} onClose={onClose}>
    {!item.disclosureAllowed && <p className="notice warning">Запрещено раскрывать информацию. Справочная отметка — все сведения доступны внутри программы.</p>}
    <ReadFields fields={Object.entries(labels).map(([key, label]) => [label, item[key as keyof ContractData]])} />
    <h3>Документы ({item.documents.length})</h3>{!item.documents.length && <p>Документы не добавлены.</p>}{item.documents.map((document) => <section className="registry-read-document" key={document.id}><ReadFields fields={[["Вид", document.type], ["Название", document.name], ["Комментарий", document.comment]]} /><ReadAttachment {...document} /></section>)}
  </RegistryReadCard>;
}

export function CompanyReadCard({ company, companies, onClose }: { company: CompanyCard; companies: CompanyCard[]; onClose: () => void }) {
  return <RegistryReadCard title={company.name} module="contract-experience" record={{ id: `company:${company.id}`, title: company.name, payload: company, archived: company.archived, createdAt: company.createdAt, updatedAt: company.updatedAt }} onClose={onClose}>
    <ReadFields fields={[["Полное название", company.name], ["Краткое название", company.shortName], ["Раздел", company.scope === "internal" ? "Внутренние" : "Внешние"], ["Архивная карточка", company.archived], ["ИНН", company.inn], ["КПП", company.kpp], ["ОГРН", company.ogrn], ["Адрес", company.address], ["Контакты", company.contact], ["Примечания", company.notes]]} />
    <h3>Лица, принимающие решения</h3>{!company.decisionMakers.length && <p>Не указаны.</p>}{company.decisionMakers.map((person) => <ReadFields key={person.id} fields={[["ФИО", person.fullName], ["Должность", person.position], ["Отдел", person.department], ["Основной контакт", person.isPrimary], ["Телефон", person.phone], ["Email", person.email], ["Примечания", person.notes]]} />)}
    <h3>Подписанты по доверенности</h3>{!company.authorizedSigners.length && <p>Не указаны.</p>}{company.authorizedSigners.map((person) => <section className="registry-read-document" key={person.id}><ReadFields fields={[["ФИО", person.fullName], ["Должность", person.position], ["Номер доверенности", person.powerOfAttorneyNumber], ["Выдана", person.issuedAt], ["Действует до", person.expiresAt], ["Примечания", person.notes]]} /><ReadAttachment {...person.document} /></section>)}
    <h3>Связи</h3>{!company.affiliations.length && <p>Не указаны.</p>}{company.affiliations.map((relation) => <ReadFields key={relation.id} fields={[["Тип связи", relation.type], ["Компания", companies.find((entry) => entry.id === relation.targetCompanyId)?.name || "Карточка недоступна"], ["Комментарий", relation.note]]} />)}
  </RegistryReadCard>;
}
