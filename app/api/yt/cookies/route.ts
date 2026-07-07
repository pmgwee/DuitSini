import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  clearYTMusicCookie,
  getYTMusicCookie,
  markYTMusicCookieOk,
  saveYTMusicCookie,
} from "@/lib/google/ytm-cookies";
import { testYTMusicCookie } from "@/lib/google/ytmusic";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cookieSchema = z.object({
  // The raw value of the browser `Cookie:` header from a music.youtube.com
  // request. Opaque credential — stored verbatim, never echoed back.
  cookie: z.string().min(20, "Cookie looks too short").max(8000, "Cookie too long"),
});

export interface CookiesStatusResponse {
  connected: boolean;
  /** When the cookies last produced a successful fetch (null until first hit). */
  lastOkAt: string | null;
}

/** GET — connection status for the "Connect YouTube Music (advanced)" UI. */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ connected: false, lastOkAt: null }, { status: 401 });

  const cookie = await getYTMusicCookie(user.id);
  if (!cookie) return NextResponse.json<CookiesStatusResponse>({ connected: false, lastOkAt: null });

  // last_ok_at is read via the admin client (service-role-only table).
  const admin = createSupabaseAdminClient();
  const { data } = await admin
    .from("ytm_cookies")
    .select("last_ok_at")
    .eq("user_id", user.id)
    .maybeSingle();
  return NextResponse.json<CookiesStatusResponse>({
    connected: true,
    lastOkAt: data?.last_ok_at ?? null,
  });
}

/**
 * POST — connect / re-capture. We validate the cookies against YT Music BEFORE
 * persisting, so a bad/expired paste is rejected with a clear message instead
 * of silently producing an empty recommendation shelf.
 */
export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const body = cookieSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ ok: false, error: body.error.issues[0]?.message ?? "bad request" }, { status: 400 });
  }
  const cookieHeader = body.data.cookie.trim();

  const ok = await testYTMusicCookie(cookieHeader);
  if (!ok) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Couldn't authenticate with these cookies. Make sure you copied the full Cookie header from a music.youtube.com request while signed in, and that you haven't since logged out.",
      },
      { status: 400 },
    );
  }

  await saveYTMusicCookie(user.id, cookieHeader);
  await markYTMusicCookieOk(user.id);
  return NextResponse.json({ ok: true });
}

/** DELETE — disconnect (drop the stored cookies). */
export async function DELETE() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });
  await clearYTMusicCookie(user.id);
  return NextResponse.json({ ok: true });
}
