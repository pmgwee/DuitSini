import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "./types";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const supabaseKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string;

/**
 * Server Supabase client bound to the request's auth cookies. Use in server
 * components, route handlers, and server actions. RLS applies via `auth.uid()`.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(supabaseUrl, supabaseKey, {
    // Mark auth cookies Secure in production (HTTPS). @supabase/ssr's defaults
    // omit this; setting it is standard defense-in-depth for token cookies.
    cookieOptions: { secure: process.env.NODE_ENV === "production" },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set({ name, value, ...options });
          }
        } catch {
          // Called from a Server Component — cookies are read-only here.
          // Session refresh is handled by middleware, so this is safe to ignore.
        }
      },
    },
  });
}
