import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getGoogleAccessToken } from "@/lib/google/tokens";
import { LIKED_MUSIC_ID, listPlaylistTracks } from "@/lib/google/youtube";
import type { MusicTrack } from "@/types/music";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const playSchema = z.object({
  videoId: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  channel: z.string().max(200).default(""),
  thumbnail: z.string().url().max(500).nullable().default(null),
});

export interface ListenAgainResponse {
  tracks: MusicTrack[];
  /** True when the shelf is seeded from Liked Music (no in-app plays yet). */
  seeded: boolean;
}

/**
 * GET — the "Listen again" shelf: tracks played in this app, most recent
 * first. While the user has no plays yet, it is seeded from their Liked
 * Music so the shelf is never empty on day one.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ tracks: [], seeded: false }, { status: 401 });

  const { data, error } = await supabase
    .from("music_plays")
    .select("video_id, title, channel, thumbnail")
    .eq("user_id", user.id)
    .order("last_played_at", { ascending: false })
    .limit(24);
  if (error) return NextResponse.json({ tracks: [], seeded: false }, { status: 500 });

  if (data.length > 0) {
    const tracks: MusicTrack[] = data.map((r) => ({
      videoId: r.video_id,
      title: r.title,
      channel: r.channel,
      thumbnail: r.thumbnail,
    }));
    return NextResponse.json<ListenAgainResponse>({ tracks, seeded: false });
  }

  // Day-one seed: fall back to Liked Music when there is no history yet.
  const token = await getGoogleAccessToken(user.id);
  if (token) {
    const liked = await listPlaylistTracks(token, LIKED_MUSIC_ID);
    if (liked && liked.length > 0) {
      return NextResponse.json<ListenAgainResponse>({ tracks: liked.slice(0, 12), seeded: true });
    }
  }
  return NextResponse.json<ListenAgainResponse>({ tracks: [], seeded: false });
}

/** POST — log a play (atomic upsert-increment via RLS-scoped RPC). */
export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const body = playSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false }, { status: 400 });

  const { error } = await supabase.rpc("log_music_play", {
    p_video_id: body.data.videoId,
    p_title: body.data.title,
    p_channel: body.data.channel,
    // Generated arg type is non-null; "" is falsy everywhere the UI reads it.
    p_thumbnail: body.data.thumbnail ?? "",
  });
  if (error) return NextResponse.json({ ok: false }, { status: 500 });
  return NextResponse.json({ ok: true });
}
