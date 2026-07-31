export const TRANSFER_PRESETS = {
  robust: {
    label: "Robust",
    description: "Start here · easiest to scan",
    blockSize: 180,
    fps: 3,
    ecc: "H" as const,
  },
  balanced: {
    label: "Balanced",
    description: "Faster after a clean test",
    blockSize: 300,
    fps: 5,
    ecc: "Q" as const,
  },
  turbo: {
    label: "Turbo",
    description: "Bright, steady setup",
    blockSize: 480,
    fps: 8,
    ecc: "M" as const,
  },
};

export type TransferPresetKey = keyof typeof TRANSFER_PRESETS;
