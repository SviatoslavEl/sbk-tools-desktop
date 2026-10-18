import { assertResponsePreparationSources, RESPONSE_PREPARATION_LIMITS } from "./responsePreparationBounds";
import type { IntelligenceSource } from "./workbenchTypes";

/** Preserve every validated source/fragment metadata value and array order.
 * Object insertion order is not part of a source's semantic identity. */
function canonicalSnapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalSnapshot);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0).map(([key, part]) => [key, canonicalSnapshot(part)]));
  return value;
}

/** Identity only, never evidence, authorisation, persistence or a model field.
 * Hash the whole immutable result snapshot, not filenames or declared file SHA
 * alone. A source with edited text can retain an old file SHA. Fail closed
 * without truncation or a weak fallback if bounds/WebCrypto are unavailable. */
export async function taskSourceSnapshotKey(sources: readonly IntelligenceSource[]): Promise<`sha256:${string}`> {
  assertResponsePreparationSources(sources);
  const payload = new TextEncoder().encode(JSON.stringify(canonicalSnapshot(sources)));
  if (payload.byteLength > RESPONSE_PREPARATION_LIMITS.snapshotBytes) throw new Error("Снимок источников превышает 8 МБ. Ключ задачи не создан; материалы не усечены.");
  if (typeof globalThis.crypto?.subtle?.digest !== "function") throw new Error("Без WebCrypto нельзя безопасно подтвердить снимок источников задачи.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", payload);
  if (digest.byteLength !== 32) throw new Error("Не удалось подтвердить SHA-256 снимка источников задачи.");
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
