import { describe, expect, it } from "vitest";
import { workspacePasswordError, workspacePasswordHint } from "./passwordPolicy";

describe("пароль рабочей папки", () => {
  it("объясняет короткий пароль вместо молчаливой блокировки", () => {
    expect(workspacePasswordError("123")).toContain("не менее 6");
    expect(workspacePasswordHint).toContain("От 6 до 128");
  });

  it("принимает кириллицу, цифры и специальные символы", () => {
    expect(workspacePasswordError("Пароль-42!")).toBe("");
  });

  it("отклоняет крайние пробелы и управляющие символы", () => {
    expect(workspacePasswordError(" пароль")) .toContain("начале и конце");
    expect(workspacePasswordError("пароль\n")) .toContain("начале и конце");
  });
});
