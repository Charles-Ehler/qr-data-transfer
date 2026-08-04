import type { Metadata } from "next";
import { AppHeader } from "./app-header";
import { SendClient } from "./send-client";
import { SiteFooter } from "./site-footer";

export const metadata: Metadata = {
  title: "Send a file · Airgap",
  description:
    "Turn any file into a fast, repairable animated QR stream and receive it with a phone camera.",
};

export default function Home() {
  return (
    <>
      <AppHeader active="send" />
      <SendClient />
      <SiteFooter />
    </>
  );
}
