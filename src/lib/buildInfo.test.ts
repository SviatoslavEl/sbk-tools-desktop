import { describe, expect, it } from "vitest";
import { describeBuild } from "./buildInfo";

describe("displayed build identity", () => {
  it("shows a build supplied by the packaging job, without a fixed test number", () => {
    const build = describeBuild("2.9.0", { artifactVersion: "2.9.0-test.105", revision: "a".repeat(40), target: "x86_64-pc-windows-msvc", installed: true });
    expect(build.label).toBe("2.9.0-test.105"); expect(build.distribution).toBe(true);
    expect(build.supportText).toContain("Ревизия: " + "a".repeat(40)); expect(build.supportText).toContain("установочный Windows");
  });
  it("normalizes a release tag and includes its revision", () => {
    const build = describeBuild("2.9.1", { artifactVersion: "v2.9.1", revision: "B".repeat(40) });
    expect(build.label).toBe("2.9.1"); expect(build.revision).toBe("b".repeat(40));
  });
  it.each([{}, { artifactVersion: "2.9.0-test.1" }, { revision: "a".repeat(40) }, { artifactVersion: "local-development", revision: "a".repeat(40) }])("honestly distinguishes local or incomplete metadata (%j)", (environment) => {
    const build = describeBuild("2.9.0", environment);
    expect(build.label).toBe("2.9.0 · разработка / не дистрибутив"); expect(build.distribution).toBe(false);
  });
  it("does not copy arbitrary injected text as a build label, revision or platform", () => {
    const build = describeBuild("2.9.0", { artifactVersion: "C:\\secret\\path", revision: "secret\npassword", target: "/Users/private" });
    expect(build.supportText).not.toMatch(/secret|password|Users|private/);
  });
});
