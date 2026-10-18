import { useState, type ReactNode } from "react";
import { commercialCanonicalJson, validateCommercialDocument, type CommercialBlock, type CommercialInline, type CommercialTermQuestion, type ProposalCommercialDocumentV1 } from "./commercialDocument";
import "./commercial-document.css";

interface EditSession { document: ProposalCommercialDocumentV1; baseValueJson: string; blockId: string; draft: CommercialBlock }
const groups = (block: CommercialBlock): CommercialInline[][] => block.kind === "paragraph" ? [block.content] : block.kind === "list" ? block.items : block.rows.flat();

/** The receiver's controlled working document, not a second proposal store or
 * a rendered PDF. Only temporary, unapplied text lives in this component. */
export function CommercialDocumentView({ value, onChange, readOnly = false, renderQuestion, onPendingEditChange }: {
  value: ProposalCommercialDocumentV1;
  /** Synchronous acceptance by the sole state owner, not persistence/approval.
   * A silent rejection or an async callback must not discard the local draft. */
  onChange: (next: ProposalCommercialDocumentV1) => boolean;
  readOnly?: boolean;
  renderQuestion?: (question: CommercialTermQuestion) => ReactNode;
  onPendingEditChange?: (pending: boolean) => void;
}) {
  const [editing, setEditing] = useState<EditSession | null>(null);
  const [error, setError] = useState("");
  const targets = new Map<string, { label: string; elementId: string }>();
  value.body.sections.forEach((section, si) => {
    targets.set(section.id, { label: `раздел ${si + 1}`, elementId: `commercial-${section.id}` });
    section.blocks.forEach((block, bi) => targets.set(block.id, { label: `пункт ${si + 1}.${bi + 1}`, elementId: `commercial-${block.id}` }));
  });
  const inline = (parts: CommercialInline[]) => parts.map((part, index) => {
    if (part.kind === "text") return <span key={index}>{part.text}</span>;
    const target = targets.get(part.targetId);
    return target ? <a key={index} href={`#${target.elementId}`}>{target.label}</a> : <span key={index} className="commercial-broken-reference">[Цель ссылки не найдена]</span>;
  });
  const body = (block: CommercialBlock) => {
    if (block.kind === "paragraph") return <p className={`commercial-paragraph is-${block.style}`}>{inline(block.content)}</p>;
    if (block.kind === "list") return block.style === "bullet"
      ? <ul>{block.items.map((item, index) => <li key={index}>{inline(item)}</li>)}</ul>
      : <ol>{block.items.map((item, index) => <li key={index}>{inline(item)}</li>)}</ol>;
    return <div className="commercial-table-scroll" tabIndex={0} role="region" aria-label="Таблица условий"><table><thead><tr>{block.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead><tbody>{block.rows.map((row, ri) => <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{inline(cell)}</td>)}</tr>)}</tbody></table></div>;
  };
  const begin = (block: CommercialBlock) => {
    if (readOnly) return;
    if (editing) {
      if (editing.blockId !== block.id) setError("Сначала примените или отмените открытые правки. Они не потеряны.");
      return;
    }
    setEditing({ document: value, baseValueJson: commercialCanonicalJson(value), blockId: block.id, draft: structuredClone(block) }); onPendingEditChange?.(true); setError("");
  };
  const setPart = (groupIndex: number, partIndex: number, text: string) => {
    setEditing((current) => {
      if (!current || readOnly) return current;
      const draft = structuredClone(current.draft), part = groups(draft)[groupIndex]?.[partIndex];
      if (!part || part.kind !== "text") return current;
      part.text = text; return { ...current, draft };
    });
  };
  const apply = () => {
    if (!editing || readOnly) return;
    if (value !== editing.document || commercialCanonicalJson(value) !== editing.baseValueJson) { setError("Документ изменился после открытия редактора. Ваш текст остаётся в поле; отмените правки и заново откройте актуальный пункт."); return; }
    if (!Number.isSafeInteger(value.revision + 1)) { setError("Достигнут предел редакций. Правки не применены."); return; }
    const next = structuredClone(value);
    let found = false;
    for (const section of next.body.sections) section.blocks = section.blocks.map((block) => {
      if (block.id !== editing.blockId) return block;
      found = true; return structuredClone(editing.draft);
    });
    if (!found) { setError("Редактируемый пункт больше не найден. Правки остаются в поле."); return; }
    next.revision += 1;
    const issue = validateCommercialDocument(next).find((item) => item.severity === "error");
    if (issue) { setError(`${issue.message} Правки остаются в поле.`); return; }
    // A manual edit is not source approval. The source/decision gates must
    // re-evaluate this revision; immutable quotes/history remain untouched.
    try { if (onChange(next) !== true) { setError("Редактор не принял изменение. Ваш текст остаётся в поле."); return; } setEditing(null); onPendingEditChange?.(false); setError(""); }
    catch (reason) { setError(`${reason instanceof Error ? reason.message : "Не удалось применить правки"}. Ваш текст остаётся в поле.`); }
  };
  const editor = (session: EditSession, ordinal: string) => <div className="commercial-inline-editor">
    {groups(session.draft).map((parts, gi) => <div key={gi} className="commercial-edit-group">{parts.map((part, pi) => part.kind === "text"
      ? <label key={pi}>Текст {gi + 1}{parts.length > 1 ? `, фрагмент ${pi + 1}` : ""}<textarea aria-label={`Текст пункта ${ordinal}, группа ${gi + 1}, фрагмент ${pi + 1}`} rows={Math.min(10, Math.max(3, part.text.split("\n").length + 1))} value={part.text} disabled={readOnly} onChange={(event) => setPart(gi, pi, event.target.value)} /><small>{Array.from(part.text).length.toLocaleString("ru-RU")} / 20 000 символов{Array.from(part.text).length > 20000 ? " — сократите текст перед применением; он не обрезан" : ""}</small></label>
      : <p key={pi} className="help-text">Ссылка сохраняется отдельно от редактируемого текста.</p>)}</div>)}
    <p className="help-text">Правки пока только в этом поле. После применения проверьте связанные условия; исходные цитаты не меняются.</p>
    <div className="commercial-edit-actions"><button type="button" className="primary" disabled={readOnly || session.document !== value} onClick={apply}>Применить текст</button><button type="button" className="secondary" onClick={() => { setEditing(null); onPendingEditChange?.(false); setError(""); }}>Отменить правки</button></div>
  </div>;
  const detached = editing && editing.document !== value;
  let draftOrdinal = "";
  if (editing) editing.document.body.sections.forEach((section, si) => section.blocks.forEach((block, bi) => { if (block.id === editing.blockId) draftOrdinal = `${si + 1}.${bi + 1}`; }));
  return <section className="commercial-document" aria-label="Документ коммерческого предложения">
    <header className="commercial-document-heading"><div><h2>Проект для согласования</h2><p>Читайте документ по разделам. Текст можно изменить на месте; спорные условия уточняются рядом с соответствующим разделом.</p></div><small>Редакция документа: {value.revision}</small></header>
    <p className="notice warning">Это рабочий проект, не готовый к отправке файл. Изменение текста не подтверждает его исходным документом и может сделать прежние решения неактуальными.</p>
    {error && <p className="notice error" role="alert">{error}</p>}
    {detached && <aside className="commercial-detached-draft" aria-label="Неприменённые правки предыдущего документа"><h3>Документ изменился — правки сохранены в поле</h3><p>Этот текст относится к предыдущей редакции. Скопируйте нужные фрагменты, затем отмените правки и откройте актуальный пункт. Автоматически заменять новый документ этим текстом нельзя.</p>{editor(editing, draftOrdinal)}</aside>}
    {value.body.sections.map((section, si) => {
      const questions = value.questions.filter((question) => question.sectionId === section.id);
      return <section key={section.id} id={`commercial-${section.id}`} className="commercial-section" aria-labelledby={`commercial-heading-${section.id}`}>
        <h3 id={`commercial-heading-${section.id}`}>{si + 1}. {section.title}</h3>
        {section.blocks.map((block, bi) => <div key={block.id} id={`commercial-${block.id}`} className="commercial-block">
          <div className="commercial-block-heading"><small>{si + 1}.{bi + 1}</small>{!readOnly && <button type="button" className="secondary" disabled={Boolean(editing && editing.blockId !== block.id)} aria-label={`Изменить текст пункта ${si + 1}.${bi + 1}`} onClick={() => begin(block)}>Изменить текст</button>}</div>
          {!detached && editing?.blockId === block.id ? editor(editing, `${si + 1}.${bi + 1}`) : body(block)}
        </div>)}
        {questions.length > 0 && <aside className="commercial-section-questions" aria-label={`Вопросы по разделу ${si + 1}`}><h4>Вопросы по разделу: {questions.length}</h4>{questions.map((question) => <div key={question.id} id={`commercial-question-${question.id}`} data-question-id={question.id}>{renderQuestion ? renderQuestion(question) : <p>{question.message}</p>}</div>)}</aside>}
      </section>;
    })}
  </section>;
}
