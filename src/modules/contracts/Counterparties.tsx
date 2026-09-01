import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "../../components/Dialog";
import { useRecords } from "../../hooks/useRecords";
import { useWorkspaceAccess } from "../../lib/workspaceAccess";
import { CompanyEditor, useCompanyDirectory } from "./CompanyDirectory";
import { companyRelationshipLabel, emptyCompany, type CompanyCard } from "./companies";
import type { ContractData } from "./types";

type PendingAction = { kind: "archive" | "restore" | "delete"; ids: string[] } | null;

export function CounterpartiesRegistry() {
  const contracts = useRecords<ContractData>("contract-experience");
  const directory = useCompanyDirectory(contracts.records);
  const access = useWorkspaceAccess();
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | "internal" | "external">("external");
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<CompanyCard | null>(null);
  const [pending, setPending] = useState<PendingAction>(null);
  const [message, setMessage] = useState("");
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("ru-RU");
    return directory.companies.filter((company) => {
      if (company.archived !== showArchived) return false;
      if (scope !== "all" && company.scope !== scope) return false;
      const searchable = [
        company.name, company.shortName, company.inn, company.kpp, company.ogrn,
        company.address, company.contact, company.notes,
        ...company.decisionMakers.flatMap((person) => [person.fullName, person.position, person.department, person.phone, person.email, person.notes]),
      ].join(" ").toLocaleLowerCase("ru-RU");
      return !needle || searchable.includes(needle);
    }).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }, [directory.companies, search, scope, showArchived]);

  const runPending = async () => {
    if (!pending) return;
    try {
      if (pending.kind === "delete") await directory.deleteArchivedCompanies(pending.ids, contracts.records);
      else await directory.setCompaniesArchived(pending.ids, pending.kind === "archive");
      setMessage(pending.kind === "archive" ? "Карточки перенесены в архив." : pending.kind === "restore" ? "Карточки восстановлены." : "Несвязанные архивные карточки удалены.");
    } catch (reason) {
      setMessage(String(reason));
    } finally {
      setPending(null);
    }
  };

  return <div className="module-stack counterparties-tool">
    {(directory.error || message) && <div className={`notice ${directory.error || message.startsWith("Error") || message.startsWith("Нельзя") ? "error" : "success"}`}>{directory.error || message}</div>}
    <div className="registry-toolbar">
      <label className="search-box"><span>Быстрый поиск</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Компания, ИНН, ФИО, должность, телефон…" /></label>
      <label><span>Раздел</span><select value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}><option value="all">Все компании</option><option value="internal">Внутренняя группа</option><option value="external">Внешние контрагенты</option></select></label>
      <label className="checkbox-row"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Архив</label>
      <div className="toolbar-actions">
        {!showArchived && <button className="primary" type="button" disabled={!access.editor} onClick={() => setEditing(emptyCompany())}>Добавить компанию</button>}
        {filtered.length > 0 && !showArchived && <button className="secondary" type="button" disabled={!access.editor} onClick={() => setPending({ kind: "archive", ids: filtered.map((company) => company.id) })}>В архив все найденные</button>}
        {filtered.length > 0 && showArchived && <><button className="secondary" type="button" disabled={!access.editor} onClick={() => setPending({ kind: "restore", ids: filtered.map((company) => company.id) })}>Восстановить все</button><button className="danger-button" type="button" disabled={!access.editor} onClick={() => setPending({ kind: "delete", ids: filtered.map((company) => company.id) })}>Удалить все найденные</button></>}
      </div>
    </div>
    <section className="surface table-surface">
      <div className="table-scroll"><table><thead><tr><th>Компания</th><th>Реквизиты</th><th>Лица, принимающие решения</th><th>Контакты</th><th>Связи</th><th /></tr></thead><tbody>{filtered.map((company) => <tr key={company.id}>
        <td><button className="link-button" type="button" onClick={() => setEditing(company)}><strong>{company.shortName || company.name}</strong>{company.shortName && <small>{company.name}</small>}</button><span className={`status ${company.scope === "internal" ? "success" : "neutral"}`}>{company.scope === "internal" ? "Внутренняя" : "Внешняя"}</span></td>
        <td>{company.inn ? <>ИНН {company.inn}{company.kpp ? <><br />КПП {company.kpp}</> : null}</> : "—"}</td>
        <td>{company.decisionMakers.length ? company.decisionMakers.map((person) => <div className="decision-maker-summary" key={person.id}><strong>{person.fullName || "Без имени"}{person.isPrimary ? " ★" : ""}</strong><small>{person.position || person.department || "Должность не указана"}</small></div>) : "—"}</td>
        <td>{company.decisionMakers.map((person) => <small className="company-relation" key={person.id}>{[person.phone, person.email].filter(Boolean).join(" · ")}</small>)}{!company.decisionMakers.length && (company.contact || "—")}</td>
        <td>{companyRelationshipLabel(company, directory.companies).map((label) => <small className="company-relation" key={label}>{label}</small>)}</td>
        <td><button className="secondary small" type="button" onClick={() => setEditing(company)}>{access.editor ? "Редактировать" : "Открыть"}</button></td>
      </tr>)}</tbody></table></div>
      {!directory.loading && filtered.length === 0 && <div className="empty-state"><h2>Ничего не найдено</h2><p>Измените строку поиска или выбранный раздел.</p></div>}
    </section>
    {editing && createPortal(<CompanyEditor company={editing} companies={directory.companies} readOnly={!access.editor} onClose={() => setEditing(null)} onSave={async (company) => { if (!access.editor) return; const previous = directory.companies.find((item) => item.id === company.id); await directory.save(company, previous, contracts.records); setEditing(null); }} />, document.body)}
    {pending && <ConfirmDialog title={pending.kind === "delete" ? "Удалить найденные карточки навсегда?" : pending.kind === "archive" ? "Перенести найденные карточки в архив?" : "Восстановить найденные карточки?"} message={pending.kind === "delete" ? "Карточки, связанные с договорами, останутся в архиве. Остальные будут удалены без возможности восстановления." : `Будет обработано карточек: ${pending.ids.length}.`} confirmLabel={pending.kind === "delete" ? "Удалить" : "Подтвердить"} onClose={() => setPending(null)} onConfirm={() => void runPending()} />}
  </div>;
}
