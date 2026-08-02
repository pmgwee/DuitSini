import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Negative controls — the other half of the feedback loop.
 *
 * A like-only system can only ever say "more of this". Both incumbents ship an
 * explicit way to say "less of this": Spotify has *not interested* alongside a
 * 30-day *Snooze*, and an r/AppleMusic complaint about unwanted content having
 * no recourse beyond "suggest less" is exactly the gap this closes.
 *
 * `not_interested` is permanent; `snooze` lapses on its own after 30 days and
 * needs no cleanup job — an expired row is simply ignored on read.
 */

const SNOOZE_DAYS = 30;

const schema = z.object({
  videoId: z.string().min(1).max(64),
  kind: z.enum(["not_interested", "snooze"]),
});

const clearSchema = z.object({ videoId: z.string().min(1).max(64) });

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const body = schema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false }, { status: 400 });

  const until =
    body.data.kind === "snooze"
      ? new Date(Date.now() + SNOOZE_DAYS * 86_400_000).toISOString()
      : null;

  const { error } = await supabase.from("music_suppressions").upsert({
    user_id: user.id,
    video_id: body.data.videoId,
    kind: body.data.kind,
    until,
  });
  if (error) {
    console.error("[yt/suppress] failed:", error.message);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  // Pushing a track away contradicts having liked it; drop the like so the two
  // signals can't disagree.
  await supabase
    .from("music_likes")
    .delete()
    .eq("user_id", user.id)
    .eq("video_id", body.data.videoId);

  return NextResponse.json({ ok: true, until });
}

/** DELETE — undo a suppression (the "undo" affordance on the toast). */
export async function DELETE(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const body = clearSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false }, { status: 400 });

  const { error } = await supabase
    .from("music_suppressions")
    .delete()
    .eq("user_id", user.id)
    .eq("video_id", body.data.videoId);
  if (error) return NextResponse.json({ ok: false }, { status: 500 });
  return NextResponse.json({ ok: true });
}
