import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { safeRedirectPath } from "@/lib/auth/redirect";

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
    return NextResponse.redirect(`${origin}/login?error=callback`);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=callback`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
