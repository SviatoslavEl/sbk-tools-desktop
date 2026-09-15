import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CompanyEditor } from "./CompanyDirectory";
import { companyInnFormatError, companyInnFormatHint, emptyCompany, validateCompany, validateCompanyInn } from "./companies";

const company = (inn: string, id = "new-company") => ({ ...emptyCompany("2026-09-15", id), name: "Тестовая компания", inn });

describe("company INN format without changing legacy normalization", () => {
  it.each(["123", "123456789", "12345678901", "1234567890123", "123456789a", "12345 67890", "12345-67890", "１２３４５６７８９０"])("rejects new nonempty invalid input %s without stripping characters", (inn) => {
    const item = company(inn);
    expect(validateCompany(item, [])).toContain(companyInnFormatError);
    expect(validateCompanyInn(item, [])).toEqual({ error: companyInnFormatError, warning: "" });
    expect(item.inn).toBe(inn);
  });

  it.each(["1234567890", "123456789012", " 1234567890 ", "", "   "])("accepts optional or correctly formatted input %s", (inn) => {
    const item = company(inn);
    expect(validateCompany(item, [])).toEqual([]);
    expect(validateCompanyInn(item, [])).toEqual({ error: "", warning: "" });
    expect(item.inn).toBe(inn);
  });

  it("allows changes to other fields while warning about an unchanged historical invalid INN", () => {
    const previous = company("123", "legacy");
    const updated = { ...previous, notes: "Новое примечание" };
    expect(validateCompany(updated, [previous])).toEqual([]);
    expect(validateCompanyInn(updated, [previous])).toMatchObject({ error: "", warning: expect.stringContaining("Ранее сохранённый ИНН") });
    expect(updated.inn).toBe("123");
    expect(previous).toEqual(company("123", "legacy"));
  });

  it("rejects changing the historical INN to another invalid value", () => {
    const previous = company("123", "legacy");
    expect(validateCompany({ ...previous, inn: "456" }, [previous])).toContain(companyInnFormatError);
    expect(validateCompany({ ...previous, inn: "123456789x" }, [previous])).toContain(companyInnFormatError);
  });

  it("allows clearing or correcting a historical INN and does not exempt a new id", () => {
    const previous = company("123", "legacy");
    expect(validateCompany({ ...previous, inn: "" }, [previous])).toEqual([]);
    expect(validateCompany({ ...previous, inn: "123456789012" }, [previous])).toEqual([]);
    expect(validateCompanyInn(company("123", "different-id"), [previous]).error).toBe(companyInnFormatError);
  });
});

describe("company editor INN feedback", () => {
  it("renders an optional hint and a visible format error for a new invalid value", () => {
    const html = renderToStaticMarkup(<CompanyEditor company={company("123")} companies={[]} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(html).toContain(companyInnFormatHint);
    expect(html).toContain(companyInnFormatError);
    expect(html).toMatch(/aria-label="ИНН" aria-invalid="true" aria-describedby="[^"]+"/);
    expect(html).toContain('value="123"');
    expect(html).not.toContain("Ранее сохранённый ИНН");
  });

  it("opens a legacy card with a warning, preserves the value, and does not disable saving other fields", () => {
    const previous = company("123", "legacy");
    const html = renderToStaticMarkup(<CompanyEditor company={previous} companies={[previous]} onClose={vi.fn()} onSave={vi.fn()} />);
    expect(html).toContain("Ранее сохранённый ИНН имеет неверный формат");
    expect(html).toContain("Другие поля можно сохранить");
    expect(html).toMatch(/aria-label="ИНН" aria-invalid="false"/);
    expect(html).toContain('value="123"');
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>\s*Сохранить компанию/);
    expect(previous.inn).toBe("123");
  });
});
