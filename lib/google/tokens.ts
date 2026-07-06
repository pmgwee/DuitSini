import { createSupabaseAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

/**
 * Google OAuth token management for YouTube read sync.
 *
 * Supabase hands us the Google `provider_token` / `provider_refresh_token`
 * exactly once, at the OAuth callback. We persist them in `google_tokens`
 * (service-role-only table) and refresh the access token ourselves against
 * Google's token endpoint — Supabase does not refresh provider tokens.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Refresh when less than this many ms of validity remain. */
const EXPIRY_BUFFER_MS = 60_000;

export interface ProviderTokens {
  accessToken: string | null;
  refreshToken: string;
  /** Seconds — Google access tokens live ~3600s; we assume 3300 when unknown. */
  expiresInSeconds?: number;
  scopes?: string | null;
}

/** Persist tokens captured at the OAuth callback. Silent no-op if admin env is missing. */
export async function saveGoogleTokens(userId: string, tokens: ProviderTokens): Promise<void> {
  if (!isAdminConfigured()) return;
  const admin = createSupabaseAdminClient();
  const expiresAt = new Date(
    Date.now() + (tokens.expiresInSeconds ?? 3300) * 1000,
  ).toISOString();
  const { error } = await admin.from("google_tokens").upsert({
    user_id: userId,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_at: tokens.accessToken ? expiresAt : null,
    scopes: tokens.scopes ?? null,
  });
  if (error) console.error("[google_tokens] save failed:", error.message);
}

/**
 * Returns a valid Google access token for the user, refreshing if needed.
 * `null` means the user hasn't connected Google with the YouTube scope (or
 * revoked access) — callers should surface a "reconnect" state, not an error.
 */
export async function getGoogleAccessToken(userId: string): Promise<string | null> {
  if (!isAdminConfigured()) return null;
  const admin = createSupabaseAdminClient();

  const { data: row, error } = await admin
    .from("google_tokens")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !row) return null;

  const stillValid =
    row.access_token &&
    row.expires_at &&
    new Date(row.expires_at).getTime() - Date.now() > EXPIRY_BUFFER_MS;
  if (stillValid) return row.access_token;

  return refreshAccessToken(userId, row.refresh_token);
}

async function refreshAccessToken(userId: string, refreshToken: string): Promise<string | null> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("[google_tokens] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set.");
    return null;
  }

  let resp: Response;
  try {
    resp = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      cache: "no-store",
    });
  } catch {
    return null;
  }

  const admin = createSupabaseAdminClient();

  if (!resp.ok) {
    // invalid_grant = user revoked access or token expired → drop the row so
    // the UI shows "reconnect" instead of failing forever.
    const body = (await resp.json().catch(() => null)) as { error?: string } | null;
    if (body?.error === "invalid_grant") {
      await admin.from("google_tokens").delete().eq("user_id", userId);
    }
    return null;
  }

  const json = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;

  await admin
    .from("google_tokens")
    .update({
      access_token: json.access_token,
      expires_at: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
    })
    .eq("user_id", userId);

  return json.access_token;
}
