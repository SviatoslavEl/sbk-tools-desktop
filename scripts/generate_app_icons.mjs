import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, "public", "sbk-tools.svg");
const target = join(root, "src-tauri", "icons");
const desktopIcons = [
  "32x32.png", "128x128.png", "128x128@2x.png", "icon.png", "icon.ico", "icon.icns",
  "Square30x30Logo.png", "Square44x44Logo.png", "Square71x71Logo.png",
  "Square89x89Logo.png", "Square107x107Logo.png", "Square142x142Logo.png",
  "Square150x150Logo.png", "Square284x284Logo.png", "Square310x310Logo.png", "StoreLogo.png",
];
// The CLI also produces mobile assets. Generate in an owned temporary folder
// and publish only the existing desktop filenames used by our two installers.
const temporary = mkdtempSync(join(tmpdir(), "sbk-app-icons-"));
try {
  if (!readFileSync(source, "utf8").includes('viewBox="0 0 512 512"')) {
    throw new Error("Expected the square SBK SVG source");
  }
  execFileSync(process.execPath, [join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), "icon", source, "--output", temporary], { cwd: root, stdio: "inherit" });
  for (const filename of desktopIcons) copyFileSync(join(temporary, filename), join(target, filename));
  process.stdout.write(`Generated ${desktopIcons.length} desktop icons from public/sbk-tools.svg\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
