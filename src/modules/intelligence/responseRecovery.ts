import { parseUniqueJson } from "./uniqueJson";
import { RESPONSE_PREPARATION_LIMITS } from "./responsePreparationBounds";

export interface SourceReferenceIssue {
  kind: "unknown" | "duplicate" | "invalid" | "uncited";
  path: string;
  sourceId?: string;
}
export interface FailedIntelligenceResponse {
  raw: string;
  message: string;
  format: "schema" | "json" | "manual";
  stage?: string;
  issues: SourceReferenceIssue[];
  moreIssues: boolean;
  sources: readonly Readonly<{ id: string; name: string; nameTruncated?: true }>[];
}
const maxIssues = 12;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Array.from(value).length <= 128 && !/[\u0000-\u001f]/u.test(value);

/** Explanations only. These helpers never accept, repair or rebind a reference. */
export function sourceListIssue(value: unknown, available: readonly string[], path: string): SourceReferenceIssue | undefined {
  if (!Array.isArray(value) || value.length > 100) return { kind: "invalid", path };
  const seen = new Set<string>();
  for (const [index, id] of value.entries()) {
    const at = `${path}[${index}]`;
    if (!identifier(id)) return { kind: "invalid", path: at };
    if (!available.includes(id)) return { kind: "unknown", path: at, sourceId: id };
    if (seen.has(id)) return { kind: "duplicate", path: at, sourceId: id };
    seen.add(id);
  }
}
export function evidenceSourceIssue(value: unknown, available: readonly string[], cited: readonly unknown[], path: string): SourceReferenceIssue | undefined {
  if (!identifier(value)) return { kind: "invalid", path };
  if (!available.includes(value)) return { kind: "unknown", path, sourceId: value };
  if (!cited.includes(value)) return { kind: "uncited", path, sourceId: value };
}
export function sourceReferenceMessage(issue: SourceReferenceIssue): string {
  const id = issue.sourceId ? ` «${issue.sourceId}»` : "";
  if (issue.kind === "unknown") return `Неизвестная ссылка на источник${id} (${issue.path}). Такой ссылки нет среди выбранных документов.`;
  if (issue.kind === "duplicate") return `Повторяющаяся ссылка на источник${id} (${issue.path}). Один документ нельзя указывать в sourceIds дважды.`;
  if (issue.kind === "uncited") return `Источник подтверждения${id} (${issue.path}) отсутствует в sourceIds этой карточки.`;
  return `Недопустимый формат ссылки на источник (${issue.path}). Нужен непустой идентификатор до 128 символов без управляющих символов.`;
}

/** Bounded read-only diagnostics for the error panel, not a second parser or a
 * permission to use any recovered card. Never inspect/echo fields or quotes. */
export function diagnoseResponseSources(raw: string, available: readonly string[]): { issues: SourceReferenceIssue[]; moreIssues: boolean } {
  const issues: SourceReferenceIssue[] = [];
  if (typeof raw !== "string" || raw.length > RESPONSE_PREPARATION_LIMITS.rawBytes || new TextEncoder().encode(raw).byteLength > RESPONSE_PREPARATION_LIMITS.rawBytes
    || available.length > 100 || available.some((id) => !identifier(id)) || new Set(available).size !== available.length) return { issues, moreIssues: false };
  let parsed: unknown;
  try {
    let json = raw.trim();
    if (json.startsWith("```")) { const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(json); if (!fenced) return { issues, moreIssues: false }; json = fenced[1].trim(); }
    parsed = parseUniqueJson(json);
  } catch { return { issues, moreIssues: false }; }
  if (!object(parsed) || !Array.isArray(parsed.items) || parsed.items.length > 100) return { issues, moreIssues: false };
  const add = (issue: SourceReferenceIssue | undefined) => { if (issue) issues.push(issue); return issues.length > maxIssues; };
  for (const [index, item] of parsed.items.entries()) {
    if (!object(item)) continue;
    const ids = item.sourceIds === undefined ? available : item.sourceIds;
    if (add(sourceListIssue(ids, available, `items[${index}].sourceIds`))) break;
    if (!Array.isArray(item.evidence) || item.evidence.length > 500 || !Array.isArray(ids)) continue;
    for (const [claimIndex, claim] of item.evidence.entries()) {
      if (object(claim) && add(evidenceSourceIssue(claim.sourceId, available, ids, `items[${index}].evidence[${claimIndex}].sourceId`))) break;
    }
    if (issues.length > maxIssues) break;
  }
  return { issues: issues.slice(0, maxIssues), moreIssues: issues.length > maxIssues };
}

/** At most one such record is retained by the UI: exact raw <=2 MiB, source
 * metadata <=256 KiB, and twelve diagnostics. Display names are not evidence;
 * only they may be shortened explicitly. Never retain source bodies or quotes. */
export function failedIntelligenceResponse(raw: string, sources: readonly { id: string; name: string }[], message: string, format: FailedIntelligenceResponse["format"], stage?: string): FailedIntelligenceResponse | null {
  if (typeof raw !== "string" || raw.length > RESPONSE_PREPARATION_LIMITS.rawBytes || new TextEncoder().encode(raw).byteLength > RESPONSE_PREPARATION_LIMITS.rawBytes) return null;
  if (!Array.isArray(sources) || sources.length > 100 || sources.some((source) => !source || !identifier(source.id) || typeof source.name !== "string" || source.name.length > 20_000)
    || new Set(sources.map((source) => source.id)).size !== sources.length) return null;
  const metadata = sources.map((source) => {
    const name = Array.from(source.name);
    return Object.freeze({ id: source.id, name: name.slice(0, 200).join(""), ...(name.length > 200 ? { nameTruncated: true as const } : {}) });
  });
  if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > 256 * 1024) return null;
  return { raw, sources: Object.freeze(metadata), message: message.slice(0, 1000), format, ...(stage ? { stage: stage.slice(0, 200) } : {}), ...diagnoseResponseSources(raw, metadata.map((source) => source.id)) };
}
