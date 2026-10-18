import { useEffect, useState } from "react";
import { commercialIssueGroups, commercialIssueMessage, commercialQuestionLabel, commercialReadableMessage } from "./CommercialQuestionEditor";
import { projectReadiness, type CommercialReadiness } from "./commercialDecisions";
import type { CommercialIssue, ProposalCommercialDocumentV1 } from "./commercialDocument";
import type { ProposalData, ProposalIssue } from "./types";

interface Evaluation {
  sessionKey: string; document: ProposalCommercialDocumentV1; revision: number; sourceKey: string;
  lines: ProposalData["lines"]; currency: ProposalData["currency"]; readiness?: CommercialReadiness; failed?: boolean;
}
interface Props {
  sessionKey: string; value: ProposalData; proposalIssueCount: number;
  onOpenQuestion: (questionId: string) => void;
  onOpenSection: (sectionId?: string) => void;
  onOpenIssue: (issue: ProposalIssue) => void;
}

/** Read-only overview, not an export gate, Apply action or saved receipt.
 * Only a mounted final step evaluates; stable callback/metadata renders do not
 * start more work. Old source/document/session results are never displayed. */
export function ProposalFinalReview({ sessionKey, value, proposalIssueCount, onOpenQuestion, onOpenSection, onOpenIssue }: Props) {
  const doc = value.commercialDocument, [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  useEffect(() => {
    let alive = true;
    if (!doc) { setEvaluation(null); return () => { alive = false; }; }
    const base = { sessionKey, document: doc, revision: doc.revision, sourceKey: doc.privateAppendix.sourceSnapshotKey, lines: value.lines, currency: value.currency };
    const captured = structuredClone({ document: doc, pricing: { lines: value.lines, currency: value.currency } });
    void projectReadiness(captured.document, { pricing: captured.pricing }).then(readiness => {
      if (alive) setEvaluation({ ...base, readiness });
    }).catch(() => { if (alive) setEvaluation({ ...base, failed: true }); });
    return () => { alive = false; };
  }, [sessionKey, doc, doc?.revision, doc?.privateAppendix.sourceSnapshotKey, value.lines, value.currency]);
  if (!doc) return null;
  const current = evaluation?.sessionKey === sessionKey && evaluation.document === doc && evaluation.revision === doc.revision
    && evaluation.sourceKey === doc.privateAppendix.sourceSnapshotKey && evaluation.lines === value.lines && evaluation.currency === value.currency ? evaluation : null;
  if (!current) return <p role="status">Проверяем актуальные вопросы документа…</p>;
  if (current.failed || !current.readiness) return <p className="notice error" role="alert">Не удалось обновить список вопросов документа. Откройте условия и повторите проверку; готовность не подтверждена.</p>;
  const readiness = current.readiness;
  const owns = (question: ProposalCommercialDocumentV1["questions"][number], issue: CommercialIssue) => issue.path === `questions.${question.id}`
    || question.sourceReferenceIds.some(id => issue.path === `privateAppendix.references.${id}`);
  const questions = doc.questions.map(question => ({ question, state: readiness.questions.find(state => state.question.id === question.id), issues: readiness.issues.filter(issue => owns(question, issue)) }))
    .filter(({ state, issues }) => !state?.activeDecision || state.status !== "resolved" || state.issues.length > 0 || issues.length > 0);
  const genericContexts = new Map<string, CommercialIssue[]>();
  for (const issue of readiness.issues.filter(issue => !doc.questions.some(question => owns(question, issue)))) {
    const coverage = doc.privateAppendix.coverage.find(entry => issue.path === `privateAppendix.coverage.${entry.sourceClauseId}`);
    const context = JSON.stringify([issue.sectionId || "", coverage?.kind === "external-field" ? coverage.field : ""]);
    const entries = genericContexts.get(context) || []; entries.push(issue); genericContexts.set(context, entries);
  }
  const generic = [...genericContexts].flatMap(([context, entries]) => commercialIssueGroups(entries).map(group => ({ ...group, key: `${context}:${group.key}` })));
  const openIssue = (issue: CommercialIssue) => {
    const coverage = doc.privateAppendix.coverage.find(entry => issue.path === `privateAppendix.coverage.${entry.sourceClauseId}`);
    if (coverage?.kind === "external-field") {
      onOpenIssue({ field: coverage.field === "pricing" ? "sourceFinancials" : "issuer.name", step: coverage.field === "pricing" ? 2 : 1, severity: "warning", message: commercialIssueMessage(doc, issue) });
    } else onOpenSection(doc.body.sections.some(section => section.id === issue.sectionId) ? issue.sectionId : undefined);
  };
  return <section aria-label="Общая проверка коммерческого документа">
    <h3>Вопросы документа перед выпуском</h3>
    <p>Замечаний к реквизитам и расчётам: {proposalIssueCount}. Открытых коммерческих вопросов: {questions.length} из {doc.questions.length}. Действующих применённых решений: {readiness.activeDecisionIds.length}.</p>
    <p className="help-text">Замечания не являются решениями. Сохранение рабочего проекта не означает готовность к отправке; право на окончательный выпуск проверяется заново при создании файла.</p>
    {questions.length > 0 ? <ul className="proposal-issues">{questions.map(({ question, state, issues }) => <li key={question.id} className="warning" data-commercial-review-question={question.id}>
      <button type="button" onClick={() => onOpenQuestion(question.id)}>Открыть {commercialQuestionLabel(doc, question)}</button>
      <p>{commercialReadableMessage(doc, question.message)}</p>
      {state?.activeDecision && <small>Решение применено, но связанные замечания ещё требуют проверки.</small>}
      {!state && <small>Проверка этого вопроса не завершена; он не считается решённым.</small>}
      {issues.length > 0 && <details><summary>Связанные замечания</summary><ul>{commercialIssueGroups(issues).map(({ key, issue }) => <li key={key}>{commercialIssueMessage(doc, issue)}</li>)}</ul></details>}
    </li>)}</ul> : <p>Открытых коммерческих вопросов нет. Это не заменяет остальные проверки перед выпуском.</p>}
    {generic.length > 0 && <details><summary>Другие проверки документа: {generic.length}</summary><ul className="proposal-issues">{generic.map(({ key, issue, entries }) => <li key={key} className="warning"><button type="button" onClick={() => openIssue(issue)}>Открыть проверку: {commercialIssueMessage(doc, issue)}</button>{entries.length > 1 && <small> · замечаний: {entries.length}</small>}</li>)}</ul></details>}
  </section>;
}
