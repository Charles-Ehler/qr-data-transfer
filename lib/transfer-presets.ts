import { createQRTransferProfile } from "@raptorqr/core/protocol/profiles";
import { OPTICAL_FRAME_OVERHEAD } from "@/lib/optical-transfer";

function makePreset<
  const T extends {
    label: string;
    description: string;
    version: number;
    ecc: "L" | "M" | "Q" | "H";
    fps: number;
    repairPercent: number;
    renderScale: number;
  },
>(value: T) {
  const qr = createQRTransferProfile(value.version, value.ecc);
  return {
    ...value,
    qrCapacity: qr.maxPacketSize,
    symbolSize: qr.maxPacketSize - OPTICAL_FRAME_OVERHEAD,
    usefulBytesPerFrame:
      qr.maxPacketSize - OPTICAL_FRAME_OVERHEAD - 4,
  };
}

export const TRANSFER_PRESETS = {
  robust: makePreset({
    label: "Robust",
    description: "V15-M · larger camera modules",
    version: 15,
    fps: 7,
    ecc: "M" as const,
    repairPercent: 35,
    renderScale: 7,
  }),
  balanced: makePreset({
    label: "Balanced",
    description: "V25-M · speed with 15% QR repair",
    version: 25,
    fps: 10,
    ecc: "M" as const,
    repairPercent: 30,
    renderScale: 6,
  }),
  turbo: makePreset({
    label: "Turbo",
    description: "Single V30-L · RaptorQ repairs drops",
    version: 30,
    fps: 15,
    ecc: "L" as const,
    repairPercent: 25,
    renderScale: 6,
  }),
};

export type TransferPresetKey = keyof typeof TRANSFER_PRESETS;
