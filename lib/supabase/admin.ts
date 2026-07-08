import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

/**
 * Service-role Supabase client. SERVER ONLY — bypasses RLS, so it must never
 * be imported from client components. Used exclusively for tables that have
 * RLS enabled with no policies (e.g. `google_tokens`), which are invisible to
 * every other client.
 */
// Per-request deadline for PostgREST calls. A Supabase stall (project
// thawing/paused, connection-pool exhaustion, a load balancer holding the TCP
// socket open with no response) otherwise leaves the await neither resolving
// nor rejecting until the host platform kills the function — surfacing as an
// HTML 500 instead of a structured JSON error the bridge can retry on. 8s is
// well under Vercel's function max-duration, so the AbortController fires in
// time for the route to catch it and respond cleanly.
const DB_TIMEOUT_MS = 8_000;

export function createSupabaseAdminClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (server env).",
    );
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { timeout: DB_TIMEOUT_MS },
  });
}

/**
 * True when the service-role key is configured AND the URL is a valid http(s)
 * URL. Truthiness alone lets a malformed URL (e.g. a bare project ref with no
 * scheme) pass the guard and reach createClient, which throws mid-request as
 * an unhandled 500. Validating here turns that into a clean 503 instead.
 */
export function isAdminConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
