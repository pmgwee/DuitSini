import { createHash, timingSafeEqual } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

/**
 * Constant-time check of a bearer secret against CLAUDE_BRIDGE_SECRET (the
 * owner's legacy single-secret path).
 */
export function bridgeSecretAuthorized(header: string | null): boolean {
  const secret = process.env.CLAUDE_BRIDGE_SECRET;
  if (!secret || !header) return false;
  const provided = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function extractToken(header: string | null): string | null {
  if (!header) return null;
  const t = header.startsWith("Bearer ") ? header.slice(7) : header;
  return t.trim() || null;
}

/** SHA-256 hex of a bridge token — what we store/look up (never the plaintext). */
export function hashBridgeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Resolve which user a bridge request belongs to. Multi-tenant:
 *   1) Per-user bridge token → looked up (by hash) in `bridge_tokens`.
 *   2) Legacy shared CLAUDE_BRIDGE_SECRET → pinned CLAUDE_BRIDGE_USER_ID.
 * Returns the user_id, or null if unauthenticated.
 */
export async function resolveBridgeUserId(header: string | null): Promise<string | null> {
  const token = extractToken(header);
  if (!token) return null;

  // 1) Per-user token (group members).
  try {
    const admin = createSupabaseAdminClient();
    const tokenHash = hashBridgeToken(token);
    const { data } = await admin
      .from("bridge_tokens")
      .select("user_id")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (data?.user_id) {
      // Stamp last_used_at so "which token is pushing?" is answerable from the
      // DB (a misrouted-sharer incident had to be reconstructed from mint
      // timestamps because this was never written). Best-effort: a failed
      // stamp must never fail an otherwise-authenticated push.
      try {
        await admin
          .from("bridge_tokens")
          .update({ last_used_at: new Date().toISOString() })
          .eq("token_hash", tokenHash);
      } catch {
        // ignore — observability only
      }
      return data.user_id;
    }
  } catch {
    // fall through to the legacy path
  }

  // 2) Legacy shared secret → pinned user (the owner's existing bridge).
  if (bridgeSecretAuthorized(header) && process.env.CLAUDE_BRIDGE_USER_ID) {
    return process.env.CLAUDE_BRIDGE_USER_ID;
  }
  return null;
}
