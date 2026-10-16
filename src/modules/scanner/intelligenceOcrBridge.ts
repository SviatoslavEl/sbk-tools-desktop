export interface IntelligenceOcrRequest { id: string; inputPath: string }
export interface IntelligenceOcrReturn { id: string; outputPath: string; sha256: string }
export interface IntelligenceOcrSource { inputPath: string; sourceGeneration: number; sourceFingerprint?: string }
export interface IntelligenceOcrSaveTicket extends IntelligenceOcrSource { id: string; epoch: number }
export interface IntelligenceOcrSaveFacts {
  workspaceMode: "document" | "merge";
  kind: string;
  outputPageMode: string;
  pageCount: number;
  pageOrder: readonly number[];
  ocrEnabled: boolean;
  settingsKey: string;
  outputPath: string;
  outputSha256: string;
  outputRevision: string;
  ocrText: string;
}
export interface IntelligenceOcrCurrent {
  workspaceMode: "document" | "merge";
  resultKind: string;
  resultPath: string;
  settingsKey: string;
  ocrEnabled: boolean;
}

function validRequest(value: IntelligenceOcrRequest | undefined): value is IntelligenceOcrRequest {
  return !!value && typeof value.id === "string" && !!value.id.trim() && value.id.length <= 200
    && typeof value.inputPath === "string" && !!value.inputPath.trim() && value.inputPath.length <= 32_768
    && !value.inputPath.includes("\0") && /\.(?:pdf|docx)$/iu.test(value.inputPath);
}
function sameSource(left: IntelligenceOcrSource, right: IntelligenceOcrSource) {
  return left.inputPath === right.inputPath && left.sourceGeneration === right.sourceGeneration
    && !!left.sourceFingerprint && left.sourceFingerprint === right.sourceFingerprint;
}
export function isIntelligenceOcrSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}

/** RAM-only provenance gate. It does not establish OCR accuracy or write records. */
export class IntelligenceOcrBridge {
  private epoch = 0;
  private binding: (IntelligenceOcrSource & { id: string }) | null = null;
  private result: { ticket: IntelligenceOcrSaveTicket; outputPath: string; outputRevision: string; sha256: string; settingsKey: string } | null = null;

  invalidate() { this.binding = null; this.clearResult(); }
  clearResult() { this.epoch += 1; this.result = null; }
  bind(request: IntelligenceOcrRequest, source: IntelligenceOcrSource): boolean {
    this.invalidate();
    if (!validRequest(request) || request.inputPath !== source.inputPath || !source.sourceFingerprint
      || !Number.isSafeInteger(source.sourceGeneration) || source.sourceGeneration < 0) return false;
    this.binding = { ...source, id: request.id };
    return true;
  }
  isBound(request: IntelligenceOcrRequest | undefined, source: IntelligenceOcrSource): boolean {
    return validRequest(request) && !!this.binding && request.id === this.binding.id
      && request.inputPath === this.binding.inputPath && sameSource(this.binding, source);
  }
  startSave(request: IntelligenceOcrRequest | undefined, source: IntelligenceOcrSource): IntelligenceOcrSaveTicket | null {
    this.clearResult();
    return this.isBound(request, source) ? { ...source, id: request!.id, epoch: this.epoch } : null;
  }
  completeSave(ticket: IntelligenceOcrSaveTicket | null, request: IntelligenceOcrRequest | undefined, source: IntelligenceOcrSource, facts: IntelligenceOcrSaveFacts): boolean {
    if (!ticket || ticket.epoch !== this.epoch || !this.isBound(request, source) || ticket.id !== request!.id
      || !sameSource(ticket, source) || facts.workspaceMode !== "document" || facts.kind !== "single"
      || facts.outputPageMode !== "all" || !facts.ocrEnabled || !facts.ocrText.trim() || !facts.settingsKey
      || !Number.isSafeInteger(facts.pageCount) || facts.pageCount < 1 || facts.pageCount > 5000
      || facts.pageOrder.length !== facts.pageCount || facts.pageOrder.some((page, index) => page !== index)
      || !isIntelligenceOcrSha256(facts.outputSha256) || !facts.outputRevision || !facts.outputPath.trim() || facts.outputPath.includes("\0") || facts.outputPath.length > 32_768
      || !/\.pdf$/iu.test(facts.outputPath) || facts.outputPath === source.inputPath) return false;
    this.result = { ticket: { ...ticket }, outputPath: facts.outputPath, outputRevision: facts.outputRevision, sha256: facts.outputSha256, settingsKey: facts.settingsKey };
    return true;
  }
  candidate(request: IntelligenceOcrRequest | undefined, source: IntelligenceOcrSource, current: IntelligenceOcrCurrent): (IntelligenceOcrReturn & { outputRevision: string }) | null {
    const result = this.result;
    return result && result.ticket.epoch === this.epoch && this.isBound(request, source)
      && result.ticket.id === request!.id && sameSource(result.ticket, source)
      && current.workspaceMode === "document" && current.resultKind === "single" && current.ocrEnabled
      && current.resultPath === result.outputPath && current.settingsKey === result.settingsKey
      ? { id: result.ticket.id, outputPath: result.outputPath, outputRevision: result.outputRevision, sha256: result.sha256 } : null;
  }
  consume(request: IntelligenceOcrRequest | undefined, source: IntelligenceOcrSource, current: IntelligenceOcrCurrent): IntelligenceOcrReturn | null {
    const result = this.candidate(request, source, current);
    if (result) this.clearResult();
    return result;
  }
}

/** Cross-tool routing is scoped to one live workspace context and request. */
export class IntelligenceOcrRouter {
  private root = "";
  private paused = true;
  private requestValue: IntelligenceOcrRequest | undefined;
  private returnValue: IntelligenceOcrReturn | undefined;
  updateContext(root: string, paused: boolean) {
    if (root !== this.root || paused) { this.requestValue = undefined; this.returnValue = undefined; }
    this.root = root; this.paused = paused;
  }
  get request() { return this.requestValue ? { ...this.requestValue } : undefined; }
  get result() { return this.returnValue ? { ...this.returnValue } : undefined; }
  begin(request: IntelligenceOcrRequest) {
    if (!this.root || this.paused || !validRequest(request)) throw new Error("Подключите рабочую папку и выберите доступный PDF или DOCX для OCR.");
    this.requestValue = { ...request }; this.returnValue = undefined;
  }
  finish(result: IntelligenceOcrReturn) {
    if (!this.root || this.paused || !this.requestValue || result.id !== this.requestValue.id
      || !isIntelligenceOcrSha256(result.sha256)
      || !result.outputPath.trim() || result.outputPath.length > 32_768 || result.outputPath.includes("\0")
      || !/\.pdf$/iu.test(result.outputPath) || result.outputPath === this.requestValue.inputPath)
      throw new Error("Запрос OCR уже изменился или доступ к файлам приостановлен. Вернитесь в окно ИИ и повторите действие.");
    this.returnValue = { ...result }; this.requestValue = undefined;
  }
  consume() { this.requestValue = undefined; this.returnValue = undefined; }
}
