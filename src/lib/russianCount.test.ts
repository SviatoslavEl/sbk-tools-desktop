import { describe, expect, it } from "vitest";
import { formatRussianCount, russianCountWord } from "./russianCount";

describe("Russian count labels", () => {
  it.each([[0,"источников"],[1,"источник"],[2,"источника"],[5,"источников"],[11,"источников"],[12,"источников"],[13,"источников"],[14,"источников"],[21,"источник"],[22,"источника"],[25,"источников"],[101,"источник"],[111,"источников"],[112,"источников"],[-1,"источник"],[-22,"источника"],[1.5,"источника"]])("inflects %s", (count, expected) => {
    expect(russianCountWord(Number(count), ["источник", "источника", "источников"])).toBe(expected);
  });
  it("formats the numeric value without changing it", () => {
    expect(formatRussianCount(1, ["фрагмент", "фрагмента", "фрагментов"])).toBe("1 фрагмент");
    expect(formatRussianCount(22, ["символ", "символа", "символов"])).toBe("22 символа");
    expect(formatRussianCount(25, ["токен", "токена", "токенов"])).toBe("25 токенов");
  });
});
