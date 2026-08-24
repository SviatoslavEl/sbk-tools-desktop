import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "./storage";

const isTauri = () => "__TAURI_INTERNALS__" in window;

export async function chooseOpenPath(
  title: string,
  extensions: string[],
): Promise<string | null> {
  if (!isTauri()) return null;
  const result = await open({
    title,
    multiple: false,
    directory: false,
    filters: [{ name: title, extensions }],
  });
  return typeof result === "string" ? result : null;
}

export async function chooseDirectory(title: string): Promise<string | null> {
  if (!isTauri()) return null;
  const result = await open({ title, multiple: false, directory: true });
  return typeof result === "string" ? result : null;
}

export async function chooseSavePath(
  title: string,
  defaultPath: string,
  extensions: string[],
): Promise<string | null> {
  if (!isTauri()) return defaultPath;
  return save({
    title,
    defaultPath,
    filters: [{ name: title, extensions }],
  });
}

export async function exportText(
  title: string,
  defaultPath: string,
  extensions: string[],
  content: string,
) {
  const path = await chooseSavePath(title, defaultPath, extensions);
  if (!path) return null;
  await writeTextFile(path, content);
  return path;
}

export async function importText(title: string, extensions: string[]) {
  const path = await chooseOpenPath(title, extensions);
  if (!path) return null;
  return { path, content: await readTextFile(path) };
}
