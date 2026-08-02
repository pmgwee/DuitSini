import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadLikes } from "@/lib/music/store";
import type { MusicTrack } from "@/types/music";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Explicit likes.
 *
 * Likes are stored HERE, not on YouTube. Writing a rating back would need
 * `videos.rate`, which requires the `youtube` / `youtube.force-ssl` scope, and
 * this app deliberately requests only `youtube.readonly` — widening it would
 * re-open Google OAuth verification. So a like is local to DuitSini, which is
 * also what lets us delete one instantly without a round trip to Google.
 */

const likeSchema = z.object({
  videoId: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  channel: z.string().max(200).default(""),
  thumbnail: z.string().url().max(500).nullable().default(null),
});

const unlikeSchema = z.object({ videoId: z.string().min(1).max(64) });

export interface LikesResponse {
  tracks: MusicTrack[];
}

/** GET — the liked shelf, newest first. */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json<LikesResponse>({ tracks: [] }, { status: 401 });

  const likes = await loadLikes(supabase, user.id);
  return NextResponse.json<LikesResponse>({
    tracks: likes.map((like) => ({
      videoId: like.videoId,
      title: like.title,
      channel: like.channel,
      thumbnail: like.thumbnail,
      source: "local",
    })),
  });
}

/** POST — like a track (idempotent; re-liking just refreshes the row). */
export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const body = likeSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false }, { status: 400 });

  const { error } = await supabase.from("music_likes").upsert({
    user_id: user.id,
    video_id: body.data.videoId,
    title: body.data.title,
    channel: body.data.channel,
    thumbnail: body.data.thumbnail,
    liked_at: new Date().toISOString(),
  });
  if (error) {
    console.error("[yt/likes] like failed:", error.message);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  // Liking something previously pushed away is an explicit reversal — clear it
  // so the track is not simultaneously wanted and suppressed.
  await supabase
    .from("music_suppressions")
    .delete()
    .eq("user_id", user.id)
    .eq("video_id", body.data.videoId);

  return NextResponse.json({ ok: true });
}

/** DELETE — remove a like. */
export async function DELETE(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const body = unlikeSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false }, { status: 400 });

  const { error } = await supabase
    .from("music_likes")
    .delete()
    .eq("user_id", user.id)
    .eq("video_id", body.data.videoId);
  if (error) {
    console.error("[yt/likes] unlike failed:", error.message);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
