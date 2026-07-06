import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { safeRedirectPath } from "@/lib/auth/redirect";
import { saveGoogleTokens } from "@/lib/google/tokens";

/**
 * PKCE callback for both email magic-link and Google OAuth. The provider
 * redirects here with a one-time `code`; we exchange it for a session
 * server-side (the code never touches the browser), set the auth cookies, and
 * forward to the sanitized `next` path.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const nextParam = searchParams.get("next");
  const next = safeRedirectPath(nextParam);

  // An error from the provider (e.g. user cancelled consent) or a missing code
  // → back to login with an error flag. No stack details are leaked.
  const errorCode = searchParams.get("error") ?? searchParams.get("error_description");
  if (errorCode || !code) {
    return NextResponse.redirect(
      `${origin}/login?error=callback&next=${encodeURIComponent(next)}`,
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(
      `${origin}/login?error=callback&next=${encodeURIComponent(next)}`,
    );
  }

  // Google OAuth sign-ins carry provider tokens exactly once, here. Persist
  // them (server-only table) so the YouTube sync can mint access tokens later.
  // Magic-link sessions have no provider tokens — this is skipped for them.
  const session = data?.session;
  if (session?.user && session.provider_refresh_token) {
    await saveGoogleTokens(session.user.id, {
      accessToken: session.provider_token ?? null,
      refreshToken: session.provider_refresh_token,
      scopes: "youtube.readonly",
    }).catch(() => {
      /* sync is best-effort; login must still succeed */
    });
  }

  return NextResponse.redirect(`${origin}${next}`);
}
