"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    // Registration failing is not an error worth surfacing — the app works
    // without it, just without offline reads.
    navigator.serviceWorker.register("/sw.js", { scope: "/app/" }).catch(() => {});
  }, []);

  return null;
}
