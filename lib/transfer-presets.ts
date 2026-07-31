export const TRANSFER_PRESETS = {
  robust: {
    label: "Robust",
    description: "One code · strongest correction",
    blockSize: 240,
    fps: 5,
    lanes: 1,
    ecc: "H" as const,
  },
  balanced: {
    label: "Balanced",
    description: "One dense code · steady cameras",
    blockSize: 440,
    fps: 9,
    lanes: 1,
    ecc: "Q" as const,
  },
  turbo: {
    label: "Turbo",
    description: "Four parallel codes · maximum rate",
    blockSize: 320,
    fps: 12,
    lanes: 4,
    ecc: "M" as const,
  },
};

export type TransferPresetKey = keyof typeof TRANSFER_PRESETS;
