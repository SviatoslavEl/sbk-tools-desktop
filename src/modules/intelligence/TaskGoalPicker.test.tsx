import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TaskGoalPicker } from "./TaskGoalPicker";
import { TASK_GOAL_OPTIONS } from "./taskGoalSelection";

const render = (selected: Parameters<typeof TaskGoalPicker>[0]["selected"], disabled = false) => renderToStaticMarkup(<TaskGoalPicker selected={selected} onChange={() => undefined} disabled={disabled} />);
const buttons = (html: string) => html.match(/<button\b[^>]*>/g) || [];

describe("task goal picker presentation", () => {
  it("shows all five named choices for a new task with no second preset or checkbox model", () => {
    const html = render([]);
    expect(html).toContain("Что подготовить по документам");
    expect(html).toContain("Выбрано результатов: 0");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Добавить ещё результат");
    expect(html).toContain("Все разделы");
    for (const goal of TASK_GOAL_OPTIONS) {
      expect(html).toContain(`aria-label="Добавить результат: ${goal.label}"`);
      expect(html).toContain(goal.description);
    }
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<select");
    expect(html).not.toContain('aria-label="Выбранные результаты"');
    expect(buttons(html)).toHaveLength(7);
  });

  it("renders the controlled selected order and offers only missing goals for addition", () => {
    const html = render(["proposals", "contracts"]);
    const selected = html.slice(html.indexOf("<ol"), html.indexOf("</ol>"));
    expect(selected.indexOf("Коммерческое предложение")).toBeLessThan(selected.indexOf("Опыт по договорам"));
    expect(html).toContain("Выбрано результатов: 2");
    expect(html).toContain('aria-label="Убрать результат: Коммерческое предложение"');
    expect(html).toContain('aria-label="Убрать результат: Опыт по договорам"');
    expect(html).toContain("Заполнить реестр по существующим договорам");
    expect(html).not.toContain('aria-label="Добавить результат: Коммерческое предложение"');
    expect(html).not.toContain('aria-label="Добавить результат: Опыт по договорам"');
    expect(html).toContain('aria-label="Добавить результат: Карточки сотрудников"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/role="group" aria-label="Доступные результаты" hidden=""/);
  });

  it("derives the all-sections state from that same array, without another active toggle", () => {
    const html = render(TASK_GOAL_OPTIONS.map((goal) => goal.destination));
    expect(html).toContain("Выбрано результатов: 5");
    expect(html.match(/aria-label="Убрать результат:/g)).toHaveLength(5);
    expect(html).not.toContain('aria-label="Добавить результат:');
    expect(buttons(html).filter((button) => button.includes('disabled=""'))).toHaveLength(2);
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("checked=");
  });

  it.each([{ goals: [] }, { goals: ["proposals", "contracts"] }] as const)("disables every action accessibly without clearing selection: $goals", ({ goals }) => {
    const html = render(goals, true);
    expect(html).toMatch(/^<fieldset[^>]* disabled=""/);
    for (const button of buttons(html)) expect(button).toContain('disabled=""');
    expect(html).toContain(`Выбрано результатов: ${goals.length}`);
    expect(html).toContain('<legend>Что подготовить по документам</legend>');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
  });

  it("does not invent a default, notify on render, or mutate the supplied selection", () => {
    const selected = Object.freeze(["staff", "proposals", "staff"] as const);
    const onChange = vi.fn();
    const html = renderToStaticMarkup(<TaskGoalPicker selected={selected} onChange={onChange} />);
    expect(html).toContain("Выбрано результатов: 2");
    expect(html.match(/aria-label="Убрать результат:/g)).toHaveLength(2);
    expect(onChange).not.toHaveBeenCalled();
    expect(selected).toEqual(["staff", "proposals", "staff"]);
  });

  it("gives every add choice a unique description and connects the disclosure to its panel", () => {
    const html = render([]);
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
    const describedBy = [...html.matchAll(/<button[^>]*aria-describedby="([^"]+)"/g)].map((match) => match[1]);
    expect(describedBy).toHaveLength(5);
    expect(new Set(describedBy).size).toBe(5);
    for (const id of describedBy) expect(html).toContain(`id="${id}"`);
    expect(buttons(html).every((button) => button.includes('type="button"'))).toBe(true);
  });
});
