import type { CalculatorData } from "../calculator/types";
import type { ContractData } from "../contracts/types";
import type { StaffData } from "../staff/types";
import type { ProcurementData } from "./types";

export const html = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || character);
export const safeBase = (value: string) => value.replace(/[^\p{L}\p{N}._ -]+/gu, "_").trim() || "закупка";
export const money = (value: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value) + " ₽";

export function documentHtml(item: ProcurementData, title: string, body: string) {
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><title>${html(title)}</title><style>body{font:14px/1.5 Arial,sans-serif;max-width:960px;margin:36px auto;color:#17221d}h1,h2{color:#226b37}table{width:100%;border-collapse:collapse}th,td{padding:8px;border:1px solid #b9c9bd;text-align:left;vertical-align:top}.meta{color:#607067;font-size:12px}.warn{color:#9b2d34}.muted{color:#607067}</style><h1>${html(title)}</h1><p class="meta">Шаблон SBK-PROCUREMENT/1 · создано ${html(new Date().toLocaleString("ru-RU"))}</p><p><b>Закупка:</b> ${html(item.name)}<br><b>Заказчик:</b> ${html(item.customer)}<br><b>Предмет:</b> ${html(item.subject)}<br><b>НМЦ:</b> ${html(money(item.nmc))}</p>${body}</html>`;
}

export function summaryBody(item: ProcurementData) {
  const gaps = item.requirements.filter((row) => row.status !== "Подтверждено");
  const questions = item.requirements.filter((row) => row.status === "Требует уточнения" || row.question.trim());
  return `<h2>Сводка</h2><p><b>Площадка:</b> ${html(item.platform)}<br><b>Срок подачи:</b> ${html(item.submissionDeadline)}<br><b>Статус:</b> ${html(item.status)}</p><h2>Матрица соответствия</h2><table><tr><th>Требование</th><th>Источник</th><th>Подтверждение</th><th>Статус</th></tr>${item.requirements.map((row) => `<tr><td>${html(row.text)}</td><td>${html(row.evidenceKind)}</td><td>${html(row.evidence)}</td><td>${html(row.status)}</td></tr>`).join("")}</table><h2>Чек-лист подачи</h2><ul>${item.checklist.map((row) => `<li>${row.done ? "☑" : "☐"} ${html(row.text)} — ${html(row.responsible)}</li>`).join("")}</ul><h2>Пробелы и вопросы</h2><ul>${gaps.map((row) => `<li class="warn">${html(row.text)}: ${html(row.status)}</li>`).join("")}${questions.map((row) => `<li>${html(row.question || row.text)}</li>`).join("")}</ul>`;
}

export function anonymousCalculationBody(item: ProcurementData) {
  const rows = item.calculations.map((link, index) => {
    const calculation = link.snapshot as unknown as Partial<CalculatorData>;
    return `<tr><td>${index + 1}</td><td>${html(calculation.name || `Вариант ${index + 1}`)}</td><td>${html(money(Number(calculation.proposedPrice) || 0))}</td><td>${html(calculation.targetType === "markup" ? "Наценка" : "Маржа")}</td><td>${html(Number(calculation.targetValue) || 0)}%</td><td>${html(calculation.notes || "")}</td></tr>`;
  }).join("");
  return `<h2>Обезличенные варианты расчёта</h2><p class="muted">Наименования контрагентов, сотрудников и внутренние реквизиты не включены.</p><table><tr><th>№</th><th>Вариант</th><th>Предлагаемая цена</th><th>Целевой показатель</th><th>Значение</th><th>Комментарий</th></tr>${rows || '<tr><td colspan="6">Расчёты не выбраны.</td></tr>'}</table>`;
}

export function workAllocationBody(item: ProcurementData) {
  const total = item.partners.reduce((sum, partner) => sum + partner.workShare, 0);
  return `<h2>Распределение работ</h2><table><tr><th>Участник</th><th>Роль</th><th>Доля, %</th><th>Зона ответственности</th></tr>${item.partners.map((partner) => `<tr><td>${html(partner.name)}</td><td>${html(partner.role)}</td><td>${html(partner.workShare)}</td><td>${html(partner.responsibility)}</td></tr>`).join("") || '<tr><td colspan="4">Партнёры не добавлены.</td></tr>'}<tr><td colspan="2"><b>Итого</b></td><td><b>${html(total)}%</b></td><td>${total > 100 ? '<span class="warn">Доля превышает 100%</span>' : ""}</td></tr></table>`;
}

export function experienceReferenceBody(item: ProcurementData) {
  const rows = item.experience.map((link, index) => {
    const contract = link.snapshot as unknown as Partial<ContractData>;
    return `<tr><td>${index + 1}</td><td>${html(contract.number)}</td><td>${html(contract.date)}</td><td>${html(contract.customer)}</td><td>${html(contract.subject)}</td><td>${html(money(Number(contract.amount) || 0))}</td><td>${html(contract.stage)}</td></tr>`;
  }).join("");
  return `<h2>Справка об опыте</h2><p class="muted">Включены только договоры, явно выбранные пользователем в карточке закупки.</p><table><tr><th>№</th><th>Договор</th><th>Дата</th><th>Заказчик</th><th>Предмет</th><th>Сумма</th><th>Статус</th></tr>${rows || '<tr><td colspan="7">Договоры не выбраны.</td></tr>'}</table>`;
}

export function teamListBody(item: ProcurementData) {
  const rows = item.team.map((link, index) => {
    const person = link.snapshot as unknown as Partial<StaffData>;
    const documents = person.documents?.filter((document) => document.name || document.type).map((document) => `${document.type || document.name}${document.expiresDate ? ` до ${document.expiresDate}` : document.unlimited ? " бессрочно" : ""}`).join("; ") || "—";
    return `<tr><td>${index + 1}</td><td>${html(person.fullName)}</td><td>${html(person.role)}</td><td>${html(person.qualification)}</td><td>${html(person.experienceYears || 0)}</td><td>${html(person.basis)}</td><td>${html(documents)}</td></tr>`;
  }).join("");
  return `<h2>Состав команды</h2><p class="muted">Включены только сотрудники, явно выбранные пользователем.</p><table><tr><th>№</th><th>ФИО</th><th>Роль</th><th>Квалификация</th><th>Стаж, лет</th><th>Основание</th><th>Подтверждающие документы</th></tr>${rows || '<tr><td colspan="7">Сотрудники не выбраны.</td></tr>'}</table>`;
}
