import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { PwaRegister } from "./pwa-register";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host?.includes("localhost") ? "http" : "https");
  const metadataBase = new URL(host ? `${protocol}://${host}` : "https://qrferry.com");

  return {
    metadataBase,
    title: {
      default: "QRFerry · Files through the camera",
      template: "%s",
    },
    description:
      "A private, loss-tolerant animated QR file transfer that works directly between screens and cameras.",
    applicationName: "QRFerry",
    manifest: "/manifest.webmanifest",
    openGraph: {
      title: "QRFerry",
      description: "Files through the camera.",
      type: "website",
      images: [{ url: "/og.png", width: 1732, height: 908, alt: "QRFerry — files through the camera" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "QRFerry",
      description: "Files through the camera.",
      images: ["/og.png"],
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "QRFerry",
    },
    formatDetection: {
      telephone: false,
    },
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
      apple: "/favicon.svg",
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
