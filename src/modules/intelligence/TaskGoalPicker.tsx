import { useEffect, useId, useRef, useState } from "react";
import type { IntelligenceDestination } from "./workbenchTypes";
import { addTaskGoal, availableTaskGoals, normalizeTaskGoalSelection, removeTaskGoal, selectAllTaskGoals, TASK_GOAL_OPTIONS } from "./taskGoalSelection";
import "./task-goal-picker.css";

export interface TaskGoalPickerProps {
  selected: readonly IntelligenceDestination[];
  onChange: (next: IntelligenceDestination[]) => void;
  disabled?: boolean;
}

export function TaskGoalPicker({ selected, onChange, disabled = false }: TaskGoalPickerProps) {
  const id = useId();
  const goals = normalizeTaskGoalSelection(selected);
  const available = availableTaskGoals(goals);
  const [choosing, setChoosing] = useState(goals.length === 0);
  const addButton = useRef<HTMLButtonElement>(null);
  const selectionSummary = useRef<HTMLParagraphElement>(null);
  const restoreFocus = useRef(false);
  const selectionKey = goals.join("|");

  useEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    if (available.length && !disabled) addButton.current?.focus();
    else selectionSummary.current?.focus();
  }, [selectionKey, choosing, available.length, disabled]);

  function choose(next: IntelligenceDestination[]) {
    if (disabled) return;
    restoreFocus.current = true;
    setChoosing(false);
    onChange(next);
  }

  return <fieldset className="iw-task-goal-picker" disabled={disabled} aria-describedby={`${id}-help`}>
    <legend>Что подготовить по документам</legend>
    <p id={`${id}-help`} className="iw-task-goal-help">Выберите один или несколько результатов.</p>
    <p className="iw-task-goal-count" ref={selectionSummary} tabIndex={-1} role="status" aria-live="polite" aria-atomic="true">Выбрано результатов: {goals.length}</p>

    {goals.length > 0 && <ol className="iw-task-goal-selected" aria-label="Выбранные результаты">{goals.map((destination) => {
      const goal = TASK_GOAL_OPTIONS.find((option) => option.destination === destination)!;
      return <li key={destination}>
        <div><strong>{goal.label}</strong><p>{goal.description}</p></div>
        <button type="button" className="secondary" disabled={disabled} aria-label={`Убрать результат: ${goal.label}`} onClick={() => choose(removeTaskGoal(goals, destination))}>Убрать</button>
      </li>;
    })}</ol>}

    <div className="iw-task-goal-actions">
      <button type="button" className="secondary" ref={addButton} disabled={disabled || available.length === 0} aria-expanded={choosing && available.length > 0} aria-controls={`${id}-choices`} onClick={() => { if (!disabled) setChoosing((previous) => !previous); }}>Добавить ещё результат</button>
      <button type="button" className="secondary" disabled={disabled || available.length === 0} onClick={() => choose(selectAllTaskGoals(goals))}>Все разделы</button>
    </div>

    <div id={`${id}-choices`} className="iw-task-goal-choices" role="group" aria-label="Доступные результаты" hidden={!choosing || available.length === 0}>
      {available.map((goal) => <button key={goal.destination} type="button" className="secondary" disabled={disabled} aria-label={`Добавить результат: ${goal.label}`} aria-describedby={`${id}-${goal.destination}-description`} onClick={() => choose(addTaskGoal(goals, goal.destination))}>
        <strong>{goal.label}</strong><span id={`${id}-${goal.destination}-description`}>{goal.description}</span>
      </button>)}
    </div>
  </fieldset>;
}
