// @ts-expect-error Node's built-in module is available in the test runner.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RegistryCellText, RegistryScrollHint } from "./RegistryOverviewCells";
import { ContractsRegistry } from "./Contracts";
import { StaffRegistry } from "../staff/Staff";
import { ProcurementRegistry } from "../procurement/Procurement";
import { emptyContract } from "./types";
import { emptyStaff } from "../staff/types";
import { emptyProcurement } from "../procurement/types";

const state = vi.hoisted(() => ({ records: {} as Record<string, unknown[]>, detailed: false }));
vi.mock("../../hooks/useRecords", () => ({ useRecords: (module: string) => ({ records: state.records[module] || [], loading: false, error: null, reload: vi.fn() }) }));
vi.mock("../../hooks/useViewState", () => ({ useViewState: (key: string, initial: unknown) => [key === "procurement:table-details" ? state.detailed : initial, vi.fn()] }));
vi.mock("../../lib/workspaceAccess", () => ({ useWorkspaceAccess: () => ({ editor: true, message: "QA" }) }));
vi.mock("./CompanyDirectory", async (original) => ({ ...await original<typeof import("./CompanyDirectory")>(), useCompanyDirectory: () => ({ companies: [], editor: true, loading: false, accessMessage: "QA" }) }));

const record = <T,>(id: string, payload: T) => ({ id, title: id, payload, archived: false, createdAt: "2026-10-16", updatedAt: "2026-10-16" });
beforeEach(() => { state.records = {}; state.detailed = false; });

describe("compact registry overview without losing access to details", () => {
  it("offers native keyboard-accessible disclosure for long text and keeps exact original content", () => {
    const value = `Синтетическое длинное название компании ${"уточнение ".repeat(15)}\nВторая строка без сокращений`;
    const html = renderToStaticMarkup(<RegistryCellText text={value} />);
    expect(html).toContain('<details class="registry-cell-disclosure"');
    expect(html).toContain('aria-label="Показать полный текст:');
    expect(html).toContain(value);
    expect(renderToStaticMarkup(<RegistryCellText text="Короткий текст" />)).not.toContain("<details");
    expect(renderToStaticMarkup(<RegistryScrollHint id="qa-hint" />)).toContain("прокрутка по горизонтали");
  });

  it("keeps contract selection and open/archive actions while offering four overview columns", () => {
    const data = { ...emptyContract(), number: "QA-16", customer: "Тестовая компания", amount: 1500000 };
    state.records["contract-experience"] = [record("contract", data)];
    const html = renderToStaticMarkup(<ContractsRegistry />);
    expect(html).toContain('aria-label="Выбрать договор QA-16"');
    expect(html).toContain('aria-label="Редактировать договор QA-16"');
    expect(html).toContain('aria-label="Архивировать QA-16"');
    expect(html).toContain("Столбцы (4)");
    expect(html).toContain('aria-describedby="contracts-scroll-hint" tabindex="0"');
    expect(html).toContain('class="registry-money">1 500 000 ₽');
    expect(html).toContain('class="registry-row-actions"');
    expect(html).not.toContain('Сортировать по столбцу «Юрлицо-исполнитель»');
    expect(html).not.toContain('Сортировать по столбцу «Оплата»');
    expect(html).not.toContain("<style>");
  });

  it("keeps staff selection/history/actions and four default overview columns", () => {
    const data = { ...emptyStaff(), fullName: "Тестовый сотрудник" };
    state.records.staff = [record("staff", data)];
    const html = renderToStaticMarkup(<StaffRegistry />);
    expect(html).toContain('aria-label="Выбрать сотрудника Тестовый сотрудник"');
    expect(html).toContain('aria-label="Редактировать сотрудника Тестовый сотрудник"');
    expect(html).toContain('aria-label="Архивировать Тестовый сотрудник"');
    expect(html).toContain("История");
    expect(html).toContain("Столбцы (4)");
    expect(html).toContain('aria-describedby="staff-scroll-hint" tabindex="0"');
  });

  it("shows procurement core columns first and retains every extra column in detailed view", () => {
    const data = { ...emptyProcurement(), name: "Закупка QA", customer: "Компания QA", subject: "Предмет QA", platform: "Площадка QA", nmc: 100000 };
    state.records.procurement = [record("procurement", data)];
    const compact = renderToStaticMarkup(<ProcurementRegistry onCreateProposal={vi.fn()} />);
    expect(compact).toContain('aria-label="Открыть закупку Закупка QA"');
    expect(compact).toContain('aria-label="Создать КП из закупки Закупка QA"');
    expect(compact).toContain('class="registry-money">100 000 ₽');
    expect(compact).not.toContain("<th>Площадка</th>");
    state.detailed = true;
    const detailed = renderToStaticMarkup(<ProcurementRegistry />);
    for (const heading of ["Предмет", "Площадка", "Матрица"]) expect(detailed).toContain(`<th>${heading}</th>`);
    for (const value of ["Предмет QA", "Площадка QA"]) expect(detailed).toContain(value);
  });

  it("scopes scrolling, pinned actions and non-breaking money to registry overview tables", () => {
    const css = readFileSync(new URL("./registry-overview.css", import.meta.url), "utf8");
    expect(css).toContain(".registry-overview-scroll { overflow: auto;");
    expect(css).toContain("scroll-padding: 44px 108px 10px 192px;");
    expect(css).toContain(".registry-row-actions { position: sticky; right: 0;");
    expect(css).toContain(".registry-money { white-space: nowrap;");
    expect(css).not.toMatch(/^table\s*\{/mu);
    expect(css).toContain("min-width: min-content; overflow-wrap: normal; word-break: normal;");
    expect(css).toContain(".status { min-width: min-content;");
  });
});
