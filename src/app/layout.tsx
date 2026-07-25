import type { Metadata } from "next";
import { Inter } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

// Inter is the shared typeface across both Trinity sites (docs/color-scheme.md).
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

// Geist Mono is retained for tabular values (metric figures, times, distances).
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
      <body className={`${inter.variable} ${geistMono.variable}`}>
        {children}
      </body>
    </html>
  );
}
