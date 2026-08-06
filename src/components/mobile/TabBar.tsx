"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/app/today", label: "Today", icon: "📋", owns: ["/app/today", "/app/jobs"] },
  { href: "/app/schedule", label: "Schedule", icon: "📅", owns: ["/app/schedule"] },
  { href: "/app/customers", label: "Customers", icon: "👤", owns: ["/app/customers"] },
  { href: "/app/money", label: "Money", icon: "💵", owns: ["/app/money"] },
  { href: "/app/dispatch", label: "Dispatch", icon: "📍", owns: ["/app/dispatch"] },
];

export function TabBar() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      // pb-[env(safe-area-inset-bottom)] keeps the tabs above the iPhone home
      // indicator; without it the bottom row is half-swallowed on every modern
      // iPhone. It only resolves because layout.tsx sets viewportFit: "cover".
      className="sticky bottom-0 z-10 flex border-t border-surface-divider bg-surface-raised pb-[env(safe-area-inset-bottom)]"
    >
      {TABS.map((tab) => {
        // A plain startsWith(p) would light Customers for "/app/customers-archive"
        // too — the prefix matches without a path boundary. Require an exact
        // match or a "/" right after the prefix so sibling routes don't bleed
        // into each other's tab.
        const active = tab.owns.some((p) => p === pathname || pathname.startsWith(`${p}/`));
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-[44px] flex-1 flex-col items-center justify-center py-1.5 text-[10px] ${
              active ? "text-brand" : "text-ink-faint"
            }`}
          >
            <span aria-hidden className={`text-lg ${active ? "" : "opacity-60 grayscale"}`}>
              {tab.icon}
            </span>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
