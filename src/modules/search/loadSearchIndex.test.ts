import { beforeEach, describe, expect, it, vi } from "vitest";
import { listRecords, readDraft, type StoredRecord } from "../../lib/storage";
import { emptyCompany, emptyCompanyDirectory } from "../contracts/companies";
import { loadSearchIndex, searchEntries } from "./index";
vi.mock("../../lib/storage", () => ({ listRecords: vi.fn(), readDraft: vi.fn() }));
const record = (id: string, payload: unknown, archived = false): StoredRecord => ({ id, title: id, payload, archived, updatedAt: "2026-09-18", createdAt: "2026-09-01" });
beforeEach(() => { vi.mocked(listRecords).mockReset().mockResolvedValue([]); vi.mocked(readDraft).mockReset().mockResolvedValue(null); });

describe("loading the global search index", () => {
  it("keeps healthy sections searchable and labels a failed module instead of calling it empty", async () => {
    vi.mocked(listRecords).mockImplementation(async (module) => {
      if (module === "staff") throw new Error("Share disconnected for staff");
      if (module === "calculator") return [record("Расчёт метро", { note: "Электромонтаж" })];
      return [];
    });
    const index = await loadSearchIndex();
    expect(searchEntries(index.entries, "Электромонтаж")).toHaveLength(1);
    expect(index.errors).toEqual(["Кадры: Error: Share disconnected for staff"]);
    expect(listRecords).toHaveBeenCalledTimes(5);
    expect(vi.mocked(listRecords).mock.calls.every(([module, archived]) => module !== "settings" && archived === true)).toBe(true);
    expect(readDraft).toHaveBeenCalledWith("contract-experience", "company-directory-v1");
  });

  it("indexes company contact data and archive flags but omits proposal templates", async () => {
    vi.mocked(readDraft).mockResolvedValue({ ...emptyCompanyDirectory(), companies: [{ ...emptyCompany("2026-09-18", "company"), name: "ООО Тест", archived: true, contact: "Иванова 123-45" }] });
    vi.mocked(listRecords).mockImplementation(async (module) => module === "commercial-proposals"
      ? [record("КП 25", { kind: "proposal", title: "Работы" }), record("Базовый шаблон", { kind: "template", title: "Работы" })] : []);
    const index = await loadSearchIndex();
    expect(index.errors).toEqual([]);
    expect(index.entries.filter((entry) => entry.tool === "proposals").map((entry) => entry.id)).toEqual(["КП 25"]);
    expect(searchEntries(index.entries, "Иванова")).toEqual([]);
    expect(searchEntries(index.entries, "Иванова", "counterparties", true)[0]).toMatchObject({ id: "company", archived: true });
  });

  it("reports a failed directory read alongside independently searchable records", async () => {
    vi.mocked(readDraft).mockRejectedValue(new Error("Directory unavailable"));
    vi.mocked(listRecords).mockImplementation(async (module) => module === "staff" ? [record("Петров", { fullName: "Петров" })] : []);
    const index = await loadSearchIndex();
    expect(searchEntries(index.entries, "Петров")).toHaveLength(1);
    expect(index.errors).toEqual(["Контрагенты: Error: Directory unavailable"]);
  });
});
