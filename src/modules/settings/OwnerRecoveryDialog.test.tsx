import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OwnerRecoveryDialog, recoveryConfirmation, recoveryInputReady, type RecoveryInput } from "./OwnerRecoveryDialog";

const input: RecoveryInput = { password: "synthetic-owner-only", targetToken: "test-session", reason: "Все тестовые экземпляры закрыты", confirmation: recoveryConfirmation, confirmedAllEditorsClosed: true };

describe("explicit owner recovery UI", () => {
  it("requires all safeguards together", () => expect(recoveryInputReady(input)).toBe(true));
  it.each([
    { password: "" }, { targetToken: "" }, { reason: "  " }, { reason: "12" },
    { reason: "x".repeat(501) }, { confirmation: "восстановить доступ" },
    { confirmation: "" }, { confirmedAllEditorsClosed: false },
  ])("refuses incomplete input %j", (patch) => expect(recoveryInputReady({ ...input, ...patch })).toBe(false));
  it("does not count whitespace as the reason", () => expect(recoveryInputReady({ ...input, reason: "  12  " })).toBe(false));
  it("starts without a filled password or prechecked declaration", () => {
    const html = renderToStaticMarkup(<OwnerRecoveryDialog target={{ token: "test-session", owner: { displayName: "QA user", deviceName: "QA-WINDOWS", startedAt: "2026-09-15T08:00:00Z" } }} busy={false} onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(html).toContain("QA-WINDOWS");
    expect(html).toContain("ВОССТАНОВИТЬ ДОСТУП");
    expect(html).toContain("Не используйте при работающем или отключённом от сети редакторе");
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Подтвердить восстановление/);
    expect(html).not.toContain('checked=""');
    expect(html).not.toContain("synthetic-owner-only");
    expect(html).toContain("Права редактора не передаются автоматически");
  });
  it("labels a marker without implying liveness and explicitly shows a missing computer", () => {
    const html = renderToStaticMarkup(<OwnerRecoveryDialog target={{ token: "test-session", owner: { displayName: "QA user", deviceName: "", startedAt: "2000-01-01T00:00:00Z" } }} busy={false} onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(html).toContain("Зафиксирован сеанс: QA user");
    expect(html).toContain("Компьютер не указан");
    expect(html).toContain("Активность этого сеанса не подтверждена");
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Подтвердить восстановление/);
    expect(html).not.toContain('checked=""');
  });
});
