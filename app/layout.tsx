import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Providers } from "./providers";
import { Analytics } from '@vercel/analytics/next';


// metadataBase + canonical keep Open Graph / canonical URLs consistent, which
// the brand-verification check also cross-references.
export const metadata: Metadata = {
  metadataBase: new URL("https://duitsini.vercel.app"),
  title: {
    default: "DuitSini",
    template: "%s · DuitSini",
  },
  // Leads with the app name so meta-description scrapers see the brand too —
  // Google's name-match check weights more than just <title>.
  description:
    "DuitSini — your day-to-day financing platform. Track recurring bills and subscriptions, watch live AI usage across providers, and follow the market, all in Ringgit (MYR).",
  applicationName: "DuitSini",
  alternates: { canonical: "/" },
  openGraph: {
    siteName: "DuitSini",
    title: "DuitSini",
    type: "website",
    url: "/",
  },
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

// WebSite JSON-LD — a corroborating brand-identity signal for Google's
// name-match / homepage-purpose check (on top of the visible wordmark).
const websiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "DuitSini",
  url: "https://duitsini.vercel.app/",
  description:
    "DuitSini is a personal-finance dashboard that tracks recurring bills and subscriptions, live AI usage, and stocks — all in Ringgit (MYR).",
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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteJsonLd) }}
        />
        <Providers>{children}</Providers>
        <Analytics />
      </body>
    </html>
  );
}
