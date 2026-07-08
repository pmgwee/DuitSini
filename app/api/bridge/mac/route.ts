import { type NextRequest } from "next/server";
import { buildMemberBridge } from "@/lib/bridge/member-bridge-template";
import { BRIDGE_TOKEN_RE } from "@/lib/bridge/mint-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET — serve the personalized `claude-usage-sharer.mjs` as plain text so a
 * macOS (or any) user can run it with a copy-paste command:
 *
 *   curl -fsSL ".../api/bridge/mac?token=cub_..." -o claude-usage-sharer.mjs \
 *     && node claude-usage-sharer.mjs
 *
 * Why a command instead of a double-click file: files downloaded by a browser
 * and unzipped by Finder inherit macOS's `com.apple.quarantine` flag, so a
 * `.command` launcher is blocked by Gatekeeper (and Sequoia/Tahoe removed the
 * right-click→Open bypass). Files fetched with `curl` are NOT quarantined and a
 * command the user types themselves runs with no Gatekeeper prompt — the same
 * pattern Homebrew/nvm/Bun use.
 *
 * The `token` in the URL is the member's credential and is baked verbatim into
 * the returned script, so we validate its exact format first: this both rejects
 * junk and closes any code-injection vector (a crafted token can't break out of
 * the script's string literal). The token must already be registered — minted
 * by /api/bridge/mac-command while signed in — or the script's pushes are
 * rejected by the ingest/pull endpoints.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!BRIDGE_TOKEN_RE.test(token)) {
    return new Response(
      '// This link is invalid or expired.\n// Open your dashboard and get a fresh "Mac command".\n',
      { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  const base = (process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin).replace(/\/+$/, "");
  const bridge = buildMemberBridge({
    ingestUrl: `${base}/api/claude-usage/ingest`,
    pullUrl: `${base}/api/claude-usage/pull`,
    token,
  });

  return new Response(bridge, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'inline; filename="claude-usage-sharer.mjs"',
      "Cache-Control": "no-store",
    },
  });
}
