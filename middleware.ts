import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "@/lib/supabase/types";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
// Newer "publishable" key with a fallback to the legacy anon key name.
const supabaseKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string;

/** Routes that require an authenticated session. */
const PROTECTED_PREFIXES = ["/subscriptions", "/dashboard"];

/**
 * Refreshes the auth session on every matched request and enforces route
 * protection. `getUser()` validates the JWT against Supabase (server-side) and,
 * when the access token has expired, rotates it — writing the refreshed cookies
 * onto the forwarded response. We never gate on `getSession()` (client-cached,
 * spoofable).
 */
async function updateSession(request: NextRequest): Promise<NextResponse> {
  const supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          // Keep the request's cookie jar in sync so downstream server
          // components read the refreshed values, and mirror onto the response.
          request.cookies.set(name, value);
          supabaseResponse.cookies.set(name, value, options);
        });
      },
    },
  });

  // Do not run between `getUser` and the return: its side-effect (cookie
  // refresh) must not be short-circuited.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
  const isLogin = path === "/login";

  // Unauthenticated visit to a protected route → send to login, preserving
  // the intended destination in `next`.
  if (!user && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }

  // Already-signed-in visit to /login → bounce into the app.
  if (user && isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/subscriptions";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  return updateSession(request);
}

export const config = {
  // Run on everything except static assets and Next internals.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|css|js|map)$).*)",
  ],
};
