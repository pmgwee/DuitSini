import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "./types";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
// Supabase's newer "publishable" key; falls back to the legacy anon key name.
const supabaseKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string;

/** Browser Supabase client (client components). */
export function createSupabaseBrowserClient() {
  return createBrowserClient<Database>(supabaseUrl, supabaseKey, {
    auth: {
      // PKCE so OAuth/magic-link codes are exchanged server-side in the
      // callback route; we don't auto-exchange from the URL fragment.
      flowType: "pkce",
      detectSessionInUrl: false,
      autoRefreshToken: true,
      persistSession: true,
    },
    // Mark auth cookies Secure in production (HTTPS); off in dev (http) so
    // localhost cookies are still accepted.
    cookieOptions: { secure: process.env.NODE_ENV === "production" },
  });
}
