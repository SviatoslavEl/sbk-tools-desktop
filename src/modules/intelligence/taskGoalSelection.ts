import type { IntelligenceDestination } from "./workbenchTypes";

export interface TaskGoalOption {
  destination: IntelligenceDestination;
  label: string;
  description: string;
}

/** One list serves both individual goals and the “all sections” shortcut. */
export const TASK_GOAL_OPTIONS = [
  { destination: "procurement", label: "Карточка закупки", description: "Подготовить сведения, требования и сроки закупки." },
  { destination: "contracts", label: "Опыт по договорам", description: "Заполнить реестр по существующим договорам" },
  { destination: "staff", label: "Карточки сотрудников", description: "Подготовить сведения о сотрудниках, квалификации и документах." },
  { destination: "counterparties", label: "Компании и контрагенты", description: "Подготовить карточки компаний и сведения об их представителях." },
  { destination: "proposals", label: "Коммерческое предложение", description: "Подготовить проект КП по выбранным материалам." },
] as const satisfies readonly TaskGoalOption[];

const knownDestinations = new Set<IntelligenceDestination>(TASK_GOAL_OPTIONS.map((goal) => goal.destination));

/** Preserve the user's order, without duplicates or unknown recovered values. */
export function normalizeTaskGoalSelection(selected: readonly IntelligenceDestination[]): IntelligenceDestination[] {
  return [...new Set(selected.filter((destination) => knownDestinations.has(destination)))];
}

export function availableTaskGoals(selected: readonly IntelligenceDestination[]): readonly TaskGoalOption[] {
  const chosen = new Set(normalizeTaskGoalSelection(selected));
  return TASK_GOAL_OPTIONS.filter((goal) => !chosen.has(goal.destination));
}

export function addTaskGoal(selected: readonly IntelligenceDestination[], destination: IntelligenceDestination): IntelligenceDestination[] {
  return normalizeTaskGoalSelection([...selected, destination]);
}

export function removeTaskGoal(selected: readonly IntelligenceDestination[], destination: IntelligenceDestination): IntelligenceDestination[] {
  return normalizeTaskGoalSelection(selected).filter((entry) => entry !== destination);
}

export function selectAllTaskGoals(selected: readonly IntelligenceDestination[]): IntelligenceDestination[] {
  return normalizeTaskGoalSelection([...selected, ...TASK_GOAL_OPTIONS.map((goal) => goal.destination)]);
}
