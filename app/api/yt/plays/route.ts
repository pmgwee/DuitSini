import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getGoogleAccessToken } from "@/lib/google/tokens";
import { LIKED_MUSIC_ID, listPlaylistTracks } from "@/lib/google/youtube";
import { getYTMusicCookie, markYTMusicCookieOk } from "@/lib/google/ytm-cookies";
import { getListenAgainRecommendations } from "@/lib/google/ytmusic";
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

const SHELF_CAP = 40;

/** Fisher–Yates shuffle returning a new array (leaves the input untouched). */
function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Compose the "Listen again" shelf:
 *   [last-played] · [YT Music recs, shuffled] · [remaining local plays, shuffled]
 *
 * The most-recently-played song is pinned at #1 — the "stack on top" behavior
 * the player already had. When cookies are connected, YouTube Music's picks sit
 * ABOVE the local history; both groups reshuffle on every request so the shelf
 * varies on refresh (like YT Music itself) instead of reading as a static list.
 * All entries are de-duplicated by videoId.
 */
function composeShelf(local: MusicTrack[], recs: MusicTrack[]): MusicTrack[] {
  const seen = new Set<string>();
  const out: MusicTrack[] = [];
  const push = (t: MusicTrack) => {
    if (seen.has(t.videoId)) return;
    seen.add(t.videoId);
    out.push(t);
  };
  // 1. Pinned: the song you last played (most recent), if any.
  if (local.length > 0) push(local[0]);
  // 2. YouTube Music recommendations (connected only) — reshuffled each fetch.
  for (const t of shuffle(recs)) push(t);
  // 3. Remaining local plays — reshuffled each fetch, below the recs.
  for (const t of shuffle(local.slice(1))) push(t);
  return out.slice(0, SHELF_CAP);
}

/**
 * GET — the "Listen again" shelf. The last-played song is pinned at the top;
 * YouTube Music's algorithmic picks (when connected via cookies) sit above the
 * local history. Both the recommendations and the local history reshuffle on
 * each fetch so the shelf feels alive on refresh. The Liked-Music seed is the
 * final fallback when there are no local plays and no/empty recommendations.
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

  const local: MusicTrack[] = data.map((r) => ({
    videoId: r.video_id,
    title: r.title,
    channel: r.channel,
    thumbnail: r.thumbnail,
  }));

  // OPT-IN enrichment via the user's YT Music session cookies. Never throws —
  // any failure (no cookies, expired, Google shape change) leaves recs empty.
  let recs: MusicTrack[] = [];
  const cookie = await getYTMusicCookie(user.id);
  if (cookie) {
    const { tracks, fresh } = await getListenAgainRecommendations(cookie);
    recs = tracks;
    if (tracks.length > 0 && fresh) void markYTMusicCookieOk(user.id);
  }

  if (local.length > 0 || recs.length > 0) {
    return NextResponse.json<ListenAgainResponse>({
      tracks: composeShelf(local, recs),
      seeded: false,
    });
  }

  // Final fallback: Liked Music seed (no local plays and no/empty recs).
  const token = await getGoogleAccessToken(user.id);
  if (token) {
    const liked = await listPlaylistTracks(token, LIKED_MUSIC_ID);
    if (liked && liked.length > 0) {
      return NextResponse.json<ListenAgainResponse>({
        tracks: shuffle(liked).slice(0, 12),
        seeded: true,
      });
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
