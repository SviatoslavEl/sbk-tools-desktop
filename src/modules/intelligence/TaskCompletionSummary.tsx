import { destinationLabels } from "./workbenchModel";
import type { ItemTaskCompletion, TaskCompletionIssue, TaskCompletionReport, TaskCompletionStatus } from "./taskCompletion";

const labels: Record<TaskCompletionStatus, string> = {
  "review-ready": "Содержание подготовлено к проверке", partial: "Нужно ваше решение",
  insufficient: "Результат подготовлен не полностью", "not-assessed": "Полнота не установлена",
};
function groupedIssues(issues: TaskCompletionIssue[]) {
  const groups = new Map<string, TaskCompletionIssue[]>();
  for (const issue of issues) { const key = JSON.stringify([issue.code, issue.severity, issue.destination, issue.message]); groups.set(key, [...(groups.get(key) || []), issue]); }
  return [...groups.values()].map((group) => ({ ...group[0], count: group.length, evidence: [...new Map(group.flatMap((issue) => issue.evidence).map((proof) => [JSON.stringify(proof), proof])).values()] }));
}
export function TaskCompletionSummary({ report, previous = false }: { report?: TaskCompletionReport; previous?: boolean }) {
  if (!report) return null;
  return <section className={`notice ${report.status === "review-ready" ? "" : "warning"}`} aria-label="Полнота задачи">
    <strong>{previous ? "Предыдущий результат · " : ""}{labels[report.status]}</strong>
    <p>Сохранение фактов и готовность задачи проверяются отдельно. Это ещё не сохранённые карточки и не разрешение на отправку клиенту.</p>
    <div className="iw-task-destinations">{report.destinations.map((entry) => <p key={entry.destination}><strong>{destinationLabels[entry.destination]}</strong>: {entry.status === "no-applicable-data" ? "подходящих данных не установлено" : labels[entry.status]}{entry.counts.assessed > 0 ? ` · найдено условий ${entry.counts.covered} из ${entry.counts.assessed}` : ""}</p>)}</div>
    {report.issues.some((issue) => !issue.itemIds.length) && <details open><summary>Пропуски по выбранным направлениям</summary>{groupedIssues(report.issues.filter((issue) => !issue.itemIds.length)).map((issue) => <div key={issue.id}><p>{issue.message}{issue.count > 1 ? ` Исходных условий: ${issue.count}.` : ""}</p>{issue.evidence.length > 0 && <details><summary>Показать источники ({issue.evidence.length})</summary>{issue.evidence.map((proof, index) => <div key={index}><small>{proof.sourceName} · {proof.locator}</small><blockquote>{proof.quote}</blockquote></div>)}</details>}</div>)}</details>}
  </section>;
}

export function ItemTaskCompletionSummary({ report, item }: { report?: TaskCompletionReport; item?: ItemTaskCompletion }) {
  if (!report || !item) return null;
  const issues = groupedIssues(report.issues.filter((issue) => item.issueIds.includes(issue.id)));
  return <section className="iw-task-completion" aria-label="Содержание и оставшиеся вопросы">
    <strong>{labels[item.status]}</strong>
    {issues.length > 0 && <details open={item.status !== "review-ready"}><summary>Что осталось проверить ({issues.length})</summary>
      {issues.map((issue) => <div className={`iw-task-issue ${issue.severity}`} key={issue.id}><p>{issue.message}{issue.count > 1 ? ` Исходных условий: ${issue.count}.` : ""}</p>
        {issue.evidence.length > 0 && <details><summary>Показать условие в источнике</summary>{issue.evidence.map((proof, index) => <div key={`${proof.sourceId}-${proof.fragmentId}-${index}`}><small>{proof.sourceName} · {proof.locator}</small><blockquote>{proof.quote}</blockquote></div>)}</details>}
      </div>)}
    </details>}
  </section>;
}
