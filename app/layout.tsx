import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Providers } from "./providers";
import { Analytics } from '@vercel/analytics/next';


export const metadata: Metadata = {
  title: {
    default: "DuitSini",
    template: "%s · DuitSini",
  },
  description:
    "Your day-to-day financing platform — subscription tracking, live AI usage across every provider, and stocks analysis. All in Ringgit.",
  applicationName: "DuitSini",
  // Google Search Console ownership verification. Set the
  // GOOGLE_SITE_VERIFICATION env var (Vercel → Production) to the token from
  // Search Console's "HTML tag" method; Next renders the matching meta tag.
  // Omitted (no tag rendered) when the env var is unset.
  verification: {
    google: process.env.GOOGLE_SITE_VERIFICATION || undefined,
  },
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0b12" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <Providers>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
