import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";
import { emptyProcurement } from "../procurement/types";

const state = vi.hoisted(() => ({ loading: false, error: null as string | null, records: {} as Record<string, unknown[]> }));
vi.mock("../../hooks/useRecords", () => ({ useRecords: (module: string) => ({ ...state, records: state.records[module] || [] }) }));

describe("dashboard overview", () => {
  beforeEach(() => { state.loading = false; state.error = null; state.records = {}; });
  it("offers real navigation actions with accessible text", () => {
    const html = renderToStaticMarkup(<Dashboard onNavigate={vi.fn()} />);
    expect(html).toContain("Подготовить документ");
    expect(html).toContain("Подобрать опыт");
    expect(html).toContain("Подобрать команду");
    expect(html).toContain('aria-label="Открыть: Договоры"');
    expect(html).toContain("Нет событий");
  });
  it("does not report empty registries as verified while loading", () => {
    state.loading = true;
    const html = renderToStaticMarkup(<Dashboard />);
    expect(html).toContain("Обновляем данные…");
    expect(html).not.toContain("Нет событий");
  });
  it("shows read errors instead of reassuring zero-event messages", () => {
    state.error = "Тестовый отказ чтения";
    const html = renderToStaticMarkup(<Dashboard />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Проверьте доступ к данным");
    expect(html).not.toContain("Нет событий");
  });
  it("places actionable overdue procurement before stats without empty alert cards", () => {
    state.records.procurement = [{ id: "target-procurement", title: "Просроченная закупка", archived: false, createdAt: "2020-01-01", updatedAt: "2020-01-01", payload: { ...emptyProcurement(), name: "Просроченная закупка", submissionDeadline: "2020-01-01", responsible: "Петров" } }];
    const html = renderToStaticMarkup(<Dashboard onNavigate={vi.fn()} />);
    expect(html).toContain('aria-label="Проверить подачу заявки — Просроченная закупка"');
    expect(html).toContain("Ответственный: Петров");
    expect(html.indexOf('aria-label="Рабочая очередь"')).toBeLessThan(html.indexOf('aria-label="Реестры рабочей папки"'));
    expect(html).not.toContain('class="surface dashboard-card');
    expect(html).toContain("Без событий:");
  });
});
