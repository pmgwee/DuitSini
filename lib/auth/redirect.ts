/**
 * Auth redirect helpers.
 *
 * After a successful sign-in we redirect to a `next` path the caller chose
 * (e.g. the page the user was trying to reach). Because `next` comes from an
 * untrusted query parameter, every value is clamped to a safe internal path to
 * prevent open-redirect attacks (e.g. `next=//evil.com` or `next=https://evil`).
 */

const DEFAULT_REDIRECT = "/subscriptions";

/**
 * Return a safe, server-relative path to redirect to. Anything that could
 * resolve to another origin — a protocol-relative URL (`//host`), an absolute
 * URL (`https://…`), a scheme (`javascript:`), or a backslash escape — is
 * rejected and replaced with the default.
 */
export function safeRedirectPath(next?: string | null): string {
  if (!next) return DEFAULT_REDIRECT;
  if (!next.startsWith("/")) return DEFAULT_REDIRECT;
  // Reject protocol-relative and backslash-prefixed paths.
  if (next.startsWith("//") || next.startsWith("/\\")) return DEFAULT_REDIRECT;

  // Parse against a throwaway origin; the result must stay on that origin and
  // be a simple pathname (no embedded scheme/host).
  try {
    const parsed = new URL(next, "http://auth.redirect.invalid");
    if (parsed.origin !== "http://auth.redirect.invalid") return DEFAULT_REDIRECT;
    return parsed.pathname + parsed.search;
  } catch {
    return DEFAULT_REDIRECT;
  }
}

/**
 * Absolute callback URL the OAuth/magic-link provider redirects back to, with a
 * sanitized `next` param appended. Must be listed in Supabase's allowed
 * redirect URLs.
 *
 * Prefers the **live browser origin** (`window.location.origin`) so the
 * redirect is correct on every deployment — production, preview, and localhost
 * — without depending on a build-time `NEXT_PUBLIC_APP_URL`. (A silent
 * localhost fallback here is exactly what stranded OAuth codes on the home page
 * in production, so the server-side branch fails loud instead.)
 */
export function buildCallbackUrl(next?: string | null): string {
  let origin: string;
  if (typeof window !== "undefined") {
    origin = window.location.origin;
  } else {
    const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
    if (!configured) {
      throw new Error(
        "buildCallbackUrl needs NEXT_PUBLIC_APP_URL for server-side use, or a browser (window) context.",
      );
    }
    origin = configured;
  }
  const callback = new URL("/auth/callback", origin);
  callback.searchParams.set("next", safeRedirectPath(next));
  return callback.toString();
}
