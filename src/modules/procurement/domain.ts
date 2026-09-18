import type { CashFlowEvent, ContractRisk, GoNoGoCriterion, ProcurementData, ProcurementDocumentVersion, ProcurementRequirement, ResourceAllocation } from "./types";
import type { ContractData } from "../contracts/types";
import type { StaffData } from "../staff/types";
import { calendarDaysUntil, submissionPending } from "./deadlines";

export type RebidPreset = "comfort" | "working-minimum" | "any-price";
export interface RebidStep { number: number; price: number; reduction: number; profit: number; margin: number; headroom: number; loss: boolean; }

export function buildRebidSteps(nmc: number, cost: number, count: number, reductionPercent: number, preset: RebidPreset): RebidStep[] {
  if (!Number.isFinite(nmc) || !Number.isFinite(cost) || nmc <= 0 || cost < 0) throw new Error("Укажите корректные НМЦ и себестоимость.");
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("Количество шагов должно быть от 1 до 20.");
  if (!Number.isFinite(reductionPercent) || reductionPercent <= 0 || reductionPercent > 50) throw new Error("Снижение должно быть больше 0 и не более 50%. ");
  const floorMultiplier = preset === "comfort" ? 1.15 : preset === "working-minimum" ? 1.03 : 0;
  return Array.from({ length: count }, (_, index) => {
    const raw = nmc * (1 - reductionPercent / 100 * index);
    const price = preset === "any-price" ? Math.max(0, raw) : Math.max(cost * floorMultiplier, raw);
    const profit = price - cost;
    return { number: index + 1, price, reduction: nmc - price, profit, margin: price ? profit / price * 100 : 0, headroom: price - cost, loss: profit < 0 };
  });
}

export function complianceSummary(requirements: ProcurementRequirement[]) {
  const gaps = requirements.filter((item) => ["Не подтверждено", "Частично подтверждено", "Требует уточнения", "Истечёт до подачи", "Истечёт до завершения работ"].includes(item.status));
  const questions = requirements.filter((item) => item.status === "Требует уточнения" || item.question.trim()).map((item) => item.question.trim() || item.text);
  return { confirmed: requirements.filter((item) => item.status === "Подтверждено").length, total: requirements.length, gaps, questions };
}

export function calculateGoNoGo(criteria: GoNoGoCriterion[]) {
  const assessed = criteria.filter((criterion) => criterion.status !== "Не оценено");
  const totalWeight = criteria.reduce((sum, criterion) => sum + Math.max(0, criterion.weight), 0);
  const earnedWeight = criteria.reduce((sum, criterion) => {
    const factor = criterion.status === "Соответствует" ? 1 : criterion.status === "При условии" ? 0.5 : 0;
    return sum + Math.max(0, criterion.weight) * factor;
  }, 0);
  const blockingFailure = criteria.some((criterion) => criterion.blocking && criterion.status === "Не соответствует");
  const blockingPending = criteria.some((criterion) => criterion.blocking && ["При условии", "Не оценено"].includes(criterion.status));
  const score = totalWeight > 0 ? earnedWeight / totalWeight * 100 : 0;
  const decision = assessed.length === 0 ? "Решение не принято"
    : blockingFailure || score < 40 ? "Не участвовать"
      : blockingPending || assessed.length < criteria.length || score < 75 ? "Участвовать при выполнении условий"
        : "Участвовать";
  return { score, decision: decision as ProcurementData["goNoGoDecision"]["calculated"], blockingFailure, blockingPending };
}

export function confirmGoNoGo(item: ProcurementData, decision: ProcurementData["goNoGoDecision"]["confirmed"], author: string, comment: string, now = new Date()) {
  if (!author.trim()) throw new Error("Укажите автора решения.");
  return { ...item, goNoGoDecision: { calculated: calculateGoNoGo(item.goNoGoCriteria).decision, confirmed: decision, author: author.trim(), decidedAt: now.toISOString(), comment: comment.trim(), inputRevision: item.revision, requiresReview: false } };
}

export function markSignificantChange(item: ProcurementData): ProcurementData {
  const revision = item.revision + 1;
  return { ...item, revision, goNoGoDecision: { ...item.goNoGoDecision, requiresReview: item.goNoGoDecision.confirmed !== "Решение не принято" && item.goNoGoDecision.inputRevision < revision } };
}

export function replaceDocumentVersion(item: ProcurementData, version: ProcurementDocumentVersion): ProcurementData {
  const previousVersions = item.documentVersions.filter((entry) => entry.documentId === version.documentId);
  if (previousVersions.some((entry) => entry.sha256 === version.sha256)) throw new Error("Такая версия документа уже добавлена.");
  const previous = previousVersions[previousVersions.length - 1];
  const nextVersion = previous && !version.supersedesVersionId ? { ...version, supersedesVersionId: previous.versionId } : version;
  const requirements = item.requirements.map((requirement) => ({ ...requirement, evidenceLinks: requirement.evidenceLinks.map((evidence) => evidence.documentId === version.documentId && evidence.versionId !== version.versionId ? { ...evidence, stale: true } : evidence) }));
  return markSignificantChange({ ...item, requirements, documentVersions: [...item.documentVersions, nextVersion] });
}

export function cashFlowSummary(events: CashFlowEvent[]) {
  let balance = 0;
  let minimumBalance = 0;
  let minimumDate = "";
  const byDate = new Map<string, CashFlowEvent[]>();
  for (const event of events) {
    if (!event.date || !Number.isFinite(event.amount)) continue;
    byDate.set(event.date, [...(byDate.get(event.date) || []), event]);
  }
  const timeline: Array<CashFlowEvent & { balance: number }> = [];
  for (const [date, entries] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    balance += entries.reduce((sum, event) => sum + event.amount, 0);
    if (balance < minimumBalance) { minimumBalance = balance; minimumDate = date; }
    // No order within a day is supplied by the user: show the end-of-day balance.
    timeline.push(...entries.map((event) => ({ ...event, balance })));
  }
  return { timeline, closingBalance: balance, maximumCashGap: Math.abs(Math.min(0, minimumBalance)), maximumCashGapDate: minimumDate, undatedEvents: events.filter((event) => !event.date || !Number.isFinite(event.amount)).length };
}

export function scenarioFinancials(scenario: ProcurementData["participationScenarios"][number]) {
  if (scenario.vatRate < 0 || scenario.vatRate > 100) throw new Error("Ставка НДС должна быть от 0 до 100%.");
  const priceNet = scenario.customerPriceGross / (1 + scenario.vatRate / 100);
  const outputVat = scenario.customerPriceGross - priceNet;
  const partnerCost = priceNet * Math.max(0, scenario.partnerShare) / 100;
  const fullCosts = scenario.directCosts + scenario.overheadCosts + scenario.financingCosts + partnerCost;
  const profit = priceNet - fullCosts;
  return { priceNet, outputVat, partnerCost, fullCosts, profit, margin: priceNet ? profit / priceNet * 100 : 0, markup: fullCosts ? profit / fullCosts * 100 : 0, profitability: fullCosts ? profit / fullCosts * 100 : 0, headroom: scenario.customerPriceGross - scenario.minimumPrice };
}

export function resourceConflicts(entries: ResourceAllocation[]) {
  const conflicts: Array<{ id: string; staffSnapshotId: string; firstId: string; secondId: string; reason: string }> = [];
  for (const staffSnapshotId of new Set(entries.map((entry) => entry.staffSnapshotId).filter(Boolean))) {
    const allocations = entries.filter((entry) => entry.staffSnapshotId === staffSnapshotId);
    const emitted = new Set<string>();
    for (const date of new Set(allocations.map((entry) => entry.startDate || "0000-01-01"))) {
      const active = allocations.filter((entry) => (!entry.startDate || entry.startDate <= date) && (!entry.endDate || entry.endDate >= date));
      const load = active.reduce((sum, entry) => sum + (Number.isFinite(entry.loadPercent) ? Math.max(0, entry.loadPercent) : 0), 0);
      const id = active.map((entry) => entry.id).sort().join(":");
      if (load <= 100 || emitted.has(id)) continue;
      emitted.add(id);
      conflicts.push({ id, staffSnapshotId, firstId: active[0].id, secondId: active[1]?.id || active[0].id,
        reason: `${active[0].title || "Сотрудник"}: суммарная загрузка ${load}% превышает 100%${date === "0000-01-01" ? " (период не указан)" : ` на ${date}`}. Назначений: ${active.length}.` });
    }
  }
  return conflicts;
}

const contractRules: Array<{ id: string; category: string; severity: ContractRisk["severity"]; pattern: RegExp; explanation: string; action: string }> = [
  { id: "penalties", category: "Штрафы и пени", severity: "Высокий", pattern: /пен[яи]|штраф/iu, explanation: "Найдены условия о санкциях. Размер и предел ответственности нужно проверить вручную.", action: "Сопоставить санкции с ценой и сроками договора." },
  { id: "unlimited-liability", category: "Неограниченная ответственность", severity: "Критический", pattern: /неограниченн\w+\s+ответственност|в полном объ[её]ме убыт/iu, explanation: "Правило обнаружило возможную неограниченную ответственность.", action: "Предложить предельный размер ответственности." },
  { id: "unilateral-scope", category: "Одностороннее изменение объёма", severity: "Высокий", pattern: /односторонн\w+.*измен.*объ[её]м|заказчик вправе измен/iu, explanation: "Заказчик может менять объём без явного согласования.", action: "Уточнить предел изменения и порядок пересмотра цены." },
  { id: "acceptance", category: "Критерии приёмки", severity: "Средний", pattern: /по усмотрению заказчика|критери.*при[её]мк.*не определ/iu, explanation: "Критерии приёмки могут быть неопределёнными.", action: "Зафиксировать измеримые критерии и сроки приёмки." },
  { id: "payment-delay", category: "Отсрочка оплаты", severity: "Высокий", pattern: /(?:9[0-9]|[1-9][0-9]{2,})\s*(?:(?:календарных|рабочих)\s+)?дн(?:ей|я|ь)?/iu, explanation: "Найдена длительная отсрочка, возможен кассовый разрыв.", action: "Включить стоимость финансирования в сценарий." },
  { id: "free-extra-work", category: "Дополнительные работы", severity: "Критический", pattern: /дополнительн\w+ работ\w+ без.*оплат|без увеличения цен/iu, explanation: "Возможна обязанность выполнить дополнительные работы без оплаты.", action: "Ограничить объём и согласовать изменение цены." },
  { id: "exclusive-rights", category: "Исключительные права", severity: "Высокий", pattern: /исключительн\w+ прав/iu, explanation: "Найдена передача исключительных прав.", action: "Проверить состав результатов и ранее созданные материалы." },
  { id: "subcontract-ban", category: "Запрет субподряда", severity: "Высокий", pattern: /запрещ.*субподряд|без привлечения третьих лиц/iu, explanation: "Правило обнаружило ограничение привлечения исполнителей.", action: "Сверить ограничение с выбранной схемой участия." },
  { id: "termination", category: "Расторжение и аванс", severity: "Высокий", pattern: /односторонн\w+ отказ|возврат.*аванс/iu, explanation: "Найдены условия расторжения или возврата аванса.", action: "Проверить основания, сроки и уже понесённые расходы." },
];

export function detectContractRisks(text: string): ContractRisk[] {
  return contractRules.flatMap((rule) => {
    const match = text.match(rule.pattern)?.[0];
    return match ? [{ id: crypto.randomUUID(), category: rule.category, severity: rule.severity, ruleId: rule.id, match, explanation: rule.explanation, action: rule.action, publicComment: `Просим уточнить условие: ${rule.category.toLowerCase()}.`, accepted: false }] : [];
  });
}

export function applicationCompleteness(item: ProcurementData) {
  const missing = item.checklist.filter((entry) => entry.mandatory && !entry.done).map((entry) => entry.text || "Обязательный пункт без названия");
  const invalidFiles = item.checklist.filter((entry) => entry.done && (!entry.fileVersionId || entry.validation.trim() || !item.documentVersions.some((document) => document.versionId === entry.fileVersionId && document.relativePath))).map((entry) => entry.text || "Пункт заявки");
  const staleEvidence = item.requirements.flatMap((requirement) => requirement.evidenceLinks.filter((entry) => entry.stale).map(() => requirement.text));
  const blockers: string[] = [];
  if (!item.name.trim() || !item.customer.trim() || !item.subject.trim()) blockers.push("Заполните название, заказчика и предмет закупки.");
  if (!Number.isFinite(item.nmc) || item.nmc <= 0) blockers.push("Укажите НМЦ больше нуля.");
  if (!item.submissionDeadline) blockers.push("Укажите срок подачи заявки.");
  if (item.requirements.length === 0) blockers.push("Требования закупки ещё не проверены.");
  for (const requirement of item.requirements) {
    if (requirement.mandatory && !["Подтверждено", "Неприменимо"].includes(requirement.status)) blockers.push(`Обязательное требование не закрыто: ${requirement.text || "без названия"}.`);
  }
  if (item.checklist.length === 0) blockers.push("Комплект заявки ещё не определён.");
  const decision = item.goNoGoDecision;
  if (!["Участвовать", "Участвовать при выполнении условий"].includes(decision.confirmed) || !decision.author.trim() || !decision.decidedAt) blockers.push("Решение об участии не подтверждено.");
  else if (decision.requiresReview || decision.inputRevision < item.revision) blockers.push("Решение об участии требует пересмотра.");
  if (decision.confirmed === "Участвовать при выполнении условий") blockers.push("Проверьте и закройте условия участия, затем подтвердите решение.");
  if (calculateGoNoGo(item.goNoGoCriteria).decision !== "Участвовать") blockers.push("Оценка критериев участия не завершена или содержит ограничения.");
  blockers.push(...resourceConflicts(item.resourcePlan).map((entry) => entry.reason));
  if (item.resourcePlan.some((entry) => !entry.availabilityConfirmed)) blockers.push("Доступность назначенных сотрудников не подтверждена.");
  const unassessed = !item.requirements.length && !item.checklist.length;
  return { ready: blockers.length === 0 && missing.length === 0 && invalidFiles.length === 0 && staleEvidence.length === 0, unassessed, blockers, missing, invalidFiles, staleEvidence };
}

export function procurementWarnings(item: ProcurementData, now = new Date()) {
  const warnings: string[] = [];
  if (!item.name.trim() || !item.customer.trim() || !item.subject.trim()) warnings.push("Не заполнены название, заказчик или предмет закупки.");
  if (!Number.isFinite(item.nmc) || item.nmc <= 0) warnings.push("НМЦ должна быть больше нуля.");
  if ([item.resultDetails.finalPrice, item.resultDetails.actualCosts, item.resultDetails.initialPrice, item.resultDetails.bestKnownPrice].some((value) => !Number.isFinite(value) || value < 0)) warnings.push("Некорректно заполнены цены или фактические затраты результата: нужны конечные неотрицательные суммы.");
  if (item.resourcePlan.some((entry) => !Number.isFinite(entry.loadPercent) || entry.loadPercent < 0 || entry.loadPercent > 100 || (entry.startDate && entry.endDate && entry.startDate > entry.endDate))) warnings.push("Некорректно заполнен ресурсный план: загрузка от 0 до 100%, окончание не раньше начала.");
  if (item.partners.some((entry) => !Number.isFinite(entry.workShare) || entry.workShare < 0)) warnings.push("Некорректно заполнена доля партнёра: укажите неотрицательный процент.");
  if (item.questionDeadline && item.submissionDeadline && item.questionDeadline > item.submissionDeadline) warnings.push("Срок вопросов позже срока подачи заявки.");
  const share = item.partners.reduce((sum, partner) => sum + partner.workShare, 0);
  if (share > 100) warnings.push(`Суммарная доля партнёров ${share}% превышает 100%.`);
  for (const scenario of item.participationScenarios) {
    if (!Number.isFinite(scenario.vatRate) || scenario.vatRate < 0 || scenario.vatRate > 100) {
      warnings.push(`Ставка НДС сценария «${scenario.name || "Без названия"}» должна быть от 0 до 100%.`);
    }
  }
  const due = calendarDaysUntil(item.submissionDeadline, now);
  if (due != null && due < 0 && submissionPending(item)) warnings.push("Срок подачи истёк, но закупка не отмечена как поданная или завершённая.");
  return warnings;
}

export function daysUntil(value: string, now = new Date()) {
  return calendarDaysUntil(value, now);
}

const significantWords = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((word) => word.length >= 4));
const relevance = (need: Set<string>, values: string[]) => {
  const candidate = significantWords(values.join(" "));
  return [...need].filter((word) => candidate.has(word)).length;
};

export function suggestedExperience(item: ProcurementData, records: Array<{ id: string; payload: ContractData }>): string[] {
  const need = significantWords([item.subject, ...item.requirements.map((row) => row.text)].join(" "));
  return records
    .filter((record) => record.payload.disclosureAllowed)
    .map((record) => ({ id: record.id, score: relevance(need, [record.payload.subject, record.payload.industry, record.payload.serviceType, record.payload.workScope, ...(record.payload.standards || [])]) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map((entry) => entry.id);
}

export function suggestedTeam(item: ProcurementData, records: Array<{ id: string; payload: StaffData }>): string[] {
  const need = significantWords([item.subject, ...item.requirements.map((row) => row.text)].join(" "));
  return records
    .filter((record) => record.payload.disclosureAllowed)
    .filter((record) => !item.submissionDeadline || !record.payload.availableFrom || record.payload.availableFrom <= item.submissionDeadline)
    .filter((record) => !item.submissionDeadline || !record.payload.availableTo || record.payload.availableTo >= item.submissionDeadline)
    .map((record) => ({ id: record.id, score: relevance(need, [record.payload.role, record.payload.grade, record.payload.qualification, record.payload.experienceNotes, ...(record.payload.skills || [])]) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .map((entry) => entry.id);
}
