import type { MetadataRoute } from "next";

const BASE = import.meta.env.BASE_URL ?? "/";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "QRFerry · Camera file transfer",
    short_name: "QRFerry",
    description:
      "Send and receive files as loss-tolerant animated QR streams.",
    start_url: `${BASE}scan/`,
    scope: BASE,
    display: "standalone",
    background_color: "#f4f1ea",
    theme_color: "#111820",
    orientation: "portrait",
    icons: [
      {
        src: `${BASE}favicon.svg`,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
