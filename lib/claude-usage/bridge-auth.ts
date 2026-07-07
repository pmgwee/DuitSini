import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time check of a bearer secret against CLAUDE_BRIDGE_SECRET. Used by
 * the bridge-facing endpoints (ingest, pull) which authenticate the local
 * companion by a shared secret rather than a user session.
 */
export function bridgeSecretAuthorized(header: string | null): boolean {
  const secret = process.env.CLAUDE_BRIDGE_SECRET;
  if (!secret || !header) return false;
  const provided = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
