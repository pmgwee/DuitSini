import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getGoogleAccessToken } from "@/lib/google/tokens";
import { LIKED_MUSIC_ID, listPlaylistTracks } from "@/lib/google/youtube";
import { buildShelf } from "@/lib/music/recommend";
import {
  loadHistory,
  loadLikes,
  loadSuppressions,
  loadTransitionBias,
} from "@/lib/music/store";
import type { MusicTrack } from "@/types/music";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Candidate generation fans out to several InnerTube calls; give it room, but
// stay under the platform ceiling so a slow source returns JSON, not an HTML 504.
export const maxDuration = 30;

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
 * GET — the discovery shelf.
 *
 * Previously this reshuffled the listener's own play history, which by
 * construction could never surface anything new: shuffling a set you have
 * already heard is still that set. Now the history is used only as SEED
 * material, and the shelf itself comes from YouTube Music's recommendation
 * surfaces (song radio, "you might also like", similar artists, editorial
 * playlists) ranked against the listener's own behavioural signals.
 *
 * None of it is authenticated — the old cookie path is gone, so there is
 * nothing to expire and nothing to re-capture.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ tracks: [], seeded: false }, { status: 401 });

  const [history, likes, suppressions] = await Promise.all([
    loadHistory(supabase, user.id),
    loadLikes(supabase, user.id),
    loadSuppressions(supabase, user.id),
  ]);

  // A like alone is enough to build a shelf from — the listener has told us
  // something real even if they haven't played anything yet.
  if (history.length > 0 || likes.length > 0) {
    const transitionBias = await loadTransitionBias(supabase, user.id);
    const suppressed = new Set([
      ...suppressions.notInterested,
      ...suppressions.snoozedUntil.keys(),
    ]);
    let tracks: MusicTrack[] = [];
    try {
      tracks = await buildShelf(history, {
        limit: SHELF_CAP,
        transitionBias,
        likes,
        suppressed,
      });
    } catch (err) {
      // Recommendation must never take the dashboard down.
      console.error("[yt/plays] shelf build failed:", (err as Error)?.message ?? err);
    }

    // If every source failed (network, IP block, shape change) fall back to the
    // old recency behaviour so the widget still plays something.
    if (tracks.length === 0) {
      tracks = history.slice(0, SHELF_CAP).map((entry) => ({
        videoId: entry.videoId,
        title: entry.title,
        channel: entry.channel,
        thumbnail: entry.thumbnail,
        source: "local" as const,
      }));
    }

    return NextResponse.json<ListenAgainResponse>({ tracks, seeded: false });
  }

  // Cold start: nothing in-app yet. Use the imported YouTube "Liked Music" as a
  // SEED for real recommendations rather than displaying it back.
  //
  // Shuffling the import was the old behaviour and it reproduced the exact
  // problem this recommender exists to solve: a new listener with a large
  // library got their own familiar songs in a random order, and looped there
  // until they searched manually. Seeding from it instead means even the very
  // first shelf is mostly music they haven't heard.
  const token = await getGoogleAccessToken(user.id);
  if (token) {
    const liked = await listPlaylistTracks(token, LIKED_MUSIC_ID);
    if (liked && liked.length > 0) {
      let tracks: MusicTrack[] = [];
      try {
        tracks = await buildShelf([], { limit: SHELF_CAP, coldStart: shuffle(liked) });
      } catch (err) {
        console.error("[yt/plays] cold-start build failed:", (err as Error)?.message ?? err);
      }
      // Only if every source failed do we fall back to showing the import.
      if (tracks.length === 0) tracks = shuffle(liked).slice(0, 12);
      return NextResponse.json<ListenAgainResponse>({ tracks, seeded: true });
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
