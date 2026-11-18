import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cancelIntelligenceRequest, intelligenceTransportLimitBytes, publicConnectionProfile,
  intelligenceSchemaLimitBytes, runIntelligenceAnalysis, runContractFactAnalysis, testIntelligenceConnection, validateConnectionProfile, type ConnectionProfile, type IntelligenceAnalysisDiagnostics, type IntelligenceAnalysisResult } from "./connectionApi";

const ipc = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc }));
const profile: ConnectionProfile = { id: "local-model", name: "Локальная модель", scope: "local", protocol: "ollama",
  endpoint: "http://127.0.0.1:11434", model: "qwen", timeoutSeconds: 120 };
const requestId = "1b4bc1e8-68bf-4e30-a0b3-4f16f9dd946e";

beforeEach(() => { vi.stubGlobal("window", { __TAURI_INTERNALS__: {} }); ipc.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe("explicit AI transport API", () => {
  it("uses a separate explicit fact route for Ollama, leaves other provider options unknown and sends no profile extras", async () => {
    const schema = { type: "object", additionalProperties: false, properties: {} };
    await runContractFactAnalysis({ ...profile, outputMode: "schema" }, "SYNTHETIC_FACT_REQUEST", "SYNTHETIC_KEY", requestId, schema);
    expect(ipc.mock.calls[0][0]).toBe("run_contract_fact_analysis");
    expect(ipc.mock.calls[0][1].responseSchema).toEqual(schema);
    expect(ipc.mock.calls[0][1].profile).not.toHaveProperty("num_predict");
    await runContractFactAnalysis({ ...profile, protocol: "openai-compatible", outputMode: "schema" }, "SYNTHETIC_FACT_REQUEST", undefined, requestId, schema);
    expect(ipc.mock.calls[1][0]).toBe("run_intelligence_analysis");
  });
  it("keeps only public connection fields in profiles crossing IPC", async () => {
    const untrusted = { ...profile, apiKey: "should-not-be-in-profile", secretReference: "should-not-persist" };
    expect(publicConnectionProfile(untrusted)).toEqual(profile);
    ipc.mockResolvedValue({ models: ["qwen"], message: "OK" });
    await testIntelligenceConnection(untrusted, "session-key");
    expect(ipc).toHaveBeenCalledWith("test_intelligence_connection", { profile, apiKey: "session-key" });
  });
  it("passes per-request cancellation IDs without touching shared-folder diagnostics", async () => {
    ipc.mockResolvedValue({ text: '{"items":[]}', model: "qwen" });
    await runIntelligenceAnalysis(profile, "JSON: test source", undefined, requestId);
    expect(ipc).toHaveBeenCalledWith("run_intelligence_analysis", { profile, prompt: "JSON: test source", apiKey: null, requestId });
    await cancelIntelligenceRequest(requestId);
    expect(ipc).toHaveBeenLastCalledWith("cancel_intelligence_request", { requestId });
  });
  it("does not simulate an AI response in browser preview", async () => {
    vi.stubGlobal("window", {});
    await expect(testIntelligenceConnection(profile)).rejects.toThrow("установленном приложении");
    await expect(runIntelligenceAnalysis(profile, "test", undefined, requestId)).rejects.toThrow("установленном приложении");
    expect(ipc).not.toHaveBeenCalled();
  });
  it.each(["http://127.1:11434", "http://2130706433:11434", "http://0x7f000001:11434", "http://127.0.0.2:11434", "http://localhost.example:11434"])(
    "rejects disguised or nonliteral loopback address %s", (endpoint) => {
      expect(() => validateConnectionProfile({ ...profile, endpoint })).toThrow("localhost");
    });
  it.each(["http://localhost:11434", "http://127.0.0.1:11434/api", "http://[::1]:11434"])(
    "accepts deliberate local address %s", (endpoint) => {
      expect(() => validateConnectionProfile({ ...profile, endpoint })).not.toThrow();
    });
  it("requires HTTPS for both network and external profiles", () => {
    for (const scope of ["network", "external"] as const) {
      expect(() => validateConnectionProfile({ ...profile, scope, endpoint: "http://127.0.0.1:11434" })).toThrow("HTTPS");
      expect(() => validateConnectionProfile({ ...profile, scope, endpoint: "https://inference.example/v1" })).not.toThrow();
    }
  });
  it.each(["https://key:secret@api.example/v1", "https://api.example/v1?key=secret", "https://api.example/v1#secret", "file:///tmp/model", "https://api.example\\path"])(
    "rejects hidden authentication or unsupported address %s", (endpoint) => {
      expect(() => validateConnectionProfile({ ...profile, scope: "external", endpoint })).toThrow();
    });
  it("allows listing models without requiring one but validates generation model and timeout", async () => {
    ipc.mockResolvedValue({ models: [], message: "OK" });
    await testIntelligenceConnection({ ...profile, model: "" });
    await expect(runIntelligenceAnalysis({ ...profile, model: "" }, "test", undefined, requestId)).rejects.toThrow("модели");
    for (const timeoutSeconds of [4, 601, 5.5]) expect(() => validateConnectionProfile({ ...profile, timeoutSeconds })).toThrow("5 до 600");
  });
  it("counts UTF-8 prompt bytes and rejects blank prompts before IPC", async () => {
    await expect(runIntelligenceAnalysis(profile, " ", undefined, requestId)).rejects.toThrow("текст");
    await expect(runIntelligenceAnalysis(profile, "я".repeat(intelligenceTransportLimitBytes), undefined, requestId)).rejects.toThrow("2 МБ");
    expect(ipc).not.toHaveBeenCalled();
  });
  it("sends the explicit output schema and optional mode without persisting credentials", async () => {
    const schemaProfile = { ...profile, outputMode: "schema" as const };
    const responseSchema = { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"], additionalProperties: false };
    ipc.mockResolvedValue({ text: '{"items":[]}', model: "qwen", metrics: { elapsedMilliseconds: 100, inputTokens: 12 } });
    const result = await runIntelligenceAnalysis(schemaProfile, "JSON: synthetic", "session-key", requestId, responseSchema);
    expect(ipc).toHaveBeenCalledWith("run_intelligence_analysis", { profile: schemaProfile, prompt: "JSON: synthetic", apiKey: "session-key", requestId, responseSchema });
    expect(result.metrics).toEqual({ elapsedMilliseconds: 100, inputTokens: 12 });
    expect(publicConnectionProfile({ ...schemaProfile, apiKey: "do-not-store" } as ConnectionProfile)).toEqual(schemaProfile);
  });
  it("preserves old JSON requests and excludes an unnecessary schema in JSON mode", async () => {
    await runIntelligenceAnalysis({ ...profile, outputMode: "json" }, "JSON: synthetic", undefined, requestId, { type: "object", unused: true });
    expect(ipc.mock.calls[0][1]).not.toHaveProperty("responseSchema");
    expect(() => validateConnectionProfile({ ...profile, outputMode: "automatic-fallback" } as unknown as ConnectionProfile)).toThrow("формат ответа");
  });
  it.each(["stop", null] as const)("retains observed diagnostics and provider counters without inventing context settings for completion %s", async (completionReason) => {
    const diagnostics: IntelligenceAnalysisDiagnostics = { protocol: "ollama", outputMode: "json", completionReason, promptBytes: 15, schemaBytes: null, requestBodyBytes: 500, sentTemperature: 0 };
    const response: IntelligenceAnalysisResult = { text: '{"items":[]}', model: "qwen", metrics: { elapsedMilliseconds: 100, inputTokens: 12, outputTokens: 8, totalTokens: 20 }, diagnostics };
    ipc.mockResolvedValue(response);
    const received = await runIntelligenceAnalysis(profile, "JSON: synthetic", "session-key", requestId);
    expect(received).toBe(response); expect(received.diagnostics).toEqual(diagnostics); expect(received.metrics).toEqual(response.metrics);
    expect(received.diagnostics).not.toHaveProperty("numCtx"); expect(received.diagnostics).not.toHaveProperty("effectiveContextTokens"); expect(received.diagnostics).not.toHaveProperty("maxOutputTokens");
    expect(ipc).toHaveBeenCalledWith("run_intelligence_analysis", { profile, prompt: "JSON: synthetic", apiKey: "session-key", requestId });
  });
  it("keeps legacy analysis replies without diagnostics or metrics compatible", async () => {
    const legacy: IntelligenceAnalysisResult = { text: '{"items":[]}', model: "qwen" };
    ipc.mockResolvedValue(legacy);
    expect(await runIntelligenceAnalysis(profile, "JSON: synthetic", undefined, requestId)).toBe(legacy);
    expect(legacy).not.toHaveProperty("diagnostics"); expect(legacy).not.toHaveProperty("metrics");
  });
  it("requires a bounded serializable object schema before starting transport", async () => {
    const schemaProfile = { ...profile, outputMode: "schema" as const };
    await expect(runIntelligenceAnalysis(schemaProfile, "JSON: test", undefined, requestId)).rejects.toThrow("JSON-схема");
    await expect(runIntelligenceAnalysis(schemaProfile, "JSON: test", undefined, requestId, { type: "array" })).rejects.toThrow("JSON-схема");
    await expect(runIntelligenceAnalysis(schemaProfile, "JSON: test", undefined, requestId, { type: "object", description: "я".repeat(intelligenceSchemaLimitBytes) })).rejects.toThrow("64 КБ");
    const cycle: Record<string, unknown> = { type: "object" }; cycle.self = cycle;
    await expect(runIntelligenceAnalysis(schemaProfile, "JSON: test", undefined, requestId, cycle)).rejects.toThrow("подготовить JSON-схему");
    expect(ipc).not.toHaveBeenCalled();
  });
});
