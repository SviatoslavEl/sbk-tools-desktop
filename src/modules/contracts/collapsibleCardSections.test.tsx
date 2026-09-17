import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CollapsibleEditorBlock } from "../../components/CollapsibleEditorBlock";
import { ContractDocumentsEditor } from "./Contracts";
import { CompanyEditor } from "./CompanyDirectory";
import { emptyCompany, type CompanyCard } from "./companies";
import { emptyContractDocument } from "./types";

const hooks = vi.hoisted(() => ({ index: 0, values: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(), useEffect: vi.fn(), useId: () => "test-field", useCallback: (fn: unknown) => fn,
  useRef: (value: unknown) => ({ current: value }),
  useState: (initial: unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
  },
}));

type Props = { children?: ReactNode; title?: string; summary?: string; defaultExpanded?: boolean; revealKey?: number; onClick?: () => void; disabled?: boolean; "aria-label"?: string; value?: string };
function text(node: ReactNode): string { if (typeof node === "string" || typeof node === "number") return String(node); if (Array.isArray(node)) return node.map(text).join(""); return isValidElement<Props>(node) ? text(node.props.children) : ""; }
function collect(node: ReactNode, predicate: (type: unknown, props: Props) => boolean): Props[] {
  if (Array.isArray(node)) return node.flatMap((child) => collect(child, predicate));
  if (!isValidElement<Props>(node)) return [];
  return [...(predicate(node.type, node.props) ? [node.props] : []), ...collect(node.props.children, predicate)];
}
const blocks = (node: ReactNode) => collect(node, (type) => type === CollapsibleEditorBlock);
const button = (node: ReactNode, label: string) => collect(node, (type, props) => type === "button" && text(props.children) === label)[0];

describe("contract and company repeating editor sections", () => {
  beforeEach(() => { hooks.index = 0; hooks.values = []; });
  it("collapses saved contract documents by meaningful name and opens new empty documents", () => {
    const documents = [
      { ...emptyContractDocument(), name: "Сертификат ISO", type: "Сертификат" as const, fileName: "iso.pdf", relativePath: "attachments/iso.pdf" },
      { ...emptyContractDocument(), fileName: "signed.pdf", relativePath: "attachments/signed.pdf" },
      emptyContractDocument(),
    ];
    const onChange = vi.fn();
    const sections = blocks(ContractDocumentsEditor({ recordId: "qa", documents, onChange }));
    expect(sections.map((section) => [section.title, section.defaultExpanded])).toEqual([["Сертификат ISO", false], ["signed.pdf", false], ["Договор · без названия", true]]);
    expect(sections[0].summary).toBe("Сертификат · iso.pdf");
    expect(button(sections[0].children, "Открыть")).toBeDefined();
    expect(button(sections[0].children, "Заменить файл")).toBeDefined();
    expect(collect(sections[0].children, (_type, props) => props["aria-label"] === "Удалить Сертификат ISO")).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("collapses saved company contacts and signers while keeping empty new entries open", () => {
    const company: CompanyCard = {
      ...emptyCompany("2026-09-17", "company"), name: "Компания", scope: "internal",
      authorizedSigners: [
        { id: "known-signer", fullName: "Иван Подписант", position: "Директор", powerOfAttorneyNumber: "Д-42", issuedAt: "", expiresAt: "", notes: "", document: { fileName: "power.pdf", relativePath: "attachments/power.pdf" } },
        { id: "new-signer", fullName: "", position: "", powerOfAttorneyNumber: "", issuedAt: "", expiresAt: "", notes: "", document: {} },
      ],
      decisionMakers: [
        { id: "known-contact", fullName: "Анна Контакт", position: "Руководитель", department: "", phone: "+7 900 000 00 00", email: "anna@example.com", notes: "", isPrimary: true },
        { id: "new-contact", fullName: "", position: "", department: "", phone: "", email: "", notes: "", isPrimary: false },
      ],
    };
    const sections = blocks(CompanyEditor({ company, companies: [company], onSave: vi.fn(), onClose: vi.fn() }));
    expect(sections.map((section) => [section.title, section.defaultExpanded])).toEqual([["Иван Подписант", false], ["Новый подписант", true], ["Анна Контакт", false], ["Новый контакт", true]]);
    expect(sections[0].summary).toContain("Доверенность № Д-42");
    expect(sections[0].summary).toContain("power.pdf");
    expect(sections[2].summary).toContain("anna@example.com");
    expect(button(sections[0].children, "Открыть")).toBeDefined();
    expect(button(sections[2].children, "Удалить ЛПР")).toBeDefined();
  });
  it("opens newly added relationships even when their target is preselected", () => {
    const target = { ...emptyCompany("2026-09-17", "target"), name: "Компания группы" };
    const company: CompanyCard = { ...emptyCompany("2026-09-17", "company"), name: "Компания", affiliations: [{ id: "old", targetCompanyId: target.id, type: "Головная компания", note: "" }] };
    const render = () => { hooks.index = 0; return CompanyEditor({ company, companies: [company, target], onSave: vi.fn(), onClose: vi.fn() }); };
    expect(blocks(render())[0]).toMatchObject({ title: "Компания группы", defaultExpanded: false });
    button(render(), "Добавить связь").onClick!();
    expect(blocks(render()).map((section) => section.defaultExpanded)).toEqual([false, true]);
    expect(company.affiliations).toHaveLength(1);
  });
  it("reveals blocks when validation finds a required signer name missing", () => {
    const company: CompanyCard = { ...emptyCompany("2026-09-17", "company"), name: "Компания", scope: "internal", authorizedSigners: [{ id: "signer", fullName: "", position: "Директор", powerOfAttorneyNumber: "", issuedAt: "", expiresAt: "", notes: "", document: {} }] };
    const onSave = vi.fn();
    const render = () => { hooks.index = 0; return CompanyEditor({ company, companies: [company], onSave, onClose: vi.fn() }); };
    expect(blocks(render())[0]).toMatchObject({ defaultExpanded: false, revealKey: 0 });
    button(render(), "Сохранить компанию").onClick!();
    expect(blocks(render())[0].revealKey).toBe(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
