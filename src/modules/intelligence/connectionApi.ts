import { invoke } from "@tauri-apps/api/core";

export interface ConnectionProfile {
  id: string;
  name: string;
  scope: "local" | "network" | "external";
  protocol: "ollama" | "openai-compatible";
  endpoint: string;
  model: string;
  timeoutSeconds: number;
}
export interface ConnectionTestResult { models: string[]; message: string; }
export interface IntelligenceAnalysisResult { text: string; model: string; }

export const intelligenceTransportLimitBytes = 2 * 1024 * 1024;

function requireDesktop() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    throw new Error("Подключение к ИИ доступно в установленном приложении. Здесь можно настроить профиль и распределить данные вручную.");
  }
}

/** Only the public connection fields cross IPC; credentials never enter the profile. */
export function publicConnectionProfile(profile: ConnectionProfile): ConnectionProfile {
  return { id: profile.id, name: profile.name, scope: profile.scope, protocol: profile.protocol,
    endpoint: profile.endpoint, model: profile.model, timeoutSeconds: profile.timeoutSeconds };
}

export function validateConnectionProfile(profile: ConnectionProfile, requireModel = false): void {
  if (!profile.id.trim() || profile.id.length > 128 || !profile.name.trim() || profile.name.length > 200) {
    throw new Error("Укажите название подключения.");
  }
  if (!["local", "network", "external"].includes(profile.scope)
    || !["ollama", "openai-compatible"].includes(profile.protocol)) throw new Error("Выберите тип подключения.");
  if (!Number.isInteger(profile.timeoutSeconds) || profile.timeoutSeconds < 5 || profile.timeoutSeconds > 600) {
    throw new Error("Время ожидания должно быть от 5 до 600 секунд.");
  }
  if (profile.endpoint.length > 2048 || /[\s\\]/u.test(profile.endpoint)) throw new Error("Укажите корректный адрес ИИ-сервиса.");
  let endpoint: URL;
  try { endpoint = new URL(profile.endpoint); } catch { throw new Error("Укажите полный адрес ИИ-сервиса, начиная с http:// или https://."); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash) throw new Error("Адрес не должен содержать пароль, параметры или фрагмент.");
  // Check the original spelling too: URL canonicalization would accept 127.1 or
  // numeric/hexadecimal aliases as 127.0.0.1 even though they are not permitted.
  const authority = profile.endpoint.match(/^https?:\/\/([^/]+)(?:\/|$)/iu)?.[1]?.toLowerCase();
  const local = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u.test(authority ?? "");
  if (profile.scope === "local" && !local) throw new Error("Для этого компьютера используйте localhost, 127.0.0.1 или [::1].");
  if (endpoint.protocol === "http:" && (profile.scope !== "local" || !local)) {
    throw new Error("Для сети и внешнего сервиса используйте HTTPS.");
  }
  if (profile.model.length > 200 || /[\x00-\x1f\x7f]/u.test(profile.model)
    || (requireModel && !profile.model.trim())) throw new Error("Укажите название модели.");
}

export async function testIntelligenceConnection(profile: ConnectionProfile, apiKey?: string): Promise<ConnectionTestResult> {
  validateConnectionProfile(profile);
  requireDesktop();
  return invoke<ConnectionTestResult>("test_intelligence_connection", { profile: publicConnectionProfile(profile), apiKey: apiKey || null });
}

export async function runIntelligenceAnalysis(
  profile: ConnectionProfile, prompt: string, apiKey?: string, requestId = crypto.randomUUID(),
): Promise<IntelligenceAnalysisResult> {
  validateConnectionProfile(profile, true);
  if (!prompt.trim()) throw new Error("Добавьте текст для анализа.");
  if (new TextEncoder().encode(prompt).byteLength > intelligenceTransportLimitBytes) {
    throw new Error("Текст слишком большой. Разделите его на части размером до 2 МБ.");
  }
  requireDesktop();
  return invoke<IntelligenceAnalysisResult>("run_intelligence_analysis", {
    profile: publicConnectionProfile(profile), prompt, apiKey: apiKey || null, requestId,
  });
}

/** Stops local waiting and closes the transport; a remote provider may keep generating. */
export async function cancelIntelligenceRequest(requestId: string): Promise<void> {
  requireDesktop();
  return invoke<void>("cancel_intelligence_request", { requestId });
}
