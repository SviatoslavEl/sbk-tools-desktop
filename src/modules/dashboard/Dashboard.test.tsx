import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./Dashboard";

const state = vi.hoisted(() => ({ loading: false, error: null as string | null }));
vi.mock("../../hooks/useRecords", () => ({ useRecords: () => ({ ...state, records: [] }) }));

describe("dashboard overview", () => {
  beforeEach(() => { state.loading = false; state.error = null; });
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
});
