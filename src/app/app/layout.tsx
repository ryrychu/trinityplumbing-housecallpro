import type { Metadata, Viewport } from "next";
import { TabBar } from "@/components/mobile/TabBar";
import { ServiceWorkerRegistrar } from "@/components/mobile/ServiceWorkerRegistrar";
import { NavigationTracker } from "@/components/mobile/NavigationTracker";
import { AppScrollArea } from "@/components/mobile/AppScrollArea";

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
    // h-[100dvh], not min-h: the shell is exactly the viewport, and the screen
    // inside it scrolls. With min-h the shell grew with the content and took
    // the tab bar down the page with it. dvh rather than vh so the height
    // tracks iOS Safari's URL bar instead of sitting under it.
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-surface-page text-ink-primary">
      <AppScrollArea>{children}</AppScrollArea>
      <TabBar />
      {/* Counts screen changes so a detail screen's back control knows whether
          there is anything behind it. Renders nothing. */}
      <NavigationTracker />
      <ServiceWorkerRegistrar />
    </div>
  );
}
