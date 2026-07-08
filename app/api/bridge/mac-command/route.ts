import { type NextRequest } from "next/server";
import { mintBridgeToken } from "@/lib/bridge/mint-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — mint a fresh bridge token for the signed-in member and return the
 * personalized macOS copy-paste command as JSON. Called on an explicit user
 * action (not page load) so it doesn't rotate a member's token — and thereby
 * break an already-running sharer — just by viewing the dashboard.
 */
export async function GET(req: NextRequest) {
  const res = await mintBridgeToken();
  if (!res.ok) {
    return Response.json({ error: res.message }, { status: res.status });
  }

  const base = (process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin).replace(/\/+$/, "");
  const url = `${base}/api/bridge/mac?token=${res.token}`;
  // Two-step so the script lands as a real `.mjs` file (ESM runs correctly, and
  // the member can inspect it) — `curl | node` would fail since Node reads stdin
  // as CommonJS while the sharer is an ES module.
  const command = `curl -fsSL "${url}" -o claude-usage-sharer.mjs && node claude-usage-sharer.mjs`;

  return Response.json({ command }, { headers: { "Cache-Control": "no-store" } });
}
