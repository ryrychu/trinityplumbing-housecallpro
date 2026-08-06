"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const LOGIN_PATH = "/app/login";

export function ServiceWorkerRegistrar() {
  const pathname = usePathname();
  const registered = useRef(false);

  useEffect(() => {
    if (registered.current) return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    // middleware.ts 307s every signed-out /app/* request to /app/login, so
    // that's the page a first-time visitor's browser is actually sitting on.
    // sw.js's own redirect check is the real defence against precaching the
    // login page under the shell's keys (a previously-signed-in user's
    // browser can still trigger a background install while briefly on this
    // page) -- this is just cheap insurance that costs nothing to add.
    // Signing in is a client-side router.replace() (app/login/page.tsx), not
    // a reload, so this has to react to the pathname changing rather than
    // only checking once on mount, or a session that starts on login would
    // never register at all.
    if (pathname === LOGIN_PATH) return;

    // Registration failing is not an error worth surfacing — the app works
    // without it, just without offline reads.
    navigator.serviceWorker.register("/sw.js", { scope: "/app/" }).catch(() => {});
    registered.current = true;
  }, [pathname]);

  return null;
}
