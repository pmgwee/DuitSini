import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "@/lib/supabase/types";
import { safeRedirectPath } from "@/lib/auth/redirect";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
// Newer "publishable" key with a fallback to the legacy anon key name.
const supabaseKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string;

/**
 * Routes that require an authenticated session — must list EVERY route in the
 * `(app)` group. The group layout also redirects unauthenticated users, but that
 * fallback drops the intended destination: a signed-out deep link to a route
 * missing from this list lands on a bare /login and, after sign-in, dumps the user
 * somewhere they didn't ask for. Only this middleware preserves `?next=`.
 */
const PROTECTED_PREFIXES = [
  "/bills",
  "/ai-usage",
  "/stocks",
  "/reports",
  "/settings",
];

const isProduction = process.env.NODE_ENV === "production";

/**
 * Build a redirect response that also carries any refreshed auth cookies the
 * Supabase client wrote onto `source`. Redirect branches MUST do this — without
 * it, a rotated refresh token is dropped, and when the browser re-presents the
 * now-invalid old token, reuse detection revokes the session and silently logs
 * the user out.
 */
function redirectWithCookies(url: URL, source: NextResponse): NextResponse {
  const response = NextResponse.redirect(url);
  for (const cookie of source.cookies.getAll()) {
    response.cookies.set(cookie.name, cookie.value, cookie);
  }
  return response;
}

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
    cookieOptions: { secure: isProduction },
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

  const { pathname, searchParams } = request.nextUrl;

  // Rescue a stranded OAuth/magic-link handoff. Supabase falls back to the Site
  // URL when its `redirectTo` isn't allowlisted, dropping the `code` (success)
  // or `error` (cancel/failure) on a non-callback route — without this the code
  // is never exchanged and the user appears logged out. Forward it to the
  // callback. Gated on `!user` so the rescue only fires for a genuine no-session
  // handoff; future features that put ?code= on a URL for authed visitors are
  // not hijacked.
  if (!user && pathname !== "/auth/callback") {
    const strandedCode = searchParams.get("code");
    const strandedError = searchParams.get("error") ?? searchParams.get("error_description");
    if (strandedCode || strandedError) {
      const url = request.nextUrl.clone();
      url.pathname = "/auth/callback";
      url.search = "";
      if (strandedCode) {
        url.searchParams.set("code", strandedCode);
      } else {
        url.searchParams.set("error", "stranded");
      }
      url.searchParams.set("next", safeRedirectPath(pathname));
      return redirectWithCookies(url, supabaseResponse);
    }
  }

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  const isLogin = pathname === "/login";

  // Unauthenticated visit to a protected route → send to login, preserving
  // the intended destination in `next`. Carry refreshed cookies in case a
  // rotation happened.
  if (!user && isProtected) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname);
    return redirectWithCookies(url, supabaseResponse);
  }

  // Already-signed-in visit to /login → bounce into the app. Carrying the
  // rotated cookies here is what prevents the silent-logout footgun.
  if (user && isLogin) {
    const url = request.nextUrl.clone();
    url.pathname = "/bills";
    url.search = "";
    return redirectWithCookies(url, supabaseResponse);
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
