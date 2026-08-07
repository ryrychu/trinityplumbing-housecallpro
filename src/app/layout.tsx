import type { Metadata } from "next";
import { Inter, Barlow_Condensed } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

// Inter is the shared typeface across both Trinity sites (docs/color-scheme.md).
// It stays the UI and body face here, and — per the chart rules — the face for
// every headline figure too. A display face on a hero number reads as
// decoration; the number is data.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

// Display face, used ONLY for section headers and the wordmark. Barlow's
// drawing comes out of American highway and rolling-stock signage, which is
// the vernacular this particular product lives in: every screen here is about
// driving somewhere out of Averill Park. It also earns its place functionally
// — condensed is what lets a section header set at 22px stay on one line on a
// 360px phone, which is the width this design is drawn for first.
const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
  display: "swap",
});

// Geist Mono is retained for figures that align vertically — the run sheet's
// time rail, dial ring ticks, table columns. Deliberately NOT used for
// standalone headline numbers: equal-width digits make a lone "121" look
// gappy at display sizes.
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Trinity Plumbing — Operations",
  description: "Operations dashboard for Trinity Plumbing & Drains.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${barlowCondensed.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
