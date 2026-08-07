"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { recordNavigation } from "./navigationHistory";

/**
 * Counts in-app screen changes so BackLink knows whether there is anything
 * behind the current screen. Mounted once in the app layout; renders nothing.
 *
 * The first pathname is deliberately not counted — it is the screen the reader
 * arrived on, not a move they made.
 */
export function NavigationTracker() {
  const pathname = usePathname();
  const isFirst = useRef(true);

  useEffect(() => {
    if (isFirst.current) {
      isFirst.current = false;
      return;
    }
    recordNavigation();
  }, [pathname]);

  return null;
}
