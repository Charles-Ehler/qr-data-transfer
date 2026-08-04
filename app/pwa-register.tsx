"use client";

import { useEffect } from "react";

const BASE = import.meta.env.BASE_URL ?? "/";

export function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }).catch(() => {
        // Offline support is optional; the transfer still works without it.
      });
    }
  }, []);
  return null;
}
