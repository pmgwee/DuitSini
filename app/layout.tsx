import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: {
    default: "Subscription Agent",
    template: "%s · Subscription Agent",
  },
  description:
    "Track subscriptions, free trials, and renewals with premium clarity — plus a calm personal dashboard.",
  applicationName: "Subscription Agent",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0b0b12",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html
      lang="en"
      className={`dark ${GeistSans.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
