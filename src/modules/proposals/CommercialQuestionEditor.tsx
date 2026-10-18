import { useEffect, useRef, useState, type ReactNode } from "react";
import { commercialCanonicalJson, isCommercialId, type CommercialAgreedStage, type CommercialBlock, type CommercialDayKind, type CommercialIssue, type CommercialTermAnswer, type CommercialTermQuestion, type ProposalCommercialDocumentV1 } from "./commercialDocument";
import { validateTermAnswer, type CommercialAnswerValidation, type CommercialQuestionState } from "./commercialDecisions";
import { collectCommercialStageCatalog } from "./commercialPreparation";
import "./commercial-question-editor.css";

type Day = CommercialDayKind | "";
interface Stage { id: string; title: string; scope: string; result: string; count: string; dayKind: Day; sourceDurationText?: string }
interface Relation { id: string; kind: "" | "after" | "may-overlap"; stageId: string; afterStageId: string; stageIds: string[]; conditions: string }
interface Milestone { id: string; title: string; condition: string; beforeStageIds: string[]; afterStageIds: string[] }
interface Draft {
  base: "" | "net" | "gross"; vat: "" | "included" | "additional"; dayKind: Day;
  stages: Stage[]; maximumCount: string; maximumDayKind: Day; relations: Relation[]; milestones: Milestone[];
  referenceMode: "" | "body-target" | "governing-document" | "replace-clauses"; targetIds: string[];
  definitionTitle: string; definitionText: string; replacements: Array<{ blockId: string; publicText: string }>;
}
interface Session { document: ProposalCommercialDocumentV1; revision: number; sourceKey: string; questionKey: string; dependencyKey?: string; prefillSourceIds: string[]; question: CommercialTermQuestion; draft: Draft }
export interface CommercialQuestionEditorProps {
  doc: ProposalCommercialDocumentV1; question: CommercialTermQuestion; disabled?: boolean;
  onApply: (answer: CommercialTermAnswer) => Promise<boolean>;
  currentState?: CommercialQuestionState;
  /** Owner-verified active stage-plan only, never an arbitrary stored answer. */
  activeStages?: readonly Pick<CommercialAgreedStage, "id" | "title">[];
  /** Owner supplies fresh pricing and dependency guards, especially for VAT. */
  onPreview?: (answer: CommercialTermAnswer) => Promise<CommercialAnswerValidation>;
  onDirtyChange?: (dirty: boolean) => void;
}
const titles = { "advance-base": "База аванса и НДС", "advance-days": "Срок перечисления аванса", "stage-plan": "Согласованный план этапов", "stage-parallelism": "Последовательность и параллельность", "boundary-protocol": "Контрольные точки и границы работ", "source-reference": "Смысл исходных ссылок" };
export function commercialQuestionLocation(doc: ProposalCommercialDocumentV1, question: CommercialTermQuestion): string {
  const index = doc.body.sections.findIndex((section) => section.id === question.sectionId), section = doc.body.sections[index];
  if (!section) return "раздел пока не найден";
  const places = doc.body.sections.flatMap((owner, si) => owner.blocks.flatMap((block, bi) => question.targetBlockIds.includes(block.id) ? [`${si + 1}.${bi + 1}`] : []));
  return `раздел ${index + 1} «${section.title}»${places.length ? `, ${places.length === 1 ? "пункт" : "пункты"} ${places.join(", ")}` : ""}`;
}
export function commercialQuestionLabel(doc: ProposalCommercialDocumentV1, question: CommercialTermQuestion): string {
  const index = doc.questions.findIndex((entry) => entry.id === question.id);
  return `${index >= 0 ? `Вопрос ${index + 1}: ` : ""}${titles[question.kind]} — ${commercialQuestionLocation(doc, question)}`;
}
/** Present dependencies without changing their IDs, targets or gate results. */
export function commercialReadableMessage(doc: ProposalCommercialDocumentV1, message: string): string {
  let result = message.replace("Решение пересекает блоки других вопросов:", "Этот вопрос затрагивает пункты других вопросов:");
  for (const question of [...doc.questions].sort((left, right) => right.id.length - left.id.length)) {
    const id = question.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`(?<![A-Za-z0-9_-])${id}(?![A-Za-z0-9_-])`, "g"), () => `«${commercialQuestionLabel(doc, question)}»`);
  }
  return result.replace(/\bquestion-[A-Za-z0-9_-]+\b/g, "связанный вопрос, который сейчас не найден");
}
export function commercialIssueMessage(doc: ProposalCommercialDocumentV1, issue: Pick<CommercialIssue, "code" | "message">): string {
  const message = issue.code === "commercial-decision-target-overlap" ? issue.message.replace("Несколько решений", "Несколько вопросов") : issue.message;
  return commercialReadableMessage(doc, message);
}
/** Group only exact diagnostics. Keep every issue/path for the detail view. */
export function commercialIssueGroups(issues: readonly CommercialIssue[]) {
  const grouped = new Map<string, { key: string; issue: CommercialIssue; entries: CommercialIssue[] }>();
  for (const issue of issues) {
    const key = JSON.stringify([issue.code, issue.message, issue.severity]);
    const existing = grouped.get(key);
    if (existing) existing.entries.push(issue); else grouped.set(key, { key, issue, entries: [issue] });
  }
  return [...grouped.values()];
}
const dayName = (day: Day) => day === "business" ? "рабочих дней" : day === "calendar" ? "календарных дней" : "вид дней не выбран";
const stageCaption = (title: string, index: number) => /^этап\s*\d+(?=$|[\s.):–—-])/iu.test(title.trimStart())
  ? title : `Этап ${index + 1}: ${title || "Название не заполнено"}`;
const blockText = (block: CommercialBlock, localLabel?: (id: string) => string) => {
  const inline = (parts: Array<{ kind: string; text?: string; targetId?: string }>) => parts.map((part) => part.kind === "text" ? part.text : localLabel?.(part.targetId || "") || "[локальная ссылка]").join("");
  return block.kind === "paragraph" ? inline(block.content) : block.kind === "list" ? block.items.map(inline).join("\n") : [block.columns.join(" · "), ...block.rows.map((row) => row.map(inline).join(" · "))].join("\n");
};
function start(doc: ProposalCommercialDocumentV1, question: CommercialTermQuestion, dependencyKey?: string): Session {
  const catalog = question.kind === "stage-plan" ? collectCommercialStageCatalog(doc).stages : [];
  const maximums = question.kind === "stage-plan" ? doc.privateAppendix.clauses.filter((clause) => clause.roles.includes("schedule")).flatMap((clause) => {
    const match = /(?:общий\s+)?максимальн[\p{L}]*\s+срок[^\d]{0,70}(\d+)\s*(?:\([^)]{1,80}\)\s*)?(рабоч[\p{L}]*|календарн[\p{L}]*)\s+дн/iu.exec(clause.quote);
    return match ? [{ sourceClauseId: clause.id, count: match[1], dayKind: /^рабоч/iu.test(match[2]) ? "business" as const : "calendar" as const }] : [];
  }) : [];
  const maximum = maximums.length && new Set(maximums.map((entry) => `${entry.count}:${entry.dayKind}`)).size === 1 ? maximums[0] : undefined;
  return { document: doc, revision: doc.revision, sourceKey: doc.privateAppendix.sourceSnapshotKey, questionKey: commercialCanonicalJson(question), dependencyKey, prefillSourceIds: [...new Set([...catalog.map((stage) => stage.sourceClauseId), ...maximums.map((maximum) => maximum.sourceClauseId)])], question: structuredClone(question), draft: {
    base: "", vat: "", dayKind: "", stages: catalog.map((stage) => ({ id: stage.id, title: stage.title, scope: stage.scope, result: stage.result, count: stage.duration?.count || "", dayKind: stage.duration?.dayKind || "", sourceDurationText: stage.durationText })),
    maximumCount: maximum?.count || "", maximumDayKind: maximum?.dayKind || "", relations: [], milestones: [], referenceMode: "", targetIds: [], definitionTitle: "", definitionText: "",
    replacements: question.targetBlockIds.map((blockId) => ({ blockId, publicText: "" })),
  } };
}
function required(value: string, label: string) {
  if (!value.trim() || Array.from(value).length > 20000) throw new Error(`${label}: заполните текст не длиннее 20 000 символов. Введённый текст сохранён.`);
  return value;
}
function duration(count: string, dayKind: Day, label: string) {
  if (!/^[1-9]\d{0,4}$/u.test(count) || !dayKind) throw new Error(`${label}: укажите целое число от 1 до 99999 и вид дней.`);
  return { count, dayKind };
}
function answerFor(session: Session, activeStages: CommercialQuestionEditorProps["activeStages"]): CommercialTermAnswer {
  const { draft: d, question: q } = session;
  const stageIds = activeStages?.map((stage) => stage.id) || [];
  const known = (ids: string[], minimum = 1) => {
    if (ids.length < minimum || new Set(ids).size !== ids.length || ids.some((id) => !stageIds.includes(id) || !isCommercialId(id))) throw new Error("Выберите конкретные этапы действующего согласованного плана. Неизвестные связи не удалены автоматически.");
    return [...ids];
  };
  if (q.kind === "advance-base") {
    if (!d.base || !d.vat) throw new Error("Выберите отдельно базу аванса и порядок учёта НДС.");
    return { kind: q.kind, base: d.base, vatTreatment: d.vat };
  }
  if (q.kind === "advance-days") {
    if (!d.dayKind) throw new Error("Укажите, какие дни применяются к сроку аванса.");
    return { kind: q.kind, dayKind: d.dayKind };
  }
  if (q.kind === "stage-plan") {
    if (!d.stages.length || d.stages.length > 100) throw new Error("Заполните от 1 до 100 этапов. Недостающий этап не придумывается автоматически.");
    return { kind: q.kind, stages: d.stages.map((stage, index) => ({ id: stage.id, title: required(stage.title, `Название этапа ${index + 1}`), scope: required(stage.scope, `Состав этапа ${index + 1}`), result: required(stage.result, `Результат этапа ${index + 1}`), duration: duration(stage.count, stage.dayKind, `Срок этапа ${index + 1}`) })), maximum: duration(d.maximumCount, d.maximumDayKind, "Общий максимальный срок") };
  }
  if (q.kind === "stage-parallelism") {
    if (!stageIds.length || !d.relations.length || d.relations.length > 1000) throw new Error("Нужен действующий план этапов и хотя бы одна конкретная связь.");
    return { kind: q.kind, relations: d.relations.map((relation) => {
      if (relation.kind === "after") { known([relation.stageId, relation.afterStageId], 2); return { kind: "after", stageId: relation.stageId, afterStageId: relation.afterStageId }; }
      if (relation.kind === "may-overlap") return { kind: "may-overlap", stageIds: known(relation.stageIds, 2), conditions: required(relation.conditions, "Условие параллельной работы") };
      throw new Error("Для каждой связи выберите последовательность или параллельную работу.");
    }) };
  }
  if (q.kind === "boundary-protocol") {
    if (!stageIds.length || !d.milestones.length || d.milestones.length > 100) throw new Error("Нужен действующий план этапов и конкретные контрольные точки.");
    return { kind: q.kind, milestones: d.milestones.map((point, index) => {
      if (!point.beforeStageIds.length && !point.afterStageIds.length) throw new Error(`Укажите положение контрольной точки ${index + 1} относительно этапов.`);
      return { title: required(point.title, `Название контрольной точки ${index + 1}`), condition: required(point.condition, `Условие контрольной точки ${index + 1}`), beforeStageIds: known(point.beforeStageIds, 0), afterStageIds: known(point.afterStageIds, 0) };
    }) };
  }
  if (!q.sourceReferenceIds.length) throw new Error("Исходные ссылки этого вопроса не найдены. Обновите подготовку документа.");
  if (d.referenceMode === "body-target") {
    if (!d.targetIds.length) throw new Error("Выберите конкретные разделы или пункты предложения, к которым относится ссылка.");
    return { kind: q.kind, referenceIds: [...q.sourceReferenceIds], resolution: { kind: d.referenceMode, targetIds: [...d.targetIds] } };
  }
  if (d.referenceMode === "governing-document") return { kind: q.kind, referenceIds: [...q.sourceReferenceIds], resolution: { kind: d.referenceMode, definitionTitle: required(d.definitionTitle, "Название действующего документа"), definitionText: required(d.definitionText, "Определение документа и события") } };
  if (d.referenceMode === "replace-clauses") {
    if (!d.replacements.length) throw new Error("Для вопроса не найдены собственные пункты для новой редакции.");
    return { kind: q.kind, referenceIds: [...q.sourceReferenceIds], resolution: { kind: d.referenceMode, replacements: d.replacements.map((part, index) => ({ blockId: part.blockId, publicText: required(part.publicText, `Новая редакция пункта ${index + 1}`) })) } };
  }
  throw new Error("Выберите конкретный способ разрешения исходных ссылок.");
}

/** Local unanswered form only. The owner alone installs a freshly validated
 * decision; preview, a stored answer, and save/export never approve this card. */
export function CommercialQuestionEditor(props: CommercialQuestionEditorProps) {
  const { doc, question, disabled = false, currentState, activeStages } = props;
  const stateKey = (value: CommercialQuestionEditorProps) => value.currentState?.question.id === value.question.id ? value.currentState.dependencyFingerprint : undefined;
  const [session, setSession] = useState(() => start(doc, question, stateKey(props)));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<"preview" | "apply" | null>(null);
  const [preview, setPreview] = useState<CommercialAnswerValidation | null>(null);
  const pendingRef = useRef(false), dirtyRef = useRef(false), operation = useRef(0), sequence = useRef(0), latest = useRef(props);
  latest.current = props;
  const staleFor = (value: CommercialQuestionEditorProps) => session.document !== value.doc || session.revision !== value.doc.revision || session.sourceKey !== value.doc.privateAppendix.sourceSnapshotKey || session.questionKey !== commercialCanonicalJson(value.question) || session.dependencyKey !== stateKey(value);
  const stale = staleFor(props), frozen = disabled || pending !== null || stale;
  const markDirty = (value: boolean) => { if (dirtyRef.current !== value) { dirtyRef.current = value; latest.current.onDirtyChange?.(value); } };
  // Listener identity is not a mount/dirty transition. Inline owner callbacks
  // must not generate false-cleanup/notify loops on every parent render.
  useEffect(() => { latest.current.onDirtyChange?.(dirtyRef.current); return () => { latest.current.onDirtyChange?.(false); }; }, []);
  useEffect(() => {
    if (!dirtyRef.current && !pendingRef.current && staleFor(latest.current)) {
      operation.current++; setSession(start(latest.current.doc, latest.current.question, stateKey(latest.current))); setPreview(null); setError(""); setNotice("");
    }
  }, [doc, doc.revision, doc.privateAppendix.sourceSnapshotKey, question, currentState?.dependencyFingerprint, pending, session]);
  const current = currentState?.question.id === question.id ? currentState : undefined;
  const belongs = doc.questions.some((entry) => entry.id === question.id) && question.sourceClauseIds.every((id) => doc.privateAppendix.clauses.some((clause) => clause.id === id));
  const locked = () => latest.current.disabled || pendingRef.current || staleFor(latest.current);
  const change = (transform: (draft: Draft) => void) => {
    if (locked()) return;
    markDirty(true);
    setSession((old) => { const next = structuredClone(old.draft); transform(next); return { ...old, draft: next }; }); setPreview(null); setError(""); setNotice("");
  };
  const freshId = (prefix: string, used: string[]) => { let next: string; do { next = `${prefix}-${++sequence.current}`; } while (used.includes(next)); return next; };
  const field = (label: string, value: string, update: (value: string) => void, multiline = false) => <label>{label}{multiline
    ? <textarea aria-label={label} value={value} rows={4} onChange={(event) => update(event.target.value)} />
    : <input aria-label={label} value={value} onChange={(event) => update(event.target.value)} />}{Array.from(value).length > 20000 && <small role="alert">Больше 20 000 символов. Текст не усечён; сократите его осознанно.</small>}</label>;
  const select = (label: string, value: string, options: readonly (readonly [string, string])[], update: (value: string) => void) => <label>{label}<select aria-label={label} value={value} onChange={(event) => update(event.target.value)}><option value="">Выберите явно</option>{value && !options.some(([id]) => id === value) && <option value={value} disabled>Ранее выбранное значение сейчас недоступно</option>}{options.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>;
  const daySelect = (label: string, value: Day, update: (value: Day) => void) => select(label, value, [["calendar", "Календарные дни"], ["business", "Рабочие дни"]], (next) => update(next as Day));
  const stageOptions = (activeStages || []).map((stage) => [stage.id, stage.title] as const);
  const localLabels = new Map<string, string>();
  doc.body.sections.forEach((section, si) => { localLabels.set(section.id, `раздел ${si + 1}`); section.blocks.forEach((block, bi) => localLabels.set(block.id, `пункт ${si + 1}.${bi + 1}`)); });
  const displayedText = (block: CommercialBlock) => blockText(block, (id) => localLabels.get(id) || "[цель ссылки не найдена]");
  const checks = (label: string, selected: string[], options: readonly (readonly [string, string])[], update: (value: string[]) => void) => <fieldset className="commercial-question-choices"><legend>{label}</legend>{options.map(([id, title]) => <label key={id} className="commercial-question-check"><input type="checkbox" aria-label={`${label}: ${title}`} checked={selected.includes(id)} onChange={(event) => update(event.target.checked ? [...selected, id] : selected.filter((value) => value !== id))} />{title}</label>)}{selected.some((id) => !options.some(([key]) => key === id)) && <p className="notice warning">В черновике есть этапы или цели, которых больше нет среди доступных. Они не удалены автоматически; проверьте ответ.</p>}</fieldset>;
  const previewBlock = (block: CommercialBlock): ReactNode => block.kind === "paragraph" ? <p key={block.id}>{displayedText(block)}</p> : block.kind === "list" ? <ul key={block.id}>{block.items.map((parts, index) => <li key={index}>{displayedText({ id: "preview", kind: "paragraph", style: "body", content: parts })}</li>)}</ul> : <div key={block.id} className="commercial-question-table"><table><thead><tr>{block.columns.map((column, index) => <th key={index}>{column}</th>)}</tr></thead><tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((parts, ci) => <td key={ci}>{displayedText({ id: "preview", kind: "paragraph", style: "body", content: parts })}</td>)}</tr>)}</tbody></table></div>;
  const run = async (kind: "preview" | "apply") => {
    if (locked() || !belongs || current?.sourceCurrent === false) return;
    let answer: CommercialTermAnswer;
    try { answer = answerFor(session, latest.current.activeStages); } catch (reason) { setError(reason instanceof Error ? reason.message : "Заполните конкретный ответ."); return; }
    const ticket = ++operation.current;
    pendingRef.current = true; setPending(kind); setError(""); setNotice("");
    try {
      if (kind === "preview") {
        const result = latest.current.onPreview ? await latest.current.onPreview(answer) : await validateTermAnswer(doc, question.id, answer);
        if (ticket !== operation.current) return;
        if (staleFor(latest.current) || latest.current.disabled) { setError("Документ или доступ изменился во время проверки. Ввод сохранён, результат проверки не применён."); return; }
        setPreview(result);
        if (!result.valid) setError("Решение пока нельзя применить. Проверьте конкретные замечания ниже; ввод сохранён.");
      } else {
        const accepted = await latest.current.onApply(answer);
        if (ticket !== operation.current) return;
        if (latest.current.question.id !== session.question.id || latest.current.doc.privateAppendix.documentId !== session.document.privateAppendix.documentId || latest.current.doc.privateAppendix.sourceSnapshotKey !== session.sourceKey) { setError("Во время применения открыт другой документ или источник. Этот ответ сохранён в поле; проверяйте актуальное состояние у редактора."); return; }
        if (accepted !== true) { setError("Редактор не принял решение. Ввод сохранён; проверьте актуальную редакцию и доступ."); return; }
        markDirty(false);
        setNotice("Редактор принял решение. Готовность всего предложения проверяется отдельно.");
      }
    } catch (reason) { if (ticket === operation.current) setError(`${reason instanceof Error ? reason.message : "Не удалось проверить или применить решение"}. Ввод сохранён.`); }
    finally { if (ticket === operation.current) { pendingRef.current = false; setPending(null); } }
  };
  const reset = () => { if (latest.current.disabled || pendingRef.current) return; operation.current++; markDirty(false); setSession(start(latest.current.doc, latest.current.question, stateKey(latest.current))); setPreview(null); setError(""); setNotice(""); };
  const d = session.draft, kind = session.question.kind;
  const targets = doc.body.sections.flatMap((section, si) => [
    ...(!section.blocks.some((block) => question.targetBlockIds.includes(block.id)) ? [[section.id, `${si + 1}. ${section.title}`] as const] : []),
    ...section.blocks.filter((block) => !question.targetBlockIds.includes(block.id)).map((block) => [block.id, `Пункт ${si + 1}.${section.blocks.indexOf(block) + 1}: ${displayedText(block).slice(0, 120)}`] as const),
  ]);
  const stateLabels = { unresolved: "Требуется конкретное решение", resolved: "Есть действующее применённое решение", stale: "Прежнее решение требует проверки", blocked: "Сначала устраните связанные ошибки" };
  return <section className="commercial-question-editor" aria-label={commercialQuestionLabel(doc, question)} aria-busy={pending !== null}>
    <h5>{commercialQuestionLabel(doc, question)}</h5><p>{question.message}</p>
    {current && <p className="help-text">{stateLabels[current.status]}</p>}
    {stale && dirtyRef.current && <p className="notice warning" role="alert">Документ, вопрос или зависимая цена изменились. Неприменённый ответ сохранён ниже и не заменит новую редакцию. Скопируйте нужный текст перед началом заново.</p>}
    {!belongs && <p className="notice error">Вопрос или его исходные фрагменты не найдены в текущем документе. Применение недоступно.</p>}
    {error && <p className="notice error" role="alert">{commercialReadableMessage(doc, error)}</p>}{notice && <p role="status">{notice}</p>}
    <fieldset disabled={frozen} className="commercial-question-fields"><legend className="sr-only">Конкретный ответ</legend>
      {kind === "advance-base" && <><div className="commercial-question-grid">{select("База расчёта аванса", d.base, [["net", "От цены без НДС"], ["gross", "От цены с НДС"]], (value) => change((next) => { next.base = value as Draft["base"]; }))}{select("Порядок учёта НДС в авансе", d.vat, [["included", "НДС уже включён в выбранную сумму"], ["additional", "Начислить НДС дополнительно"]], (value) => change((next) => { next.vat = value as Draft["vat"]; }))}</div><p className="help-text">База и НДС выбираются независимо. Сумму считает редактор по действующей цене; исходная цена не применяется автоматически.</p>{d.base === "gross" && d.vat === "additional" && <p className="notice warning">НДС поверх цены с НДС — отдельное финансовое условие, требующее согласования.</p>}</>}
      {kind === "advance-days" && daySelect("Какие дни применяются к авансу", d.dayKind, (value) => change((next) => { next.dayKind = value; }))}
      {kind === "stage-plan" && <><p className="help-text">Из источника заполнено этапов: {d.stages.length}. Это черновик, не согласованный план. Недостающий этап и общий максимум не вычисляются по сумме сроков.</p>{d.stages.map((stage, index) => <details key={stage.id} className="commercial-question-item"><summary>{stageCaption(stage.title, index)} — {stage.count ? `${stage.count} ${dayName(stage.dayKind)}` : "срок не заполнен"}</summary>
        {field(`Название этапа ${index + 1}`, stage.title, (value) => change((next) => { next.stages[index].title = value; }))}{field(`Состав работ этапа ${index + 1}`, stage.scope, (value) => change((next) => { next.stages[index].scope = value; }), true)}{field(`Результат этапа ${index + 1}`, stage.result, (value) => change((next) => { next.stages[index].result = value; }), true)}<div className="commercial-question-grid">{field(`Срок этапа ${index + 1}`, stage.count, (value) => change((next) => { next.stages[index].count = value; }))}{daySelect(`Вид дней этапа ${index + 1}`, stage.dayKind, (value) => change((next) => { next.stages[index].dayKind = value; }))}</div>{stage.sourceDurationText && <p className="help-text">Исходная формулировка срока: {stage.sourceDurationText}. Зависимости и условия отдельно проверяются перед применением.</p>}<button type="button" className="secondary" onClick={() => change((next) => { next.stages.splice(index, 1); })}>Удалить этап {index + 1}</button></details>)}
        <button type="button" className="secondary" disabled={d.stages.length >= 100} onClick={() => change((next) => { next.stages.push({ id: freshId("stage-user", next.stages.map((stage) => stage.id)), title: "", scope: "", result: "", count: "", dayKind: "" }); })}>Добавить этап</button><div className="commercial-question-grid">{field("Общий максимальный срок", d.maximumCount, (value) => change((next) => { next.maximumCount = value; }))}{daySelect("Вид дней общего максимума", d.maximumDayKind, (value) => change((next) => { next.maximumDayKind = value; }))}</div></>}
      {(kind === "stage-parallelism" || kind === "boundary-protocol") && !stageOptions.length && <p className="notice warning">Сначала примените и проверьте план этапов. Без действующих этапов нельзя согласовать связи или контрольные точки.</p>}
      {kind === "stage-parallelism" && <>{d.relations.map((relation, index) => <details key={relation.id} className="commercial-question-item"><summary>Связь {index + 1}: {relation.kind === "after" ? "последовательность" : relation.kind === "may-overlap" ? "параллельная работа" : "тип не выбран"}</summary>{select(`Тип связи ${index + 1}`, relation.kind, [["after", "Начать после завершения другого этапа"], ["may-overlap", "Разрешить параллельную работу"]], (value) => change((next) => { next.relations[index].kind = value as Relation["kind"]; }))}{relation.kind === "after" && <div className="commercial-question-grid">{select(`Начинающийся этап связи ${index + 1}`, relation.stageId, stageOptions, (value) => change((next) => { next.relations[index].stageId = value; }))}{select(`После завершения этапа связи ${index + 1}`, relation.afterStageId, stageOptions, (value) => change((next) => { next.relations[index].afterStageId = value; }))}</div>}{relation.kind === "may-overlap" && <>{checks(`Этапы параллельной связи ${index + 1}`, relation.stageIds, stageOptions, (value) => change((next) => { next.relations[index].stageIds = value; }))}{field(`Условие параллельной связи ${index + 1}`, relation.conditions, (value) => change((next) => { next.relations[index].conditions = value; }), true)}</>}<button type="button" className="secondary" onClick={() => change((next) => { next.relations.splice(index, 1); })}>Удалить связь {index + 1}</button></details>)}<button type="button" className="secondary" disabled={!stageOptions.length || d.relations.length >= 1000} onClick={() => change((next) => { next.relations.push({ id: freshId("relation", next.relations.map((entry) => entry.id)), kind: "", stageId: "", afterStageId: "", stageIds: [], conditions: "" }); })}>Добавить связь</button></>}
      {kind === "boundary-protocol" && <>
        {d.milestones.map((point, index) => <details key={point.id} className="commercial-question-item">
          <summary>Контрольная точка {index + 1}: {point.title || "Название не заполнено"}</summary>
          {field(`Название контрольной точки ${index + 1}`, point.title, (value) => change((next) => { next.milestones[index].title = value; }))}
          {field(`Условие контрольной точки ${index + 1}`, point.condition, (value) => change((next) => { next.milestones[index].condition = value; }), true)}
          <p className="help-text">Для разрешения тестирования поддерживается явное условие: «Границы согласованы, письменное разрешение получено». Неясные, условные или отрицающие формулировки остаются для проверки; наличие похожих слов не подтверждает разрешение.</p>
          {checks(`До начала этапов, точка ${index + 1}`, point.beforeStageIds, stageOptions, (value) => change((next) => { next.milestones[index].beforeStageIds = value; }))}
          {checks(`После завершения этапов, точка ${index + 1}`, point.afterStageIds, stageOptions, (value) => change((next) => { next.milestones[index].afterStageIds = value; }))}
          <button type="button" className="secondary" onClick={() => change((next) => { next.milestones.splice(index, 1); })}>Удалить контрольную точку {index + 1}</button>
        </details>)}
        <button type="button" className="secondary" disabled={!stageOptions.length || d.milestones.length >= 100} onClick={() => change((next) => { next.milestones.push({ id: freshId("milestone", next.milestones.map((entry) => entry.id)), title: "", condition: "", beforeStageIds: [], afterStageIds: [] }); })}>Добавить контрольную точку</button>
      </>}
      {kind === "source-reference" && <>{select("Как разрешить исходные ссылки", d.referenceMode, [["body-target", "Связать с конкретными пунктами предложения"], ["governing-document", "Определить действующий документ и события"], ["replace-clauses", "Задать новую редакцию собственных пунктов"]], (value) => change((next) => { next.referenceMode = value as Draft["referenceMode"]; }))}
        {d.referenceMode === "body-target" && checks("Цели исходной ссылки", d.targetIds, targets, (value) => change((next) => { next.targetIds = value; }))}{d.referenceMode === "governing-document" && <>{field("Название действующего документа", d.definitionTitle, (value) => change((next) => { next.definitionTitle = value; }))}{field("Определение документа и события", d.definitionText, (value) => change((next) => { next.definitionText = value; }), true)}<p className="help-text">Объясните, какой документ и момент подписания или другое событие применяются. Исходный договор не становится этим КП автоматически.</p></>}{d.referenceMode === "replace-clauses" && d.replacements.map((part, index) => <div key={part.blockId}>{field(`Новая редакция пункта ${index + 1}`, part.publicText, (value) => change((next) => { next.replacements[index].publicText = value; }), true)}<details><summary>Текущий текст пункта {index + 1}</summary><pre>{doc.body.sections.flatMap((section) => section.blocks).filter((block) => block.id === part.blockId).map(displayedText).join("\n")}</pre></details></div>)}</>}
    </fieldset>
    <div className="commercial-question-actions"><button type="button" className="secondary" disabled={frozen || !belongs || current?.sourceCurrent === false} onClick={() => run("preview")}>{pending === "preview" ? "Проверяю изменения…" : "Посмотреть изменения"}</button><button type="button" className="primary" disabled={frozen || !belongs || current?.sourceCurrent === false} onClick={() => run("apply")}>{pending === "apply" ? "Применяю решение…" : "Применить решение"}</button><button type="button" className="secondary" disabled={disabled || pending !== null} onClick={reset}>Начать заново по текущей редакции</button></div>
    {preview && !stale && <section className="commercial-question-preview" aria-label="Предварительный просмотр решения"><h6>Предлагаемые изменения — ещё не применены</h6>{commercialIssueGroups(preview.issues).map(({ key, issue, entries }) => <p key={key} className={`notice ${issue.severity === "error" ? "error" : "warning"}`} data-issue-paths={entries.map((entry) => entry.path).join(" ")}>{commercialIssueMessage(doc, issue)}{entries.length > 1 ? ` · замечаний: ${entries.length}` : ""}</p>)}{preview.previewBlocks.map(previewBlock)}</section>}
    {commercialIssueGroups(current?.issues || []).map(({ key, issue, entries }) => <p key={key} className="help-text" data-issue-paths={entries.map((entry) => entry.path).join(" ")}>{commercialIssueMessage(doc, issue)}{entries.length > 1 ? ` · замечаний: ${entries.length}` : ""}</p>)}
    <details className="commercial-question-proof"><summary>Исходные условия и ссылки</summary>{[...new Set([...question.sourceClauseIds, ...session.prefillSourceIds])].map((id) => { const clause = doc.privateAppendix.clauses.find((entry) => entry.id === id); return clause ? <div key={id}><strong>{clause.sourceName} · {clause.locator}</strong><pre>{clause.quote}</pre></div> : <p key={id}>Исходный фрагмент не найден.</p>; })}{question.sourceReferenceIds.map((id) => { const ref = doc.privateAppendix.references.find((entry) => entry.id === id); return <p key={id}>Исходная ссылка: {ref?.printed || "не найдена"}</p>; })}</details>
    <p className="help-text">Можно оставить этот вопрос нерешённым в проверочном черновике. Ни выбор полей, ни предварительный просмотр не подтверждают готовность КП.</p>
  </section>;
}
