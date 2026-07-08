import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_VOLUME = 50;

const putSchema = z.object({ volume: z.number().int().min(0).max(100) });

/**
 * Per-user music player volume. The player loads this on mount (so a chosen
 * volume survives sessions/devices) and writes it back debounced on change.
 * Auth = the signed-in user's session cookie; RLS on `music_settings` pins each
 * user to their own row. Falls back to 50 when there's no row / no migration.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ volume: DEFAULT_VOLUME }, { status: 200 });

  const { data } = await supabase
    .from("music_settings")
    .select("volume")
    .eq("user_id", user.id)
    .maybeSingle();
  return NextResponse.json({ volume: typeof data?.volume === "number" ? data.volume : DEFAULT_VOLUME });
}

export async function PUT(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "bad body" }, { status: 400 });

  // RLS lets the owner upsert only their own row (matched on user_id).
  const { error } = await supabase
    .from("music_settings")
    .upsert({ user_id: user.id, volume: parsed.data.volume, updated_at: new Date().toISOString() });
  if (error) {
    // Most likely the table isn't created yet on a self-hosted copy — fail
    // quietly so playback/volume UX is unaffected; the value still applies live.
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
