import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

/**
 * Per-user YouTube Music session-cookie storage (service-role only).
 *
 * Google removed OAuth from YouTube Music (Nov 2024), so the algorithmic
 * "Listen again" shelf can only be read by replaying an authenticated browser
 * session — the user's YT Music cookies. This is an OPT-IN feature: a user who
 * never connects has no row here and sees only the local recency shelf.
 *
 * SECURITY: these cookies grant full Google-account access — more sensitive
 * than the OAuth refresh tokens in `google_tokens`. Like that table, `ytm_cookies`
 * is RLS-enabled with NO policies, so it is invisible to every client except the
 * service role, and the cookie value never reaches the browser.
 */

/** Returns the stored cookie header, or null when the user hasn't connected. */
export async function getYTMusicCookie(userId: string): Promise<string | null> {
  if (!isAdminConfigured()) return null;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("ytm_cookies")
    .select("cookie_header")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data) return null;
  return data.cookie_header;
}

/** Insert or replace the stored cookie header (connect / re-capture). */
export async function saveYTMusicCookie(userId: string, cookieHeader: string): Promise<void> {
  if (!isAdminConfigured()) return;
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("ytm_cookies").upsert({
    user_id: userId,
    cookie_header: cookieHeader,
    last_ok_at: null,
  });
  if (error) console.error("[ytm_cookies] save failed:", error.message);
}

/** Drop the stored cookie (disconnect). */
export async function clearYTMusicCookie(userId: string): Promise<void> {
  if (!isAdminConfigured()) return;
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("ytm_cookies").delete().eq("user_id", userId);
  if (error) console.error("[ytm_cookies] clear failed:", error.message);
}

/**
 * Best-effort stamp that the cookies last produced a successful fetch, so the
 * UI can hint "may be stale / re-capture" when recommendations stop arriving.
 */
export async function markYTMusicCookieOk(userId: string): Promise<void> {
  if (!isAdminConfigured()) return;
  const admin = createSupabaseAdminClient();
  await admin
    .from("ytm_cookies")
    .update({ last_ok_at: new Date().toISOString() })
    .eq("user_id", userId);
}
