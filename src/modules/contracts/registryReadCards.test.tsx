import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CompanyNameField } from "./CompanyDirectory";
import { CompanyReadCard, ContractReadCard } from "./RegistryReadCard";
import { StaffReadCard } from "../staff/StaffReadCard";
import { emptyCompany } from "./companies";
import { emptyContract, emptyContractDocument } from "./types";
import { emptyStaff, emptyStaffDocument } from "../staff/types";
import { normalizeRegistryColumns } from "./RegistryTableView";
import { WorkspaceAccessProvider } from "../../lib/workspaceAccess";

const record = <T,>(payload: T) => ({ id: "read-card", payload, title: "QA", createdAt: "2026-09-17", updatedAt: "2026-09-17", archived: false });
describe("read-only registry information remains accessible", () => {
  it("renders complete contract details and enabled attachment opening without edit/save controls", () => {
    const item = { ...emptyContract(), number: "СЕКРЕТ-1", subject: "Полный предмет", contactEmail: "test@example.com", documents: [{ ...emptyContractDocument(), name: "Договор", relativePath: "attachments/test.pdf", fileName: "test.pdf" }] };
    const html = renderToStaticMarkup(<WorkspaceAccessProvider editor={false} message="Просмотр"><ContractReadCard record={record(item)} onClose={vi.fn()} /></WorkspaceAccessProvider>);
    expect(html).toContain("Полный предмет"); expect(html).toContain("test@example.com"); expect(html).toContain("Запрещено раскрывать информацию");
    expect(html).toMatch(/<button[^>]*(?<!disabled)>Открыть test.pdf<\/button>/);
    expect(html).not.toContain("Сохранить договор"); expect(html).not.toContain("<input"); expect(html).toContain("История");
  });
  it("renders staff documents, contact and missing-file state, not procurement readiness", () => {
    const item = { ...emptyStaff(), fullName: "Тестовая карточка", email: "staff@example.com", documents: [{ ...emptyStaffDocument("education"), name: "Диплом", issuer: "Тестовый университет" }] };
    const html = renderToStaticMarkup(<StaffReadCard record={record(item)} onClose={vi.fn()} />);
    expect(html).toContain("staff@example.com"); expect(html).toContain("Тестовый университет"); expect(html).toContain("Файл не приложен");
    expect(html).toContain("Это не проверка соответствия конкретной закупке"); expect(html).not.toContain("Сохранить карточку");
  });
  it("allows opening a power of attorney in the read-only company card", () => {
    const company = { ...emptyCompany(), name: "Компания", authorizedSigners: [{ id: "signer", fullName: "Доверенное лицо", position: "Директор", powerOfAttorneyNumber: "D-1", issuedAt: "", expiresAt: "", notes: "", document: { relativePath: "attachments/poa.pdf", fileName: "poa.pdf" } }] };
    const html = renderToStaticMarkup(<CompanyReadCard company={company} companies={[company]} onClose={vi.fn()} />);
    expect(html).toContain("Доверенное лицо"); expect(html).toContain("Открыть poa.pdf"); expect(html).not.toContain("<fieldset"); expect(html).not.toContain("Сохранить компанию");
  });
  it("does not offer archived companies for new links but retains the current archived link", () => {
    const active = { ...emptyCompany("2026-09-17", "active"), name: "Активная компания" };
    const archived = { ...emptyCompany("2026-09-17", "archived"), name: "Архивная компания", archived: true };
    const field = (companyId: string) => renderToStaticMarkup(<CompanyNameField label="Заказчик" value={companyId ? archived.name : ""} companyId={companyId} companies={[active, archived]} role="counterparty" onChange={vi.fn()} />);
    expect(field("")).not.toContain("Архивная компания"); expect(field("archived")).toContain("Архивная компания (в архиве — текущая связь)");
  });
  it("validates local column preferences and always retains record identification", () => {
    const columns = [{ key: "name", label: "Название", compact: true }, { key: "notes", label: "Примечания", compact: false }, { key: "status", label: "Статус", compact: true }];
    expect(normalizeRegistryColumns(null, columns)).toEqual(["name", "status"]);
    expect(normalizeRegistryColumns(["notes", "unknown", "notes"], columns)).toEqual(["name", "notes"]);
    expect(normalizeRegistryColumns([], columns)).toEqual(["name"]);
  });
});
