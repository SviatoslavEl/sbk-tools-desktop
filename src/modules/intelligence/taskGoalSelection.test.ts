import { describe, expect, it } from "vitest";
import { addTaskGoal, availableTaskGoals, normalizeTaskGoalSelection, removeTaskGoal, selectAllTaskGoals, TASK_GOAL_OPTIONS } from "./taskGoalSelection";
import type { IntelligenceDestination } from "./workbenchTypes";

const destinations = TASK_GOAL_OPTIONS.map((goal) => goal.destination);
const subsets = Array.from({ length: (1 << destinations.length) - 1 }, (_, index) => destinations.filter((_, bit) => (index + 1) & (1 << bit)));

describe("one canonical task goal selection", () => {
  it("defines exactly the five real destinations, including the meaning of contract experience", () => {
    expect(destinations).toEqual(["procurement", "contracts", "staff", "counterparties", "proposals"]);
    expect(TASK_GOAL_OPTIONS.find((goal) => goal.destination === "contracts")?.description).toBe("Заполнить реестр по существующим договорам");
    expect(new Set(destinations).size).toBe(5);
    expect(TASK_GOAL_OPTIONS.every((goal) => goal.label.length > 0 && goal.description.length > 0)).toBe(true);
  });

  it.each(subsets.map((goals, index) => ({ name: `subset ${index + 1}: ${goals.join(", ")}`, goals })))("can reach and edit $name without a second preset state", ({ goals }) => {
    expect(subsets).toHaveLength(31);
    expect(normalizeTaskGoalSelection(goals)).toEqual(goals);
    expect(goals.reduce<IntelligenceDestination[]>((selected, goal) => addTaskGoal(selected, goal), [])).toEqual(goals);
    expect(destinations.reduce<IntelligenceDestination[]>((selected, goal) => goals.includes(goal) ? selected : removeTaskGoal(selected, goal), [...destinations])).toEqual(goals);
    expect(availableTaskGoals(goals).map((goal) => goal.destination)).toEqual(destinations.filter((goal) => !goals.includes(goal)));
    expect(availableTaskGoals(goals)).toHaveLength(5 - goals.length);

    for (const goal of goals) {
      expect(addTaskGoal(goals, goal)).toEqual(goals);
      expect(removeTaskGoal(goals, goal)).toEqual(goals.filter((entry) => entry !== goal));
    }

    const reversed = [...goals].reverse();
    const all = selectAllTaskGoals(reversed);
    expect(all).toEqual([...reversed, ...destinations.filter((goal) => !reversed.includes(goal))]);
    expect(new Set(all)).toEqual(new Set(destinations));
    expect(selectAllTaskGoals(all)).toEqual(all);
  });

  it("uses an actual empty selection, not a placeholder destination", () => {
    expect(normalizeTaskGoalSelection([])).toEqual([]);
    expect(availableTaskGoals([]).map((goal) => goal.destination)).toEqual(destinations);
    expect(removeTaskGoal(["proposals"], "proposals")).toEqual([]);
    expect(selectAllTaskGoals([])).toEqual(destinations);
  });

  it("preserves the user's order and never changes the input", () => {
    const selected = Object.freeze<IntelligenceDestination[]>(["proposals", "contracts", "proposals"]);
    expect(normalizeTaskGoalSelection(selected)).toEqual(["proposals", "contracts"]);
    expect(addTaskGoal(selected, "staff")).toEqual(["proposals", "contracts", "staff"]);
    expect(removeTaskGoal(selected, "staff")).toEqual(["proposals", "contracts"]);
    expect(selectAllTaskGoals(selected)).toEqual(["proposals", "contracts", "procurement", "staff", "counterparties"]);
    expect(availableTaskGoals(selected).map((goal) => goal.destination)).toEqual(["procurement", "staff", "counterparties"]);
    expect(selected).toEqual(["proposals", "contracts", "proposals"]);
  });

  it("does not turn unknown recovered values into phantom result types", () => {
    const recovered = ["proposals", "all", "", "contracts"] as IntelligenceDestination[];
    expect(normalizeTaskGoalSelection(recovered)).toEqual(["proposals", "contracts"]);
    expect(addTaskGoal(recovered, "placeholder" as IntelligenceDestination)).toEqual(["proposals", "contracts"]);
  });
});
