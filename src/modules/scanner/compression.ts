export type CompressionMode = "none" | "balanced" | "strong" | "maximum";

export interface CompressionProfile {
  targetRatio?: number;
  dpi?: number;
  quality?: number;
}

const profiles: Record<CompressionMode, CompressionProfile> = {
  none: {},
  balanced: { targetRatio: .7, dpi: 200, quality: 84 },
  strong: { targetRatio: .5, dpi: 150, quality: 72 },
  maximum: { targetRatio: .25, dpi: 120, quality: 55 },
};

export const compressionProfile = (mode: CompressionMode): CompressionProfile => profiles[mode];
