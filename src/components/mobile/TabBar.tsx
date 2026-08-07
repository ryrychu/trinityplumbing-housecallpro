"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Drawn rather than typed. The tabs used to be emoji, which meant the icon set
// was whatever the OS shipped, could not take the brand colour, and faked its
// inactive state with `grayscale` — a filter, not a design. These are one
// stroke weight, one grid, and they inherit currentColor like everything else.
const ICONS: Record<string, React.ReactNode> = {
  today: (
    <>
      <path d="M9.25 4.5h5.5a1.5 1.5 0 0 1 0 3h-5.5a1.5 1.5 0 0 1 0-3Z" />
      <path d="M7.9 6H6.5a2 2 0 0 0-2 2v10.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-1.4" />
      <path d="M8.5 11.5h7M8.5 15h4.5" />
    </>
  ),
  schedule: (
    <>
      <rect x="3.75" y="5.5" width="16.5" height="15" rx="2.5" />
      <path d="M3.75 10.25h16.5M8.25 3.5v4M15.75 3.5v4" />
    </>
  ),
  customers: (
    <>
      <circle cx="12" cy="8.25" r="3.5" />
      <path d="M5.25 20.5c0-3.5 3-6 6.75-6s6.75 2.5 6.75 6" />
    </>
  ),
  money: (
    <>
      <rect x="2.75" y="6" width="18.5" height="12" rx="2.5" />
      <circle cx="12" cy="12" r="2.75" />
      <path d="M6.25 9.75v4.5M17.75 9.75v4.5" />
    </>
  ),
  dispatch: (
    <>
      <path d="M12 20.75s6.75-5.5 6.75-10.75a6.75 6.75 0 1 0-13.5 0C5.25 15.25 12 20.75 12 20.75Z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
};

const TABS = [
  { href: "/app/today", label: "Today", icon: "today", owns: ["/app/today", "/app/jobs"] },
  { href: "/app/schedule", label: "Schedule", icon: "schedule", owns: ["/app/schedule"] },
  { href: "/app/customers", label: "Customers", icon: "customers", owns: ["/app/customers"] },
  { href: "/app/money", label: "Money", icon: "money", owns: ["/app/money"] },
  { href: "/app/dispatch", label: "Dispatch", icon: "dispatch", owns: ["/app/dispatch"] },
];

// The login screen lives under /app/ too, so it inherits the layout that
// renders this bar -- and a signed-out visitor was being shown five tabs that
// all bounce straight back to the login they are already looking at. Nothing
// leaked: these are static labels in the client bundle and middleware turns
// every one of them away. It just made the sign-in screen look like the app,
// on the one screen with nowhere to go.
//
// Hidden here rather than by lifting the tabs into a route-group layout that
// excludes login, because login needs the REST of that layout: the viewport
// block sets maximumScale 1, and without it iOS zooms the whole page the
// moment someone focuses the email field.
const CHROMELESS = ["/app/login"];

export function TabBar() {
  const pathname = usePathname() ?? "";

  if (CHROMELESS.includes(pathname)) return null;

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
            className={`relative flex min-h-[52px] flex-1 flex-col items-center justify-center gap-1 py-1.5 text-[10px] font-medium tracking-wide ${
              active ? "text-brand" : "text-ink-faint"
            }`}
          >
            {/* The gold rule is the state; colour alone would be the only cue
                on a bar where every label is the same size. */}
            {active && <span aria-hidden className="absolute inset-x-3 top-0 h-0.5 bg-brand" />}
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              {ICONS[tab.icon]}
            </svg>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
