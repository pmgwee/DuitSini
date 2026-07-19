import type { NextConfig } from "next";

// Baseline security response headers applied to every route. A full CSP is a
// staged follow-up — Next's inline runtime needs nonce handling first.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Cross-origin isolation: cheap, safe side-channel / XS-leak hardening.
  // COEP is deliberately deferred until cross-origin assets are audited.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A stray package-lock.json in the user's home directory makes Next infer the
  // wrong workspace root. Pin file tracing to this project's directory.
  outputFileTracingRoot: process.cwd(),
  // @sparticuz/chromium-min resolves its binary by relative path at runtime —
  // if Next bundles it, that resolution breaks ("The input directory
  // /var/task/bin does not exist"). Load-bearing for the SERVERLESS branch of
  // lib/reports/pdf.ts (production/Vercel). The local-browser auto-detect
  // branch doesn't touch this package, but do NOT remove this entry or Vercel
  // prod breaks.
  serverExternalPackages: ["@sparticuz/chromium-min"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
  // The Dashboard surface was renamed to "AI Usage" in the DuitSini rebrand and
  // its route moved /dashboard → /ai-usage. Keep the old path alive permanently:
  // members have it bookmarked, and it was the landing page's secondary CTA.
  // Three surfaces were renamed in the DuitSini rebrand: Dashboard → AI Usage,
  // Serenity → Stocks, Subscriptions → Bills. All three old paths shipped to main
  // before the rename, so keep them alive permanently — members have them
  // bookmarked, and /subscriptions was the post-login landing page.
  async redirects() {
    return [
      { source: "/dashboard", destination: "/ai-usage", permanent: true },
      { source: "/dashboard/:path*", destination: "/ai-usage/:path*", permanent: true },
      { source: "/serenity", destination: "/stocks", permanent: true },
      { source: "/serenity/:path*", destination: "/stocks/:path*", permanent: true },
      { source: "/subscriptions", destination: "/bills", permanent: true },
      { source: "/subscriptions/:path*", destination: "/bills/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
