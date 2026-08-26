import { invoke } from "@tauri-apps/api/core";

export const intelligenceCapabilities = ["tender.extract_requirements", "tender.summarize", "tender.generate_questions", "contract.detect_risks", "experience.rank", "team.rank", "document.detect_conflicts", "document.classify", "application.review_completeness"] as const;
export type IntelligenceCapability = typeof intelligenceCapabilities[number];
export interface IntelligenceProviderStatus { enabled: boolean; healthy: boolean; capabilities: IntelligenceCapability[]; message: string; maxRequestBytes: number; maxResponseBytes: number; }
export type ConnectionMode = "disabled" | "same-computer" | "local-network";
export interface ProviderConfiguration { mode: ConnectionMode; endpoint?: string; secretReference?: string; certificateFingerprint?: string; allowRedirects: boolean; requestTimeoutSeconds: number; maxParallelJobs: number; }

const isTauri = () => "__TAURI_INTERNALS__" in window;
export async function getIntelligenceProviderStatus(): Promise<IntelligenceProviderStatus> {
  if (!isTauri()) return { enabled: false, healthy: false, capabilities: [], message: "AI-сервер не настроен. Все локальные функции продолжают работать.", maxRequestBytes: 8 * 1024 * 1024, maxResponseBytes: 16 * 1024 * 1024 };
  return invoke<IntelligenceProviderStatus>("intelligence_provider_status");
}
export async function validateIntelligenceConfiguration(config: ProviderConfiguration): Promise<void> {
  if (!isTauri()) return;
  await invoke("validate_intelligence_configuration", { config });
}
