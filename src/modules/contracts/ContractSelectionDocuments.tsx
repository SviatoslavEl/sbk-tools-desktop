import {
  contractSelectionArchivePlan,
  selectContractDocumentGroup,
  type ContractSelectionDocumentGroup,
} from "./selectionDocuments";
import "./selectionDocuments.css";

interface Props {
  groups: ContractSelectionDocumentGroup[];
  selected: ReadonlySet<string>;
  onChange: (selected: Set<string>) => void;
  disabled?: boolean;
}

export function ContractSelectionDocuments({ groups, selected, onChange, disabled = false }: Props) {
  const count = contractSelectionArchivePlan(groups, selected).attachmentPaths.length;
  return <section className="contract-selection-documents" aria-label="Документы договоров для ZIP">
    <h3>Файлы для архива · выбрано: {count}</h3>
    <p className="help-text">В ZIP попадут сведения об отмеченных договорах и только выбранные ниже файлы. По умолчанию файлы не выбраны.</p>
    {!groups.length && <p className="empty-inline">Сначала отметьте договоры в подборе.</p>}
    {groups.map((group) => {
      const available = group.documents.filter((document) => document.relativePath);
      const chosen = available.filter((document) => selected.has(document.key)).length;
      return <fieldset key={group.recordId} disabled={disabled}>
        <legend>{group.title}</legend>
        <div className="contract-document-group-actions">
          <small>Документов выбрано: {chosen} из {available.length}</small>
          <button type="button" className="secondary small" disabled={!available.length || chosen === available.length} onClick={() => onChange(selectContractDocumentGroup(group, selected, true))}>Выбрать все файлы</button>
          <button type="button" className="secondary small" disabled={!chosen} onClick={() => onChange(selectContractDocumentGroup(group, selected, false))}>Снять выбор</button>
        </div>
        {!group.documents.length && <p className="help-text">Документы не добавлены.</p>}
        {group.documents.map((document) => <label key={document.key} className="contract-selection-document">
          <input type="checkbox" disabled={!document.relativePath} checked={!!document.relativePath && selected.has(document.key)} aria-label={`Включить файл: ${group.title} — ${document.name}`} onChange={(event) => {
            const next = new Set(selected);
            if (event.target.checked && document.relativePath) next.add(document.key);
            else next.delete(document.key);
            onChange(next);
          }} />
          <span><strong>{document.name}</strong><small>{document.type} · {document.relativePath ? document.fileName : "Без файла — недоступно для архива"}</small></span>
        </label>)}
      </fieldset>;
    })}
  </section>;
}
