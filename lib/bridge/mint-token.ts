import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { hashBridgeToken } from "@/lib/claude-usage/bridge-auth";

/** Shape of a freshly-minted bridge token, or a ready-to-return error. */
export type MintResult =
  | { ok: true; token: string; userId: string }
  | { ok: false; status: number; message: string };

/** A bridge token is `cub_` + 24 random bytes as hex (48 hex chars). */
export const BRIDGE_TOKEN_RE = /^cub_[0-9a-f]{48}$/;

/** Keep at most this many live tokens per user; prune oldest beyond it. */
const MAX_TOKENS_PER_USER = 10;

/**
 * CSRF guard for the state-changing mint routes (download + mac-command).
 *
 * Both are GET handlers authenticated solely by the Supabase session cookie
 * (SameSite=Lax by default), so a cross-site page could otherwise force a
 * top-level GET navigation that mints (and, at the cap, prunes) the member's
 * tokens — re-introducing the very 401 the multi-token fix prevents. Fetch
 * Metadata (`Sec-Fetch-Site`) distinguishes a real same-origin click/fetch from
 * a cross-site forced navigation; we reject the latter. Absent (very old
 * browsers) falls through to the session check.
 */
function crossSiteBlocked(secFetchSite: string | null): boolean {
  if (!secFetchSite) return false; // no Fetch Metadata → trust the session
  return secFetchSite !== "same-origin" && secFetchSite !== "same-site" && secFetchSite !== "none";
}

/**
 * Mint + persist a fresh per-user bridge token for the signed-in member.
 *
 * Inserts a NEW row (multiple tokens per user are allowed since the
 * bridge_tokens_multi migration), so re-downloading the ZIP or generating a Mac
 * command does NOT invalidate a sharer that's already running an earlier token.
 * To bound growth we then prune the user's oldest tokens beyond
 * MAX_TOKENS_PER_USER — always preserving the row we just inserted (so a
 * concurrent same-millisecond mint can never prune the token we're about to
 * hand back). Shared by the Windows ZIP download and the macOS copy-paste
 * command so both mint tokens identically.
 */
export async function mintBridgeToken(): Promise<MintResult> {
  if (!isAdminConfigured()) {
    return { ok: false, status: 503, message: "Sharing isn't configured on the server yet." };
  }

  if (crossSiteBlocked((await headers()).get("sec-fetch-site"))) {
    return { ok: false, status: 403, message: "Cross-site request blocked." };
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, message: "Please sign in first." };

  const token = `cub_${randomBytes(24).toString("hex")}`;
  const admin = createSupabaseAdminClient();
  const { data: inserted, error } = await admin
    .from("bridge_tokens")
    .insert({
      user_id: user.id,
      token_hash: hashBridgeToken(token),
      created_at: new Date().toISOString(),
      last_used_at: null,
    })
    .select("id")
    .single();
  if (error || !inserted) {
    return { ok: false, status: 500, message: "Could not prepare your sharer. Try again." };
  }
  const newId = inserted.id;

  // Prune the user's oldest tokens beyond the cap (best-effort; don't fail the
  // mint if pruning hiccups). Exclude the just-inserted id so a concurrent
  // same-millisecond mint can never delete the token we return.
  const { data: rows } = await admin
    .from("bridge_tokens")
    .select("id")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (rows && rows.length > MAX_TOKENS_PER_USER) {
    const stale = rows.slice(MAX_TOKENS_PER_USER).map((r) => r.id).filter((id) => id !== newId);
    if (stale.length) await admin.from("bridge_tokens").delete().in("id", stale);
  }

  return { ok: true, token, userId: user.id };
}

