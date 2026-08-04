import type { Metadata } from "next";
import { AppHeader } from "../app-header";
import { ScannerClient } from "./scanner-client";
import { SiteFooter } from "../site-footer";

export const metadata: Metadata = {
  title: "Scan a transfer · Airgap",
  description: "Receive a loss-tolerant animated QR file transfer with your camera.",
};

export default function ScanPage() {
  return (
    <>
      <AppHeader active="scan" />
      <ScannerClient />
      <SiteFooter />
    </>
  );
}
