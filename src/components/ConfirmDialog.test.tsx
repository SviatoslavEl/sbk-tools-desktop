import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./Dialog";

const state = vi.hoisted(() => ({ updates: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, (next: unknown) => state.updates.push(next)],
}));

function find(node: ReactNode, label: string): (() => void) | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, label)).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return undefined;
  if (node.type === "button" && node.props.children === label) return node.props.onClick;
  return find(node.props.children, label);
}

describe("confirmation operation lifecycle", () => {
  beforeEach(() => { state.updates.length = 0; });
  it("serializes a double click and blocks cancel and backdrop until completion", async () => {
    let finish!: () => void;
    const action = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const close = vi.fn();
    const tree = ConfirmDialog({ title: "Архив", message: "Выбрана одна тестовая запись", onConfirm: action, onClose: close });
    find(tree, "Подтвердить")!();
    find(tree, "Подтвердить")!();
    find(tree, "Отмена")!();
    tree.props.onClose();
    expect(action).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(state.updates[state.updates.length - 1]).toBe(false));
    find(tree, "Отмена")!();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("keeps errors visible and permits retry without claiming success", async () => {
    const action = vi.fn().mockRejectedValueOnce(new Error("Сеть недоступна")).mockResolvedValueOnce(undefined);
    const close = vi.fn();
    const tree = ConfirmDialog({ title: "Архив", message: "Тест", onConfirm: action, onClose: close });
    find(tree, "Подтвердить")!();
    await vi.waitFor(() => expect(state.updates[state.updates.length - 1]).toBe(false));
    expect(state.updates.some((value) => String(value).includes("Сеть недоступна"))).toBe(true);
    expect(close).not.toHaveBeenCalled();
    find(tree, "Подтвердить")!();
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(close).not.toHaveBeenCalled();
  });
  it("also catches a synchronous operation error", async () => {
    const tree = ConfirmDialog({ title: "Тест", message: "Тест", onConfirm: () => { throw new Error("Отказ записи"); }, onClose: vi.fn() });
    find(tree, "Подтвердить")!();
    expect(state.updates.some((value) => String(value).includes("Отказ записи"))).toBe(true);
    expect(state.updates[state.updates.length - 1]).toBe(false);
  });
});
