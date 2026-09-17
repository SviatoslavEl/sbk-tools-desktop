import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "../../components/Dialog";
import { VersionHistory } from "../../components/VersionHistory";
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => { setSelected(new Set()); }, [scope, showArchived, search]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("ru-RU");
    return directory.companies.filter((company) => {
      if (company.archived !== showArchived) return false;
      if (scope !== "all" && company.scope !== scope) return false;
      const searchable = [
        company.name, company.shortName, company.inn, company.kpp, company.ogrn,
        company.address, company.contact, company.notes,
        ...company.decisionMakers.flatMap((person) => [person.fullName, person.position, person.department, person.phone, person.email, person.notes]),
        ...company.authorizedSigners.flatMap((person) => [person.fullName, person.position, person.powerOfAttorneyNumber, person.notes, person.document.fileName || ""]),
      ].join(" ").toLocaleLowerCase("ru-RU");
      return !needle || searchable.includes(needle);
    }).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }, [directory.companies, search, scope, showArchived]);
  const selectedCompanies = filtered.filter((company) => selected.has(company.id));
  const canMutate = access.editor && !directory.loading && !contracts.loading && !directory.error && !contracts.error;

  const runPending = async () => {
    if (!pending) return;
    if (!canMutate) throw new Error("Нет доступа редактора или справочник ещё не прочитан. Действие не выполнено.");
      if (pending.kind === "delete") await directory.deleteArchivedCompanies(pending.ids, contracts.records);
      else await directory.setCompaniesArchived(pending.ids, pending.kind === "archive");
      setMessage(pending.kind === "archive" ? "Карточки перенесены в архив." : pending.kind === "restore" ? "Карточки восстановлены." : "Несвязанные архивные карточки удалены.");
      setPending(null);
      setSelected(new Set());
  };

  return <div className="module-stack registry-module counterparties-tool">
    {(directory.error || contracts.error) && <div className="notice error" role="alert"><strong>Не удалось прочитать справочник.</strong><span>{directory.error || contracts.error}</span><button className="secondary" type="button" disabled={directory.loading || contracts.loading} onClick={() => { void contracts.reload(); void directory.reload(); }}>Повторить чтение</button></div>}
    {message && <div className="notice success" role="status">{message}</div>}
    <div className="registry-toolbar">
      <label className="search-box"><span>Быстрый поиск</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Компания, ИНН, ФИО, должность, телефон…" /></label>
      <fieldset className="scope-switcher"><legend>Раздел контрагентов</legend><button type="button" className={scope === "external" ? "active" : ""} aria-pressed={scope === "external"} onClick={() => setScope("external")}>Внешние</button><button type="button" className={scope === "internal" ? "active" : ""} aria-pressed={scope === "internal"} onClick={() => setScope("internal")}>Внутренние</button><button type="button" className={scope === "all" ? "active" : ""} aria-pressed={scope === "all"} onClick={() => setScope("all")}>Все</button></fieldset>
      <label className="checkbox-row"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Архив</label>
      <div className="toolbar-actions">
        {!showArchived && <button className="primary" type="button" disabled={!canMutate} onClick={() => setEditing(emptyCompany())}>Добавить компанию</button>}
        {selectedCompanies.length > 0 && !showArchived && <button className="secondary" type="button" disabled={!canMutate} onClick={() => setPending({ kind: "archive", ids: selectedCompanies.map((company) => company.id) })}>В архив выбранные ({selectedCompanies.length})</button>}
        {selectedCompanies.length > 0 && showArchived && <><button className="secondary" type="button" disabled={!canMutate} onClick={() => setPending({ kind: "restore", ids: selectedCompanies.map((company) => company.id) })}>Восстановить выбранные ({selectedCompanies.length})</button><button className="danger-button" type="button" disabled={!canMutate} onClick={() => setPending({ kind: "delete", ids: selectedCompanies.map((company) => company.id) })}>Удалить выбранные ({selectedCompanies.length})</button></>}
      </div>
    </div>
    <section className="surface table-surface">
      <div className="registry-display-options" role="status">Найдено: {filtered.length} · выбрано: {selectedCompanies.length}{selectedCompanies.length > 0 && <button className="link-button" type="button" onClick={() => setSelected(new Set())}>Снять выбор</button>}</div>
      <div className="table-scroll"><table className="registry-counterparties-table registry-compact-table"><thead><tr><th className="selection-cell"><input type="checkbox" aria-label="Выбрать всех найденных контрагентов" checked={filtered.length > 0 && selectedCompanies.length === filtered.length} ref={(input) => { if (input) input.indeterminate = selectedCompanies.length > 0 && selectedCompanies.length < filtered.length; }} onChange={(event) => setSelected(event.target.checked ? new Set(filtered.map((company) => company.id)) : new Set())} /></th><th>Компания</th><th>Реквизиты</th><th>Лица, принимающие решения</th><th>Право подписи</th><th>Контакты</th><th>Связи</th><th /></tr></thead><tbody>{filtered.map((company) => <tr key={company.id}>
        <td className="selection-cell"><input type="checkbox" aria-label={`Выбрать контрагента ${company.name}`} checked={selected.has(company.id)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(company.id); else next.delete(company.id); return next; })} /></td>
        <td><button className="link-button" type="button" onClick={() => setEditing(company)}><strong>{company.shortName || company.name}</strong>{company.shortName && <small>{company.name}</small>}</button><span className={`status ${company.scope === "internal" ? "success" : "neutral"}`}>{company.scope === "internal" ? "Внутренняя" : "Внешняя"}</span></td>
        <td>{company.inn ? <>ИНН {company.inn}{company.kpp ? <><br />КПП {company.kpp}</> : null}</> : "—"}</td>
        <td>{company.decisionMakers.length ? company.decisionMakers.map((person) => <div className="decision-maker-summary" key={person.id}><strong>{person.fullName || "Без имени"}{person.isPrimary ? " ★" : ""}</strong><small>{person.position || person.department || "Должность не указана"}</small></div>) : "—"}</td>
        <td>{company.scope === "internal" && company.authorizedSigners.length ? company.authorizedSigners.map((person) => <div className="decision-maker-summary" key={person.id}><strong>{person.fullName}</strong><small>{person.powerOfAttorneyNumber ? `Доверенность ${person.powerOfAttorneyNumber}` : "Номер не указан"}{person.document.fileName ? ` · ${person.document.fileName}` : ""}</small></div>) : "—"}</td>
        <td>{company.decisionMakers.map((person) => <small className="company-relation" key={person.id}>{[person.phone, person.email].filter(Boolean).join(" · ")}</small>)}{!company.decisionMakers.length && (company.contact || "—")}</td>
        <td>{companyRelationshipLabel(company, directory.companies).map((label) => <small className="company-relation" key={label}>{label}</small>)}</td>
        <td><button className="secondary small" type="button" onClick={() => setEditing(company)}>{access.editor ? "Редактировать" : "Открыть"}</button><VersionHistory module="contract-experience" id={`company:${company.id}`} title={company.name} payload={company} onRestore={async (snapshot) => { await directory.save({ ...(snapshot as CompanyCard), id: company.id }, company, contracts.records); }} /></td>
      </tr>)}</tbody></table></div>
      {(directory.loading || contracts.loading) && <div className="empty-state" role="status">Загружаем контрагентов…</div>}
      {!directory.loading && !contracts.loading && !directory.error && !contracts.error && filtered.length === 0 && <div className="empty-state"><h2>{directory.companies.length ? "Нет совпадений" : "Справочник пока пуст"}</h2><p>{directory.companies.length ? "Измените поиск или выбранный раздел." : "Добавьте компанию или импортируйте договоры — связанные компании появятся здесь."}</p>{(search || scope !== "all") && directory.companies.length > 0 && <button className="secondary" type="button" onClick={() => { setSearch(""); setScope("all"); }}>Сбросить фильтры</button>}</div>}
    </section>
    {editing && createPortal(<CompanyEditor company={editing} companies={directory.companies} readOnly={!canMutate} onClose={() => setEditing(null)} onSave={async (company) => { if (!canMutate) throw new Error("Доступ редактора завершён или справочник недоступен."); const previous = directory.companies.find((item) => item.id === company.id); await directory.save(company, previous, contracts.records); setEditing(null); }} />, document.body)}
    {pending && <ConfirmDialog title={pending.kind === "delete" ? "Удалить выбранные карточки навсегда?" : pending.kind === "archive" ? "Перенести выбранные карточки в архив?" : "Восстановить выбранные карточки?"} message={`Выбрано: ${pending.ids.length}. ${directory.companies.filter((company) => pending.ids.includes(company.id)).map((company) => company.name).join("; ")}. ${pending.kind === "delete" ? "Удаление необратимо. При наличии связей с договорами вся операция будет отменена." : pending.kind === "archive" ? "Карточки можно восстановить. Существующие связи в договорах сохранятся." : "Карточки вернутся в рабочий справочник."}`} confirmLabel={pending.kind === "delete" ? "Удалить" : "Подтвердить"} onClose={() => setPending(null)} onConfirm={runPending} />}
  </div>;
}
