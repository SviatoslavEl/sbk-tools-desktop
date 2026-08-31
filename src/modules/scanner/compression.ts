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
  maximum: { targetRatio: .12, dpi: 96, quality: 35 },
};

export const compressionProfile = (mode: CompressionMode): CompressionProfile => profiles[mode];
