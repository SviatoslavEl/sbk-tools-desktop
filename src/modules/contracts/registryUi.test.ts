// Vitest runs in Node; the application tsconfig intentionally omits Node types.
// @ts-expect-error Node's built-in module is available in the test runner.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "postcss";
import { contractContactSummary } from "./types";

describe("интерфейс реестров", () => {
  it("сохраняет структурированный контакт и совместимость со старым полем", () => {
    expect(contractContactSummary({
      contactName: "Анна Иванова",
      contactPosition: "Директор",
      contactPhone: "+7 900 000-00-00",
      contactEmail: "anna@example.test",
      contact: "старое значение",
    })).toBe("Анна Иванова · Директор · +7 900 000-00-00 · anna@example.test");
    expect(contractContactSummary({ contact: "Старый свободный контакт" }))
      .toBe("Старый свободный контакт");
  });

  it("не теряет справочные поля конфиденциального договора", () => {
    const component = readFileSync(new URL("./Contracts.tsx", import.meta.url), "utf8");
    expect(component).toContain("Какие реквизиты разрешено раскрывать");
    expect(component).toContain('update("discloseCustomer"');
    expect(component).toContain('update("discloseNumber"');
    expect(component).toContain('update("discloseSubject"');
    expect(component).toContain('update("discloseAmount"');
    expect(component).toContain("Контактное лицо");
    expect(component).toContain("<label>Должность");
    expect(component).toContain('type="tel"');
    expect(component).toContain('type="email"');
  });

  it("архивирует только явно выбранные договоры и просит подтверждение", () => {
    const component = readFileSync(new URL("./Contracts.tsx", import.meta.url), "utf8");
    expect(component).toContain("selectedRegistryContracts.size > 1");
    expect(component).toContain("Перенести выбранные договоры в архив?");
    expect(component).toContain("setBulkArchiveIds([...selectedRegistryContracts])");
  });

  it("выгружает только договоры, отмеченные в основной таблице", () => {
    const component = readFileSync(new URL("./Contracts.tsx", import.meta.url), "utf8");
    expect(component).toContain("selectedExportRecords");
    expect(component).toContain("exportArchive([...selectedRegistryContracts])");
    expect(component).toContain("exportSelection([...selectedRegistryContracts])");
    expect(component).toContain("exportXlsx([...selectedRegistryContracts])");
    expect(component).toContain("В экспорт попадут только отмеченные договоры");
  });

  it("разделяет контрагентов, окрашивает основания и даёт групповой выбор в архиве", () => {
    const counterparties = readFileSync(new URL("./Counterparties.tsx", import.meta.url), "utf8");
    const staff = readFileSync(new URL("../staff/Staff.tsx", import.meta.url), "utf8");
    const archive = readFileSync(new URL("../archive/Archive.tsx", import.meta.url), "utf8");
    expect(counterparties).toContain("Внешние");
    expect(counterparties).toContain("Внутренние");
    expect(counterparties).toContain('setScope("all")');
    expect(staff).toContain("staffBasisTone(assignment.engagementType)");
    expect(archive).toContain("Восстановить выбранные");
    expect(archive).toContain("Удалить выбранные");
    expect(archive).toContain("archive-row-checkbox");
  });

  it("удерживает основное окно в экране и прокручивает содержимое внутри", () => {
    const styles = readFileSync(new URL("../../App.css", import.meta.url), "utf8");
    const css = parse(styles);
    const declarations = (selector: string) => {
      const values: Record<string, string> = {};
      css.walkRules(selector, (rule) => {
        if (rule.parent?.type === "root") rule.walkDecls((declaration) => { values[declaration.prop] = declaration.value; });
      });
      return values;
    };
    expect(declarations("html, body, #root")).toMatchObject({ "min-width": "0", height: "100%", overflow: "hidden" });
    expect(declarations(".app-shell")).toMatchObject({ "max-width": "100vw", height: "100vh", overflow: "hidden" });
    expect(declarations(".tool-nav")).toMatchObject({ "min-height": "0", "overflow-y": "auto" });
    expect(declarations(".tool-content")).toMatchObject({ "min-width": "0", "min-height": "0", overflow: "auto" });
    expect(declarations(".brand")).toMatchObject({ display: "flex", "align-items": "center" });
    expect(declarations(".collapse-button")).toMatchObject({ position: "static", flex: "0 0 28px" });
    expect(declarations(".collapse-button")).not.toHaveProperty("right");
    expect(declarations(".registry-module > .table-surface > .table-scroll")).toMatchObject({ flex: "1 1 auto", "min-height": "0" });
    expect(declarations(".detail-drawer .form-grid > label > small")).toMatchObject({ display: "block", "margin-top": "4px" });
    const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
    const brand = app.slice(app.indexOf('<div className="brand">'), app.indexOf('<p className="nav-caption">'));
    expect(brand).toContain('className="collapse-button"');
  });

  it("показывает доверенных подписантов внутренних компаний", () => {
    const directory = readFileSync(new URL("./CompanyDirectory.tsx", import.meta.url), "utf8");
    const counterparties = readFileSync(new URL("./Counterparties.tsx", import.meta.url), "utf8");
    expect(directory).toContain("Подписанты по доверенности");
    expect(directory).toContain("Загрузить доверенность");
    expect(directory).toContain("authorizedSigners");
    expect(counterparties).toContain("Право подписи");
    expect(counterparties).toContain("powerOfAttorneyNumber");
  });

  it("закрывает карточки кликом по свободной области слева", () => {
    const backdrop = readFileSync(new URL("../../components/ModalOverlay.tsx", import.meta.url), "utf8");
    const contracts = readFileSync(new URL("./Contracts.tsx", import.meta.url), "utf8");
    const staff = readFileSync(new URL("../staff/Staff.tsx", import.meta.url), "utf8");
    expect(backdrop).toContain("event.currentTarget === event.target");
    expect(contracts).toContain("<DrawerBackdrop onClose={requestClose}>");
    expect(staff).toContain("<DrawerBackdrop onClose={requestClose}>");
  });
});
