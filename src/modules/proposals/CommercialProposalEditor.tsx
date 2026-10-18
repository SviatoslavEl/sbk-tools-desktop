import { useEffect, useRef, useState } from 'react';
import { CommercialDocumentView } from './CommercialDocumentView';
import { CommercialQuestionEditor } from './CommercialQuestionEditor';
import { commercialCanonicalJson, type CommercialTermAnswer, type ProposalCommercialDocumentV1 } from './commercialDocument';
import { applyTermDecision, projectReadiness, validateTermAnswer, type CommercialReadiness } from './commercialDecisions';
import type { ProposalData } from './types';

interface Evaluation { doc: ProposalCommercialDocumentV1; lines: ProposalData['lines']; currency: ProposalData['currency']; readiness?: CommercialReadiness; error?: string }
interface Props {
  sessionKey: string; value: ProposalData; disabled?: boolean;
  /** Exact sole-owner acceptance only, never a persistence/auth receipt. */
  onChange: (next: ProposalData) => boolean;
  onPendingChange?: (pending: boolean) => void;
}

/** One controlled document and local unresolved-answer forms. No native calls
 * are made while typing, previewing a term, or recomputing local readiness. */
export function CommercialProposalEditor(props: Props) {
  const { value, sessionKey, disabled = false } = props, doc = value.commercialDocument;
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const latest = useRef(props), pending = useRef(new Map<string, boolean>()), callbackOwner = useRef(sessionKey), pendingCallbacks = useRef(new Map<string, (dirty: boolean) => void>());
  latest.current = props;
  if (callbackOwner.current !== sessionKey) { callbackOwner.current = sessionKey; pending.current.clear(); pendingCallbacks.current.clear(); }
  const pendingCallback = (key: string) => {
    let existing = pendingCallbacks.current.get(key);
    if (!existing) {
      const owner = sessionKey;
      existing = (dirty) => {
        if (latest.current.sessionKey !== owner) return;
        if (dirty) pending.current.set(key, true); else pending.current.delete(key);
        latest.current.onPendingChange?.(pending.current.size > 0);
      };
      pendingCallbacks.current.set(key, existing);
    }
    return existing;
  };
  useEffect(() => {
    props.onPendingChange?.(false);
    return () => { props.onPendingChange?.(false); };
  }, [sessionKey]);
  useEffect(() => {
    let alive = true;
    if (!doc) { setEvaluation(null); return () => { alive = false; }; }
    const captured = structuredClone({ doc, pricing: { lines: value.lines, currency: value.currency } });
    void projectReadiness(captured.doc, { pricing: captured.pricing }).then((readiness) => {
      if (alive) setEvaluation({ doc, lines: value.lines, currency: value.currency, readiness });
    }).catch((reason) => { if (alive) setEvaluation({ doc, lines: value.lines, currency: value.currency, error: reason instanceof Error ? reason.message : 'Проверка условий не завершена.' }); });
    return () => { alive = false; };
  }, [doc, value.lines, value.currency]);
  if (!doc) return null;
  const ready = evaluation?.doc === doc && evaluation.lines === value.lines && evaluation.currency === value.currency ? evaluation : null;
  const assertCurrent = (owner: string, expectedDoc: ProposalCommercialDocumentV1, expectedLines: ProposalData['lines'], revision: number, sourceKey: string, bodyJson: string) => {
    const current = latest.current;
    if (current.disabled || current.sessionKey !== owner || current.value.commercialDocument !== expectedDoc || current.value.lines !== expectedLines
      || expectedDoc.revision !== revision || expectedDoc.privateAppendix.sourceSnapshotKey !== sourceKey
      || commercialCanonicalJson({ doc: expectedDoc, lines: expectedLines, currency: current.value.currency }) !== bodyJson) throw new Error('Документ, цена, сессия или доступ изменились. Ввод сохранён; повторите проверку актуальных условий.');
    return current;
  };
  const withAnswer = async (questionId: string, answer: CommercialTermAnswer, apply: boolean) => {
    const owner = latest.current.sessionKey, base = latest.current.value, baseDoc = base.commercialDocument;
    if (!baseDoc || latest.current.disabled) throw new Error('Документ сейчас недоступен для изменения.');
    const revision = baseDoc.revision, sourceKey = baseDoc.privateAppendix.sourceSnapshotKey, lines = base.lines;
    const bodyJson = commercialCanonicalJson({ doc: baseDoc, lines, currency: base.currency });
    const captured = structuredClone({ doc: baseDoc, pricing: { lines, currency: base.currency } });
    const validation = await validateTermAnswer(captured.doc, questionId, answer, { pricing: captured.pricing });
    assertCurrent(owner, baseDoc, lines, revision, sourceKey, bodyJson);
    if (!apply) return validation;
    if (!validation.valid) throw new Error(validation.issues[0]?.message || 'Конкретное решение пока нельзя применить.');
    const changed = await applyTermDecision(captured.doc, { questionId, answer, expectedRevision: revision, expectedDependencyFingerprint: validation.dependencyFingerprint, decisionId: crypto.randomUUID(), appliedAt: new Date().toISOString() }, { pricing: captured.pricing });
    const current = assertCurrent(owner, baseDoc, lines, revision, sourceKey, bodyJson);
    return current.onChange({ ...current.value, commercialDocument: changed.document });
  };
  const activePlan = ready?.readiness?.questions.find((state) => state.activeDecision?.answer.kind === 'stage-plan')?.activeDecision;
  const activeStages = activePlan?.answer.kind === 'stage-plan' ? activePlan.answer.stages.map(({ id, title }) => ({ id, title })) : undefined;
  return <>
    {!ready ? <p role="status">Проверяем связи и актуальность условий…</p> : ready.error ? <p className="notice error" role="alert">{ready.error} Сохранённый документ не изменён.</p> : ready.readiness && <details className="notice warning"><summary>{ready.readiness.canFinalize ? 'Связи исходных условий проверены' : 'Остаются вопросы для проверки'} · сохранить рабочий проект можно отдельно</summary><p>Это локальная проверка содержания, не разрешение раскрывать конфиденциальную информацию и не подтверждение сохранения или отправки.</p><ul>{[...new Set(ready.readiness.issues.map((issue) => issue.message))].map((message) => <li key={message}>{message}</li>)}</ul></details>}
    <CommercialDocumentView value={doc} readOnly={disabled} onPendingEditChange={pendingCallback('body')} onChange={(next) => {
      const current = latest.current;
      if (current.disabled || current.sessionKey !== sessionKey || current.value.commercialDocument !== doc) return false;
      return current.onChange({ ...current.value, commercialDocument: next });
    }} renderQuestion={(question) => <CommercialQuestionEditor key={question.id} doc={doc} question={question} disabled={disabled || !ready?.readiness} currentState={ready?.readiness?.questions.find((state) => state.question.id === question.id)} activeStages={activeStages} onDirtyChange={pendingCallback(`question:${question.id}`)} onPreview={async (answer) => {
      const result = await withAnswer(question.id, answer, false);
      if (typeof result === 'boolean') throw new Error('Проверка вернула неверный формат.');
      return result;
    }} onApply={async (answer) => (await withAnswer(question.id, answer, true)) === true} />}/>
  </>;
}
