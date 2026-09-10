import { useState } from "react";

export type ScannerWorkspaceMode = "document" | "merge";
export interface ScannerProgress { stage: string; currentPage: number; totalPages: number; percent: number }
export interface ScannerOperationUi {
  resultPath: string;
  resultKind: "single" | "batch" | "split" | "";
  progress: ScannerProgress | null;
  error: string;
  warnings: string[];
}
export type ScannerOperationStates = Record<ScannerWorkspaceMode, ScannerOperationUi>;

export function emptyScannerOperationStates(): ScannerOperationStates {
  const empty = (): ScannerOperationUi => ({ resultPath: "", resultKind: "", progress: null, error: "", warnings: [] });
  return { document: empty(), merge: empty() };
}

export function updateScannerOperationState(states: ScannerOperationStates, mode: ScannerWorkspaceMode, patch: Partial<ScannerOperationUi>): ScannerOperationStates {
  return { ...states, [mode]: { ...states[mode], ...patch } };
}

// Only operation feedback is scoped by mode. The open document, effects and page
// arrangement remain in Scanner and are not reset when switching workspaces.
export function useScannerOperationUi(mode: ScannerWorkspaceMode) {
  const [states, setStates] = useState(emptyScannerOperationStates);
  const update = (patch: Partial<ScannerOperationUi>, owner: ScannerWorkspaceMode = mode) => {
    setStates((current) => updateScannerOperationState(current, owner, patch));
  };
  return {
    ...states[mode],
    setResultPath: (resultPath: string, owner: ScannerWorkspaceMode = mode) => update({ resultPath }, owner),
    setResultKind: (resultKind: ScannerOperationUi["resultKind"], owner: ScannerWorkspaceMode = mode) => update({ resultKind }, owner),
    setProgress: (progress: ScannerProgress | null, owner: ScannerWorkspaceMode = mode) => update({ progress }, owner),
    setError: (error: string, owner: ScannerWorkspaceMode = mode) => update({ error }, owner),
    setWarnings: (warnings: string[], owner: ScannerWorkspaceMode = mode) => update({ warnings }, owner),
  };
}

export function belongsToScannerResult(
  failure: { mode: ScannerWorkspaceMode; path: string } | null,
  mode: ScannerWorkspaceMode,
  resultPath: string,
): boolean {
  return !!resultPath && failure?.mode === mode && failure.path === resultPath;
}
