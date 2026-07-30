/**
 * System-browser OAuth (RFC 8252, "OAuth 2.0 for Native Apps").
 *
 * Google refuses to serve its consent screen to an embedded webview, and that
 * is deliberate anti-phishing behaviour rather than a bug to route around —
 * spoofing a Chrome identity fights an anti-abuse system that keeps tightening,
 * and it hides the real URL bar from the user at exactly the moment they are
 * typing a password. Notion, Spotify and Claude Desktop all do it the way this
 * module does: sign in in the user's real browser, then hand the result back to
 * the app over a private URL scheme.
 *
 * WHY THIS NEEDS NO COOKIE SURGERY. The natural worry is that the browser holds
 * the session and the app cannot see it. That is avoided by intercepting one
 * step earlier:
 *
 *   1. The user clicks "Continue with Google" INSIDE the app window, so the web
 *      app's own Supabase client runs there and writes its PKCE code-verifier
 *      cookie into the app's cookie jar.
 *   2. It then navigates to `<project>.supabase.co/auth/v1/authorize?...`. We
 *      cancel that navigation, rewrite only `redirect_to`, and open it in the
 *      system browser.
 *   3. The user signs in to Google normally, in a real browser.
 *   4. Supabase redirects to `duitsini://auth/callback?code=…`, which the OS
 *      hands to this app.
 *   5. We load `<app>/auth/callback?code=…` in the app window. The web app's
 *      EXISTING route exchanges that code against the verifier from step 1 —
 *      which is already in this jar — and sets the session itself.
 *
 * So the browser never holds a session, we never parse or write an auth cookie,
 * and `app/auth/callback/route.ts` is used exactly as written. The only thing
 * this module changes about the request is one query parameter.
 *
 * EXTERNAL REQUIREMENT: `duitsini://auth/callback` must be listed under
 * Authentication → URL Configuration → Redirect URLs in the Supabase dashboard,
 * or step 4 is refused with `redirect_to is not allowed`.
 */

export const DEEP_LINK_SCHEME = "duitsini";
export const DEEP_LINK_CALLBACK = `${DEEP_LINK_SCHEME}://auth/callback`;

/**
 * Is this the provider hand-off navigation?
 *
 * Matched on path rather than host so it works against any Supabase project ref
 * (and a self-hosted GoTrue) without configuration.
 */
export function isOAuthAuthorize(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname === "/auth/v1/authorize" && u.searchParams.has("provider");
  } catch {
    return false;
  }
}

/**
 * Point the provider's redirect at this app instead of the website.
 *
 * Everything else — provider, scopes, `code_challenge` — is left exactly as the
 * web app built it. That matters: the challenge must keep matching the verifier
 * already sitting in our cookie jar, so it must not be regenerated here.
 */
export function toDesktopAuthorizeUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("redirect_to", DEEP_LINK_CALLBACK);
  return u.toString();
}

export interface CallbackParams {
  code?: string;
  error?: string;
  /** Post-login path the web app should land on. */
  next?: string;
}

/** Parse `duitsini://auth/callback?...`. Returns null for anything else. */
export function parseCallback(deepLink: string): CallbackParams | null {
  let u: URL;
  try {
    u = new URL(deepLink);
  } catch {
    return null;
  }
  if (u.protocol !== `${DEEP_LINK_SCHEME}:`) return null;

  // Custom schemes parse inconsistently across platforms — the authority may
  // land in `host` or in `pathname` depending on how the OS passes it — so the
  // shape is checked loosely rather than by exact path match.
  const combined = `${u.host}${u.pathname}`;
  if (!combined.includes("auth")) return null;

  const code = u.searchParams.get("code") ?? undefined;
  const error =
    u.searchParams.get("error_description") ?? u.searchParams.get("error") ?? undefined;
  const next = u.searchParams.get("next") ?? undefined;
  return { code, error, next };
}

/**
 * Build the in-app URL that completes sign-in.
 *
 * `next` is passed through `safeRedirectPath` on the server, so a hostile deep
 * link cannot use it to bounce the window somewhere off-origin; we still only
 * forward a leading-slash path.
 */
export function completionUrl(appOrigin: string, params: CallbackParams): string {
  const u = new URL("/auth/callback", appOrigin);
  if (params.code) u.searchParams.set("code", params.code);
  if (params.error) u.searchParams.set("error", params.error);
  if (params.next && params.next.startsWith("/")) u.searchParams.set("next", params.next);
  return u.toString();
}

/** Pull a `duitsini://` argument out of a process argv (Windows/Linux path). */
export function deepLinkFromArgv(argv: string[]): string | null {
  return argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}
