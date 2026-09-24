import { invoke } from "@tauri-apps/api/core";

export interface PreviewImage { url: string; retainedBytes: number }

/** PNG bytes stay binary across IPC; only a small blob URL enters React state. */
export function previewImageFromBytes(bytes: ArrayBuffer | Uint8Array): PreviewImage {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length < 24 || data[0] !== 137 || data[1] !== 80 || data[2] !== 78 || data[3] !== 71
      || data[4] !== 13 || data[5] !== 10 || data[6] !== 26 || data[7] !== 10
      || String.fromCharCode(...data.subarray(12, 16)) !== "IHDR") {
    throw new Error("Некорректное изображение предпросмотра.");
  }
  const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = header.getUint32(16), height = header.getUint32(20);
  if (!width || !height || width > 1400 || height > 1400) throw new Error("Недопустимый размер предпросмотра.");
  const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: "image/png" });
  return { url: URL.createObjectURL(blob), retainedBytes: blob.size + width * height * 4 };
}

export async function readPreviewImage(path: string): Promise<PreviewImage> {
  return previewImageFromBytes(await invoke<ArrayBuffer>("read_scanner_preview", { path }));
}

export function releasePreviewImage(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}
