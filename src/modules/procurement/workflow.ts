export type Stage2Section = "overview" | "documents" | "requirements" | "decision" | "questions" | "risks" | "finance" | "resources" | "application" | "result";
export type ProcurementSection = "main" | "compliance" | "links" | "partners" | "checklist" | "rebid" | "exports" | "calculations" | `s2:${Stage2Section}`;

// A UI-only mapping: changing stages never changes a procurement or its snapshots.
export const procurementWorkflow = [
  { id: "requirements", label: "Требования", sections: [["main", "Карточка и сроки"], ["compliance", "Матрица соответствия"], ["s2:requirements", "Подтверждения и история требований"], ["s2:questions", "Вопросы заказчику"]] },
  { id: "decision", label: "Решение об участии", sections: [["s2:decision", "Оценка и решение"], ["s2:risks", "Риски договора"]] },
  { id: "price", label: "Цена", sections: [["calculations", "Снимки расчётов"], ["s2:finance", "Сценарии цены и платежи"], ["rebid", "Переторжка"]] },
  { id: "team", label: "Опыт и команда", sections: [["links", "Снимки опыта и команды"], ["partners", "Партнёры и консорциум"], ["s2:resources", "План работ и загрузка"]] },
  { id: "documents", label: "Документы", sections: [["s2:documents", "Файлы заказчика и их версии"], ["exports", "Подготовка и выгрузка документов заявки"]] },
  { id: "submission", label: "Проверка и подача", sections: [["s2:overview", "Сводка и незакрытые действия"], ["checklist", "Чек-лист подачи"], ["s2:application", "Проверка комплекта"]] },
  { id: "result", label: "Результат", sections: [["s2:result", "Итоги и уроки"]] },
] as const satisfies ReadonlyArray<{ id: string; label: string; sections: ReadonlyArray<readonly [ProcurementSection, string]> }>;

export function workflowStage(section: ProcurementSection) {
  return procurementWorkflow.find((stage) => stage.sections.some(([value]) => value === section))!;
}

export function stage2Section(section: ProcurementSection): Stage2Section | null {
  return section.startsWith("s2:") ? section.slice(3) as Stage2Section : null;
}
