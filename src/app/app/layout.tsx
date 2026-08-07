import type { Metadata, Viewport } from "next";
import { TabBar } from "@/components/mobile/TabBar";
import { ServiceWorkerRegistrar } from "@/components/mobile/ServiceWorkerRegistrar";
import { NavigationTracker } from "@/components/mobile/NavigationTracker";

export const metadata: Metadata = {
  title: "Trinity Ops",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Trinity Ops",
    // "black-translucent" would let content slide under the notch; the app is
    // a dark surface already, so plain black keeps the status bar legible.
    statusBarStyle: "black",
  },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#121212",
  // Required on iOS: without it the whole UI zooms when an input is focused,
  // and viewport-fit=cover is what makes safe-area insets available at all.
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-surface-page text-ink-primary">
      <div className="flex-1 pb-2">{children}</div>
      <TabBar />
      {/* Counts screen changes so a detail screen's back control knows whether
          there is anything behind it. Renders nothing. */}
      <NavigationTracker />
      <ServiceWorkerRegistrar />
    </div>
  );
}
