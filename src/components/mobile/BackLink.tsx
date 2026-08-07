"use client";

import Link from "next/link";
import { canGoBack } from "./navigationHistory";

/**
 * The back control on a detail screen.
 *
 * It is a real link to `fallback`, not a button, and that is what makes it
 * correct in the case the old hardcoded `href="/app/today"` got wrong in the
 * other direction. Opened cold — a shared link, a notification, the installed
 * app launching onto a job — there is no history, and the link simply goes to
 * the tab that screen belongs to. Reached from inside the app, the click is
 * intercepted and history is walked back, so leaving a job returns to the
 * Schedule or Customers screen you actually came from instead of dumping you on
 * Today.
 *
 * history.back() rather than Next's router.back(): they do the same thing, but
 * the router version requires an App Router context to be mounted, which turned
 * every existing page test that renders a detail screen into a crash. A back
 * control should not be the reason a screen cannot be rendered on its own.
 */
export function BackLink({
  fallback,
  label = "Back",
}: {
  /** Where to go when nothing precedes this screen. */
  fallback: string;
  label?: string;
}) {
  return (
    <Link
      href={fallback}
      aria-label={label}
      onClick={(e) => {
        // No in-app history: let the anchor navigate to the fallback normally.
        if (!canGoBack()) return;
        e.preventDefault();
        window.history.back();
      }}
      className="-ml-1 flex h-11 w-9 shrink-0 items-center justify-center text-ink-muted transition-colors hover:text-brand"
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-5 w-5"
      >
        <path d="M15 5l-7 7 7 7" />
      </svg>
    </Link>
  );
}
