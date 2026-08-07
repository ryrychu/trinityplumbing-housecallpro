"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

// Where each screen was scrolled to, so returning to a tab returns to the place
// in it you were reading — the behaviour a native tab bar has and the one the
// window scroll gave for free before the app grew its own scroll container.
const positions = new Map<string, number>();

/**
 * The scrolling half of the app shell: this scrolls, the tab bar does not.
 *
 * The tab bar used to be `sticky bottom-0`, which did nothing. globals.css sets
 * `overflow-x: hidden` on html and body, and per spec that makes the other axis
 * compute to `auto` — so body became the scroll container, the bar's sticky
 * range collapsed to zero, and on a long screen like 37 open estimates it sat
 * at the end of the list where you had to scroll the whole way down to reach
 * it. Sticky could not be fixed without removing that overflow rule, which is
 * load-bearing elsewhere.
 *
 * Owning the scroll here sidesteps it: the bar is a plain flex sibling that is
 * never scrolled at all, so it cannot be scrolled away from.
 */
export function AppScrollArea({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";
  const ref = useRef<HTMLDivElement>(null);
  // The screen the current scroll offsets belong to. Read by the scroll
  // handler, which must attribute an offset to the screen being left, not the
  // one being arrived at.
  const owner = useRef(pathname);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    owner.current = pathname;
    el.scrollTop = positions.get(pathname) ?? 0;
  }, [pathname]);

  return (
    <div
      ref={ref}
      onScroll={(e) => positions.set(owner.current, e.currentTarget.scrollTop)}
      // min-h-0 is load-bearing on a flex child: without it the child's
      // automatic minimum size is its content, so it grows to fit the list
      // instead of scrolling, and pushes the tab bar back off screen — the
      // exact bug this component exists to fix.
      //
      // overscroll-contain stops the rubber-band at the ends of a list from
      // dragging the page behind it, which in an installed PWA looks like the
      // app coming loose from the screen.
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2"
    >
      {children}
    </div>
  );
}

/** Tests only — module state survives between cases in a file otherwise. */
export function clearScrollPositions(): void {
  positions.clear();
}
