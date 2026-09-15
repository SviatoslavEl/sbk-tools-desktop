// @ts-expect-error Node's built-in module is available in the test runner.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const asset = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url));
const text = (path: string): string => asset(path).toString("utf8");

describe("SBK desktop application icon", () => {
  it("uses one local vector source for the document/tool identity and browser icon", () => {
    const svg = text("public/sbk-tools.svg");
    expect(svg).toContain('viewBox="0 0 512 512"');
    expect(svg).toContain("<title>СБК Инструменты</title>");
    expect(svg).toContain("#4338CA");
    expect(svg).toContain("#0D9488");
    expect(svg).not.toMatch(/<image|<script|(?:href|src)="https?:/);
    expect(text("index.html")).toContain('rel="icon" type="image/svg+xml" href="/sbk-tools.svg"');
    expect(text("scripts/generate_app_icons.mjs")).toContain('"sbk-tools.svg"');
  });

  it.each([
    ["32x32.png", 32], ["128x128.png", 128], ["128x128@2x.png", 256], ["icon.png", 512],
  ] as const)("ships %s at its expected size with RGBA transparency", (filename, size) => {
    const png = asset(`src-tauri/icons/${filename}`);
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
  });

  it("includes crisp small and large Windows icon representations and a valid Mac container", () => {
    const ico = asset("src-tauri/icons/icon.ico");
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
      const entry = 6 + 16 * index;
      const size = Number(ico[entry]) || 256;
      expect(Number(ico[entry + 1]) || 256).toBe(size);
      const length = Number(ico.readUInt32LE(entry + 8));
      const offset = Number(ico.readUInt32LE(entry + 12));
      expect(offset + length).toBeLessThanOrEqual(ico.length);
      expect(length).toBeGreaterThan(0);
      return size;
    });
    expect(sizes).toEqual(expect.arrayContaining([16, 32, 48, 256]));
    const icns = asset("src-tauri/icons/icon.icns");
    expect(icns.subarray(0, 4).toString("ascii")).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
  });

  it("retains the established icon paths for the app, setup and uninstaller", () => {
    const config = JSON.parse(text("src-tauri/tauri.conf.json"));
    expect(config.bundle.icon).toEqual(expect.arrayContaining(["icons/icon.ico", "icons/icon.icns", "icons/32x32.png"]));
    const installer = text("scripts/windows-installed.nsi");
    expect(installer).toContain('!define MUI_ICON "icon.ico"');
    expect(installer).toContain('!define MUI_UNICON "icon.ico"');
    expect(text("scripts/package_windows_installed.ps1")).toContain('"src-tauri\\icons\\icon.ico"');
    expect(config.identifier).toBe("ru.sbk.tools");
  });
});
