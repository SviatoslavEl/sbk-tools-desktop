import type { actsStatuses, contractStages, paymentStatuses } from "../modules/contracts/types";
import type { cooperationBases } from "../modules/staff/types";

export type StatusTone = "success" | "info" | "warning" | "danger" | "neutral" | "violet";

export function contractStageTone(value: typeof contractStages[number]): StatusTone {
  if (["Выполнен", "Закрыт"].includes(value)) return "success";
  if (["Расторгнут"].includes(value)) return "danger";
  if (["Приостановлен"].includes(value)) return "warning";
  if (["Заключён", "Исполняется"].includes(value)) return "info";
  return "neutral";
}

export function paymentStatusTone(value: typeof paymentStatuses[number]): StatusTone {
  if (value === "Полностью оплачено") return "success";
  if (value === "Просрочено") return "danger";
  if (["Ожидается", "Частично оплачено"].includes(value)) return "warning";
  if (value === "Не выставлено") return "violet";
  return "neutral";
}

export function actsStatusTone(value: typeof actsStatuses[number]): StatusTone {
  if (value === "Подписаны полностью") return "success";
  if (["Есть замечания", "Не подготовлены"].includes(value)) return "danger";
  if (value === "Подписаны частично") return "warning";
  if (["Подготовлены", "Направлены"].includes(value)) return "info";
  return "neutral";
}

export function staffBasisTone(value: typeof cooperationBases[number]): StatusTone {
  if (["Трудовой договор", "Штат"].includes(value)) return "success";
  if (value === "Внутреннее совместительство") return "info";
  if (["Внешнее совместительство", "ГПХ"].includes(value)) return "warning";
  if (["ИП", "Самозанятый"].includes(value)) return "violet";
  if (["Подрядная организация", "Привлечённый специалист"].includes(value)) return "neutral";
  return "danger";
}
