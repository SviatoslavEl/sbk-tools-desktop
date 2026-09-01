import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "../../components/Dialog";
import { useUnsavedChanges } from "../../hooks/useUnsavedChanges";
import {
  getWorkspaceInfo,
  importContractsWithCompanyDirectoryAtomic,
  readDraft,
  saveContractWithCompanyDirectoryAtomic,
  updateContractsAndCompanyDirectoryAtomic,
  workspaceAccessInvalidatedEvent,
  type StoredRecord,
} from "../../lib/storage";
import {
  affiliationTypes,
  buildCompanyDirectoryMigration,
  companyUsedAsPerformer,
  companyRelationshipLabel,
  emptyCompany,
  emptyCompanyDirectory,
  linkContractToDirectory,
  mergeCompaniesFromContracts,
  normalizeCompanyDirectory,
  normalizeCompanyName,
  updateContractCompanyReference,
  validateCompany,
  validateCompanyDirectory,
  type CompanyCard,
  type CompanyDirectoryData,
} from "./companies";
import type { ContractData } from "./types";

const directoryDraftKey = "company-directory-v1";
export const companyDirectoryRefreshEvent = "sbk-workspace-refresh";

export function subscribeCompanyDirectoryRefresh(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  reload: () => void,
) {
  target.addEventListener(companyDirectoryRefreshEvent, reload);
  return () => target.removeEventListener(companyDirectoryRefreshEvent, reload);
}

export function useCompanyDirectory(contracts: StoredRecord<ContractData>[]) {
  const [directory, setDirectory] = useState<CompanyDirectoryData>(
    emptyCompanyDirectory(),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState(false);
  const [accessMessage, setAccessMessage] = useState("");
  const [migrationRevision, setMigrationRevision] = useState(0);
  const reloadGeneration = useRef(0);
  const reloadQueue = useRef<Promise<void>>(Promise.resolve());

  const reload = useCallback(() => {
    const currentGeneration = ++reloadGeneration.current;
    const task = reloadQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (currentGeneration !== reloadGeneration.current) return;
        setLoading(true);
        try {
          const [stored, workspace] = await Promise.all([
            readDraft<CompanyDirectoryData>(
              "contract-experience",
              directoryDraftKey,
            ),
            getWorkspaceInfo(),
          ]);
          if (currentGeneration !== reloadGeneration.current) return;
          setEditor(workspace.editor);
          setAccessMessage(workspace.accessMessage);
          const migration = buildCompanyDirectoryMigration(
            stored || emptyCompanyDirectory(),
            contracts,
          );
          setDirectory(migration.directory);
          const directoryErrors = validateCompanyDirectory(
            migration.directory.companies,
          );
          if (directoryErrors.length) {
            setError(
              `Справочник требует исправления: ${directoryErrors.join(" ")}`,
            );
            return;
          }
          if (
            workspace.editor &&
            (migration.directoryChanged || migration.updates.length)
          ) {
            await updateContractsAndCompanyDirectoryAtomic(
              migration.updates,
              migration.directory,
            );
            if (currentGeneration !== reloadGeneration.current) return;
            if (migration.updates.length)
              setMigrationRevision((value) => value + 1);
          }
          setError("");
        } catch (reason) {
          if (currentGeneration === reloadGeneration.current)
            setError(String(reason));
        } finally {
          if (currentGeneration === reloadGeneration.current) setLoading(false);
        }
      });
    reloadQueue.current = task;
    return task;
  }, [contracts]);

  useEffect(() => {
    void reload();
    const refresh = () => void reload();
    const unsubscribe = subscribeCompanyDirectoryRefresh(window, refresh);
    window.addEventListener(workspaceAccessInvalidatedEvent, refresh);
    return () => {
      reloadGeneration.current += 1;
      unsubscribe();
      window.removeEventListener(workspaceAccessInvalidatedEvent, refresh);
    };
  }, [reload]);

  const save = useCallback(
    async (
      company: CompanyCard,
      previous?: CompanyCard,
      records: StoredRecord<ContractData>[] = [],
    ) => {
      const now = new Date().toISOString();
      const normalized = {
        ...company,
        name: company.name.trim(),
        shortName: company.shortName.trim(),
        source: "manual" as const,
        updatedAt: now,
      };
      if (
        normalized.scope === "external" &&
        (companyUsedAsPerformer(normalized, records) ||
          (previous != null && companyUsedAsPerformer(previous, records)))
      )
        throw new Error(
          "Компания используется как юрлицо-исполнитель и должна оставаться во внутренней группе.",
        );
      const next = normalizeCompanyDirectory({
        schemaVersion: 2,
        companies: [
          normalized,
          ...directory.companies.filter((item) => item.id !== normalized.id),
        ],
      });
      const mutations = previous
        ? records
            .map((record) => ({
              record,
              update: updateContractCompanyReference(
                record.payload,
                previous,
                normalized,
              ),
            }))
            .filter(({ update }) => update.changed)
            .map(({ record, update }) => ({
              id: record.id,
              title: `${update.contract.number} — ${update.contract.customer}`,
              payload: update.contract,
            }))
        : [];
      await updateContractsAndCompanyDirectoryAtomic(mutations, next);
      setDirectory(next);
      return { company: normalized, updatedContracts: mutations.length };
    },
    [directory],
  );

  const persistContractThenDirectory = useCallback(
    async (item: ContractData, id?: string) => {
      const merged = mergeCompaniesFromContracts(directory, [item]);
      const linked = linkContractToDirectory(item, merged.directory.companies);
      const saved = await saveContractWithCompanyDirectoryAtomic(
        `${linked.number} — ${linked.customer}`,
        linked,
        merged.directory,
        id,
      );
      setDirectory(merged.directory);
      return saved;
    },
    [directory],
  );

  const persistContractsThenDirectory = useCallback(
    async (items: ContractData[]) => {
      const merged = mergeCompaniesFromContracts(directory, items);
      const linked = items.map((item) =>
        linkContractToDirectory(item, merged.directory.companies),
      );
      await importContractsWithCompanyDirectoryAtomic(
        linked.map((item) => ({
          id: crypto.randomUUID(),
          title: `${item.number} — ${item.customer}`,
          payload: item,
        })),
        merged.directory,
      );
      setDirectory(merged.directory);
      return linked;
    },
    [directory],
  );

  const persistContractUpdatesThenDirectory = useCallback(async (items: Array<{ id: string; payload: ContractData }>) => {
    const merged = mergeCompaniesFromContracts(directory, items.map((item) => item.payload));
    const updates = items.map((item) => {
      const payload = linkContractToDirectory(item.payload, merged.directory.companies);
      return { id: item.id, title: `${payload.number} — ${payload.customer}`, payload };
    });
    await updateContractsAndCompanyDirectoryAtomic(updates, merged.directory);
    setDirectory(merged.directory);
    return updates.length;
  }, [directory]);

  const setCompaniesArchived = useCallback(async (ids: string[], archived: boolean) => {
    const selected = new Set(ids);
    const now = new Date().toISOString();
    const next = normalizeCompanyDirectory({
      schemaVersion: 2,
      companies: directory.companies.map((company) => selected.has(company.id)
        ? { ...company, archived, updatedAt: now }
        : company),
    });
    await updateContractsAndCompanyDirectoryAtomic([], next);
    setDirectory(next);
  }, [directory]);

  const deleteArchivedCompanies = useCallback(async (ids: string[], records: StoredRecord<ContractData>[]) => {
    const selected = new Set(ids);
    const referenced = directory.companies.filter((company) => selected.has(company.id) && records.some((record) =>
      record.payload.performingLegalEntityId === company.id || record.payload.customerCompanyId === company.id
    ));
    if (referenced.length) throw new Error(`Нельзя удалить связанные с договорами компании: ${referenced.map((company) => company.shortName || company.name).join(", ")}. Их можно оставить в архиве.`);
    const next = normalizeCompanyDirectory({
      schemaVersion: 2,
      companies: directory.companies.filter((company) => !selected.has(company.id) || !company.archived),
    });
    await updateContractsAndCompanyDirectoryAtomic([], next);
    setDirectory(next);
  }, [directory]);

  return {
    companies: directory.companies,
    loading,
    error,
    editor,
    accessMessage,
    migrationRevision,
    save,
    persistContractThenDirectory,
    persistContractsThenDirectory,
    persistContractUpdatesThenDirectory,
    setCompaniesArchived,
    deleteArchivedCompanies,
    reload,
  };
}

export function CompanyNameField({
  label,
  value,
  companyId,
  companies,
  role,
  required,
  wide,
  onChange,
}: {
  label: string;
  value: string;
  companyId: string;
  companies: CompanyCard[];
  role: "ours" | "counterparty";
  required?: boolean;
  wide?: boolean;
  onChange: (name: string, id: string) => void;
}) {
  const available = companies
    .filter(
      (company) =>
        company.scope === (role === "ours" ? "internal" : "external") ||
        company.id === companyId,
    )
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const selectedValue =
    companyId && available.some((company) => company.id === companyId)
      ? companyId
      : available.find(
          (company) =>
            normalizeCompanyName(company.name) === normalizeCompanyName(value),
        )?.id || "__manual";
  const [manual, setManual] = useState(selectedValue === "__manual");
  useEffect(() => {
    setManual(selectedValue === "__manual");
  }, [selectedValue]);
  return (
    <label className={wide ? "wide" : undefined}>
      {label}
      {available.length > 0 && (
        <select
          aria-label={`${label}: выбор из справочника`}
          value={manual ? "__manual" : selectedValue}
          onChange={(event) => {
            if (event.target.value === "__manual") {
              setManual(true);
              onChange("", "");
              return;
            }
            const selected = available.find(
              (company) => company.id === event.target.value,
            );
            if (selected) {
              setManual(false);
              onChange(selected.name, selected.id);
            }
          }}
        >
          <option value="" disabled>
            Выберите компанию
          </option>
          {available.map((company) => (
            <option key={company.id} value={company.id}>
              {company.shortName || company.name}
            </option>
          ))}
          <option value="__manual">+ Ввести новую компанию</option>
        </select>
      )}
      {(manual || available.length === 0) && (
        <input
          required={required}
          aria-label={`${label}: название`}
          value={value}
          onChange={(event) => onChange(event.target.value, "")}
          placeholder={
            role === "ours" ? "Название нашей компании" : "Название контрагента"
          }
        />
      )}
    </label>
  );
}

export function CompanyDirectoryDialog({
  companies,
  error,
  readOnly = false,
  accessMessage,
  onClose,
  onSave,
}: {
  companies: CompanyCard[];
  error?: string;
  readOnly?: boolean;
  accessMessage?: string;
  onClose: () => void;
  onSave: (company: CompanyCard, previous?: CompanyCard) => Promise<void>;
}) {
  const [filter, setFilter] = useState<"all" | "internal" | "external">("all");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<CompanyCard | null>(null);
  const filtered = useMemo(
    () =>
      companies
        .filter((company) => {
          if (filter !== "all" && company.scope !== filter) return false;
          return [company.name, company.shortName, company.inn, company.ogrn]
            .join(" ")
            .toLocaleLowerCase("ru")
            .includes(search.toLocaleLowerCase("ru"));
        })
        .sort((a, b) => a.name.localeCompare(b.name, "ru")),
    [companies, filter, search],
  );
  return (
    <>
      <Dialog
        title="Компании и контрагенты"
        description="Внутренняя группа и внешние компании хранятся раздельно. Карточки из договоров попадают в подходящий раздел автоматически."
        onClose={onClose}
        width="1100px"
      >
        <div className="dialog-body">
          {error && <div className="notice error">{error}</div>}
          {readOnly && (
            <div className="notice warning">
              <strong>Только просмотр</strong>
              <span>
                {accessMessage ||
                  "Редактирование выполняется на компьютере, который владеет доступом к общей базе."}
              </span>
            </div>
          )}
          <div className="registry-toolbar">
            <label className="search-box">
              <span>Поиск</span>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Название, ИНН или ОГРН"
              />
            </label>
            <label>
              <span>Раздел</span>
              <select
                value={filter}
                onChange={(event) =>
                  setFilter(event.target.value as typeof filter)
                }
              >
                <option value="all">Все компании</option>
                <option value="internal">Внутренняя группа компаний</option>
                <option value="external">Внешние компании</option>
              </select>
            </label>
            {!readOnly && (
              <div className="toolbar-actions">
                <button
                  className="primary"
                  type="button"
                  onClick={() => setEditing(emptyCompany())}
                >
                  Добавить компанию
                </button>
              </div>
            )}
          </div>
          <div className="surface table-surface">
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Компания</th>
                    <th>Тип</th>
                    <th>ИНН / КПП</th>
                    <th>Связи</th>
                    {!readOnly && <th />}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((company) => {
                    const relationships = companyRelationshipLabel(
                      company,
                      companies,
                    );
                    return (
                      <tr key={company.id}>
                        <td>
                          {readOnly ? (
                            <>
                              <strong>
                                {company.shortName || company.name}
                              </strong>
                              {company.shortName && (
                                <small className="company-relation">
                                  {company.name}
                                </small>
                              )}
                            </>
                          ) : (
                            <button
                              className="link-button"
                              type="button"
                              onClick={() => setEditing(company)}
                            >
                              <strong>
                                {company.shortName || company.name}
                              </strong>
                              {company.shortName && (
                                <small>{company.name}</small>
                              )}
                            </button>
                          )}
                        </td>
                        <td>
                          <span
                            className={`status ${company.scope === "internal" ? "success" : "neutral"}`}
                          >
                            {company.scope === "internal"
                              ? "Внутренняя группа"
                              : "Внешняя"}
                          </span>
                        </td>
                        <td>
                          {company.inn || "—"}
                          {company.kpp ? ` / ${company.kpp}` : ""}
                        </td>
                        <td>
                          {relationships.length
                            ? relationships.map((label) => (
                                <small className="company-relation" key={label}>
                                  {label}
                                </small>
                              ))
                            : "—"}
                        </td>
                        {!readOnly && (
                          <td>
                            <button
                              className="secondary small"
                              type="button"
                              onClick={() => setEditing(company)}
                            >
                              Редактировать
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filtered.length === 0 && (
              <div className="empty-inline">
                Компании по текущему фильтру не найдены.
              </div>
            )}
          </div>
        </div>
        <footer className="dialog-actions">
          <span className="muted">Всего карточек: {companies.length}</span>
          <button className="primary" type="button" onClick={onClose}>
            Закрыть
          </button>
        </footer>
      </Dialog>
      {editing && (
        createPortal(
          <CompanyEditor
            company={editing}
            companies={companies}
            onClose={() => setEditing(null)}
            onSave={async (company) => {
              const previous = companies.find((item) => item.id === company.id);
              await onSave(company, previous);
              setEditing(null);
            }}
          />,
          document.body,
        )
      )}
    </>
  );
}

export function CompanyEditor({
  company,
  companies,
  onClose,
  onSave,
  readOnly = false,
}: {
  company: CompanyCard;
  companies: CompanyCard[];
  onClose: () => void;
  onSave: (company: CompanyCard) => Promise<void>;
  readOnly?: boolean;
}) {
  const [item, setItem] = useState(() => structuredClone(company));
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(item));
  const [error, setError] = useState("");
  const { requestClose, confirmation: discardConfirmation } = useUnsavedChanges(JSON.stringify(item) !== savedSnapshot, onClose);
  const update = <K extends keyof CompanyCard>(key: K, value: CompanyCard[K]) =>
    setItem((current) => ({ ...current, [key]: value }));
  const submit = async () => {
    const errors = validateCompany(item, companies);
    if (errors.length) {
      setError(errors.join(" "));
      return;
    }
    try {
      await onSave(item);
      setSavedSnapshot(JSON.stringify(item));
    } catch (reason) {
      setError(`Не удалось сохранить карточку: ${String(reason)}`);
    }
  };
  return (<>
    <aside
      className="detail-drawer company-editor-drawer"
      role="dialog"
      aria-modal="true"
      aria-label="Карточка компании"
    >
      <header>
        <div>
          <h2>{item.name || "Новая компания"}</h2>
          <p>Реквизиты, лица принимающие решения и аффилированность</p>
        </div>
        <button className="icon-button" type="button" aria-label="Закрыть карточку компании" title="Закрыть" onClick={requestClose}>
          ×
        </button>
      </header>
      <fieldset className="drawer-body company-editor-fieldset" disabled={readOnly}>
        {error && <div className="notice error">{error}</div>}
        <h3>Карточка</h3>
        <div className="form-grid">
          <label className="wide">
            Полное название *
            <input
              autoFocus
              value={item.name}
              onChange={(event) => update("name", event.target.value)}
            />
          </label>
          <label className="wide">
            Краткое название
            <input
              value={item.shortName}
              onChange={(event) => update("shortName", event.target.value)}
            />
          </label>
          <label>
            ИНН
            <input
              inputMode="numeric"
              value={item.inn}
              onChange={(event) => update("inn", event.target.value)}
            />
          </label>
          <label>
            КПП
            <input
              inputMode="numeric"
              value={item.kpp}
              onChange={(event) => update("kpp", event.target.value)}
            />
          </label>
          <label>
            ОГРН
            <input
              inputMode="numeric"
              value={item.ogrn}
              onChange={(event) => update("ogrn", event.target.value)}
            />
          </label>
          <label className="wide">
            Адрес
            <input
              value={item.address}
              onChange={(event) => update("address", event.target.value)}
            />
          </label>
          <label className="wide">
            Контакт
            <input
              value={item.contact}
              onChange={(event) => update("contact", event.target.value)}
            />
          </label>
        </div>
        <label>
          Раздел справочника *
          <select
            value={item.scope}
            onChange={(event) =>
              update("scope", event.target.value as CompanyCard["scope"])
            }
          >
            <option value="internal">Внутренняя группа компаний</option>
            <option value="external">Внешние компании</option>
          </select>
          <small>Компания может находиться только в одном разделе.</small>
        </label>
        <div className="inline-heading">
          <div>
            <h3>Лица, принимающие решения</h3>
            <p>Контакты руководителей и ответственных сотрудников компании.</p>
          </div>
          <button
            className="secondary small"
            type="button"
            onClick={() =>
              update("decisionMakers", [
                ...item.decisionMakers,
                {
                  id: crypto.randomUUID(),
                  fullName: "",
                  position: "",
                  department: "",
                  phone: "",
                  email: "",
                  notes: "",
                  isPrimary: item.decisionMakers.length === 0,
                },
              ])
            }
          >
            Добавить ЛПР
          </button>
        </div>
        {item.decisionMakers.length === 0 && (
          <div className="empty-inline">Лица, принимающие решения, не указаны.</div>
        )}
        {item.decisionMakers.map((person) => (
          <div className="decision-maker-card" key={person.id}>
            <div className="form-grid compact">
              <label className="wide">
                ФИО
                <input value={person.fullName} onChange={(event) => update("decisionMakers", item.decisionMakers.map((entry) => entry.id === person.id ? { ...entry, fullName: event.target.value } : entry))} />
              </label>
              <label>
                Должность
                <input value={person.position} onChange={(event) => update("decisionMakers", item.decisionMakers.map((entry) => entry.id === person.id ? { ...entry, position: event.target.value } : entry))} />
              </label>
              <label>
                Подразделение
                <input value={person.department} onChange={(event) => update("decisionMakers", item.decisionMakers.map((entry) => entry.id === person.id ? { ...entry, department: event.target.value } : entry))} />
              </label>
              <label>
                Телефон
                <input value={person.phone} onChange={(event) => update("decisionMakers", item.decisionMakers.map((entry) => entry.id === person.id ? { ...entry, phone: event.target.value } : entry))} />
              </label>
              <label>
                E-mail
                <input type="email" value={person.email} onChange={(event) => update("decisionMakers", item.decisionMakers.map((entry) => entry.id === person.id ? { ...entry, email: event.target.value } : entry))} />
              </label>
              <label className="wide">
                Примечание
                <input value={person.notes} onChange={(event) => update("decisionMakers", item.decisionMakers.map((entry) => entry.id === person.id ? { ...entry, notes: event.target.value } : entry))} />
              </label>
            </div>
            <div className="button-row">
              <label className="checkbox-row">
                <input type="checkbox" checked={person.isPrimary} onChange={(event) => update("decisionMakers", item.decisionMakers.map((entry) => ({ ...entry, isPrimary: entry.id === person.id ? event.target.checked : event.target.checked ? false : entry.isPrimary })))} /> Основной контакт
              </label>
              <button className="secondary small danger" type="button" onClick={() => update("decisionMakers", item.decisionMakers.filter((entry) => entry.id !== person.id))}>Удалить ЛПР</button>
            </div>
          </div>
        ))}
        <div className="inline-heading">
          <div>
            <h3>Аффилированность</h3>
            <p>Укажите роль связанной компании относительно этой карточки.</p>
          </div>
          <button
            className="secondary small"
            type="button"
            disabled={
              companies.filter((target) => target.id !== item.id).length === 0
            }
            onClick={() =>
              update("affiliations", [
                ...item.affiliations,
                {
                  id: crypto.randomUUID(),
                  targetCompanyId:
                    companies.find((target) => target.id !== item.id)?.id || "",
                  type: "Головная компания",
                  note: "",
                },
              ])
            }
          >
            Добавить связь
          </button>
        </div>
        {item.affiliations.length === 0 && (
          <div className="empty-inline">Связи не указаны.</div>
        )}
        {item.affiliations.map((relation) => (
          <div className="company-affiliation-row" key={relation.id}>
            <select
              aria-label="Тип связи"
              value={relation.type}
              onChange={(event) =>
                update(
                  "affiliations",
                  item.affiliations.map((entry) =>
                    entry.id === relation.id
                      ? {
                          ...entry,
                          type: event.target.value as typeof relation.type,
                        }
                      : entry,
                  ),
                )
              }
            >
              {affiliationTypes.map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
            <select
              aria-label="Связанная компания"
              value={relation.targetCompanyId}
              onChange={(event) =>
                update(
                  "affiliations",
                  item.affiliations.map((entry) =>
                    entry.id === relation.id
                      ? { ...entry, targetCompanyId: event.target.value }
                      : entry,
                  ),
                )
              }
            >
              {companies
                .filter((target) => target.id !== item.id)
                .map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.shortName || target.name}
                  </option>
                ))}
            </select>
            <input
              aria-label="Комментарий к связи"
              value={relation.note}
              onChange={(event) =>
                update(
                  "affiliations",
                  item.affiliations.map((entry) =>
                    entry.id === relation.id
                      ? { ...entry, note: event.target.value }
                      : entry,
                  ),
                )
              }
              placeholder="Доля, основание…"
            />
            <button
              className="icon-button danger"
              type="button"
              aria-label="Удалить связь"
              onClick={() =>
                update(
                  "affiliations",
                  item.affiliations.filter((entry) => entry.id !== relation.id),
                )
              }
            >
              ×
            </button>
          </div>
        ))}
        <label>
          Примечания
          <textarea
            rows={4}
            value={item.notes}
            onChange={(event) => update("notes", event.target.value)}
          />
        </label>
      </fieldset>
      <footer>
        <button className="secondary" type="button" onClick={requestClose}>
          Отмена
        </button>
        <button className="primary" type="button" disabled={readOnly} onClick={() => void submit()}>
          Сохранить компанию
        </button>
      </footer>
    </aside>
    {discardConfirmation}
  </>
  );
}
