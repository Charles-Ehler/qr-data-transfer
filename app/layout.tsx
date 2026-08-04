import type { Metadata } from "next";
import "./globals.css";
import { PwaRegister } from "./pwa-register";

// Fonts are self-hosted in public/fonts via @font-face in globals.css, so the
// app makes zero third-party network requests and works fully offline.

// Deployment base path, injected at build time (QRF_BASE -> vite `base`).
// Keeps every asset reference correct on domain roots and subpaths alike.
const BASE = import.meta.env.BASE_URL ?? "/";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: {
      default: "Airgap · Files through the camera",
      template: "%s",
    },
    description:
      "A private, loss-tolerant animated QR file transfer that works directly between screens and cameras.",
    applicationName: "Airgap",
    manifest: `${BASE}manifest.webmanifest`,
    openGraph: {
      title: "Airgap",
      description: "Files through the camera.",
      type: "website",
      images: [{ url: `${BASE}og.png`, width: 1732, height: 908, alt: "Airgap — files through the camera" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Airgap",
      description: "Files through the camera.",
      images: [`${BASE}og.png`],
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "Airgap",
    },
    formatDetection: {
      telephone: false,
    },
    icons: {
      icon: `${BASE}favicon.svg`,
      shortcut: `${BASE}favicon.svg`,
      apple: `${BASE}favicon.svg`,
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="paper">
      <head>
        {/* Apply the saved theme before first paint to avoid a flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=new URLSearchParams(location.search).get("theme")||localStorage.getItem("airgap-theme");if(t==="paper"||t==="midnight"||t==="terminal"){document.documentElement.dataset.theme=t}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="antialiased">
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
