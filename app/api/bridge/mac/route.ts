import { type NextRequest } from "next/server";
import { buildMemberBridge } from "@/lib/bridge/member-bridge-template";
import { BRIDGE_TOKEN_RE } from "@/lib/bridge/mint-token";
import { hashBridgeToken } from "@/lib/claude-usage/bridge-auth";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

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
 * the script's string literal).
 *
 * IDENTITY: the token decides which dashboard account every push lands on —
 * NOT whoever is signed in on the browser that runs the curl. A command copied
 * from another member therefore broadcasts to THAT member's account (this
 * actually happened). So we also resolve the token against `bridge_tokens` at
 * serve time: an unregistered/revoked token gets a 410 (curl -f fails cleanly,
 * no script written), and a valid one gets its owner's email baked into the
 * startup banner so the runner can see at a glance whose dashboard they feed.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  if (!BRIDGE_TOKEN_RE.test(token)) {
    return new Response(
      '// This link is invalid or expired.\n// Open your dashboard and get a fresh "Mac command".\n',
      { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  // Resolve the token's owner (email for the banner). Skipped gracefully on a
  // self-hosted copy without service-role creds — the banner line hides itself.
  let accountEmail = "";
  if (isAdminConfigured()) {
    try {
      const admin = createSupabaseAdminClient();
      const { data: row } = await admin
        .from("bridge_tokens")
        .select("user_id")
        .eq("token_hash", hashBridgeToken(token))
        .maybeSingle();
      if (!row?.user_id) {
        return new Response(
          "// This link is not active anymore (the token was revoked or replaced).\n" +
            '// Sign in to the dashboard with YOUR Google account and copy a fresh "Mac command" there.\n',
          { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8" } },
        );
      }
      const { data: userRes } = await admin.auth.admin.getUserById(row.user_id);
      accountEmail = userRes?.user?.email ?? "";
    } catch {
      // Lookup hiccup: still serve the script (the ingest route re-checks the
      // token on every push anyway); only the banner email is lost.
    }
  }

  const base = (process.env.NEXT_PUBLIC_APP_URL || req.nextUrl.origin).replace(/\/+$/, "");
  const bridge = buildMemberBridge({
    ingestUrl: `${base}/api/claude-usage/ingest`,
    pullUrl: `${base}/api/claude-usage/pull`,
    token,
    accountEmail,
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
