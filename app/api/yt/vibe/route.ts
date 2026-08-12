import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buildRadio, buildArtistCatalog } from "@/lib/music/recommend";
import { parseVibe, synthSeedQuery, type VibeConstraints } from "@/lib/music/vibe";
import { resolveArtistId } from "@/lib/music/sources";
import {
  loadHistory,
  loadLikes,
  loadSuppressions,
  loadTransitionBias,
} from "@/lib/music/store";
import type { MusicTrack } from "@/types/music";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// GLM parse + up to a few YouTube searches + a radio build.
export const maxDuration = 30;

interface VibeResponse {
  tracks: MusicTrack[];
  constraints: VibeConstraints | null;
  /** False when GLM is not configured (so the UI can say why nothing happened). */
  configured: boolean;
  seedQuery: string | null;
}

/** Resolve a search query to the first real Music-category videoId, or null. */
async function resolveFirstVideoId(query: string): Promise<string | null> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key || !query) return null;
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("videoCategoryId", "10"); // Music
  url.searchParams.set("maxResults", "1");
  url.searchParams.set("q", query);
  url.searchParams.set("key", key);
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as { items?: Array<{ id?: { videoId?: string } }> };
    return json.items?.[0]?.id?.videoId ?? null;
  } catch {
    return null;
  }
}

/**
 * GET — the "vibe" surface: describe what you want to hear in plain language,
 * get a personalized radio that matches.
 *
 * Architecture (matches what every major DSP ships in 2026): the LLM ONLY
 * captures intent — it maps the prompt onto tags + a concrete seed, never onto
 * song titles. The seed is resolved to a real videoId via YouTube search
 * (grounding — no hallucinated ids), and the existing `buildRadio` does the
 * actual picking: it personalizes around the seed using the listener's own
 * history, likes, skips and learned transitions, and sequences with the tag
 * prior. So the behavioural ranker stays the asset; the LLM is the intent layer.
 */
export async function GET(req: NextRequest) {
  const prompt = req.nextUrl.searchParams.get("prompt")?.trim();
  if (!prompt) {
    return NextResponse.json<VibeResponse>(
      { tracks: [], constraints: null, configured: true, seedQuery: null },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json<VibeResponse>(
      { tracks: [], constraints: null, configured: true, seedQuery: null },
      { status: 401 },
    );
  }

  // 1. Intent capture (GLM). Null when GLM is unconfigured/unavailable.
  const constraints = await parseVibe(prompt);
  if (!constraints) {
    return NextResponse.json<VibeResponse>(
      { tracks: [], constraints: null, configured: false, seedQuery: null },
      { status: 503 },
    );
  }

  // The listener's signals are needed by every fulfilment path, so load once.
  const [history, likes, suppressions] = await Promise.all([
    loadHistory(supabase, user.id),
    loadLikes(supabase, user.id),
    loadSuppressions(supabase, user.id),
  ]);
  const transitionBias = await loadTransitionBias(supabase, user.id);
  const likeIds = new Set(likes.map((l) => l.videoId));
  const suppressed = new Set([...suppressions.notInterested, ...suppressions.snoozedUntil.keys()]);

  const applyExclude = (tracks: MusicTrack[]): MusicTrack[] =>
    constraints.exclude.length === 0
      ? tracks
      : tracks.filter((t) => !constraints.exclude.some((w) => t.title.toLowerCase().includes(w)));

  // 2a. Artist-catalog path — "top songs by X". parseVibe separates a named
  //     ARTIST from a named song; when an artist is named we resolve it to a
  //     channel id and read its own popularity-ordered Songs shelf (NOT a
  //     similar-track radio). Falls through to song-radio if unresolved.
  const artistQuery = constraints.artists?.[0];
  if (artistQuery) {
    const artistId = await resolveArtistId(artistQuery);
    if (artistId) {
      let tracks: MusicTrack[] = [];
      try {
        const catalog = await buildArtistCatalog(artistId, history, {
          limit: constraints.length,
          transitionBias,
          likes: likeIds,
          suppressed,
        });
        tracks = catalog.tracks;
      } catch (err) {
        console.error("[yt/vibe] artist catalog build failed:", (err as Error)?.message ?? err);
      }
      return NextResponse.json<VibeResponse>({
        tracks: applyExclude(tracks),
        constraints,
        configured: true,
        seedQuery: artistQuery,
      });
    }
    // Unresolved artist: use the name as a radio seed below rather than failing.
    if (constraints.seedNames.length === 0) constraints.seedNames = [artistQuery];
  }

  // 2b. Song-radio path. Resolve a real seed videoId via search (grounding — no
  //     hallucinated ids), then personalize around it.
  const queries = constraints.seedNames.length > 0 ? constraints.seedNames : [synthSeedQuery(constraints)];
  let seedVideoId: string | null = null;
  let seedQuery: string | null = null;
  for (const q of queries.slice(0, 3)) {
    const id = await resolveFirstVideoId(q);
    if (id) {
      seedVideoId = id;
      seedQuery = q;
      break;
    }
  }
  if (!seedVideoId) {
    return NextResponse.json<VibeResponse>(
      { tracks: [], constraints, configured: true, seedQuery: queries[0] ?? null },
      { status: 200 },
    );
  }

  // 3. Fulfil via the behavioural radio — personalized to this listener.
  let tracks: MusicTrack[] = [];
  try {
    const radio = await buildRadio(seedVideoId, history, {
      limit: constraints.length,
      transitionBias,
      likes: likeIds,
      suppressed,
    });
    tracks = radio.tracks;
  } catch (err) {
    console.error("[yt/vibe] radio build failed:", (err as Error)?.message ?? err);
  }

  return NextResponse.json<VibeResponse>({
    tracks: applyExclude(tracks),
    constraints,
    configured: true,
    seedQuery,
  });
}
