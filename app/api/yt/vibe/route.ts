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
// LLM intent parse + up to a few YouTube searches + a radio build.
export const maxDuration = 30;

interface VibeResponse {
  tracks: MusicTrack[];
  constraints: VibeConstraints | null;
  /** False when the LLM is not configured (so the UI can say why nothing happened). */
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
 * Structural fallback for artist intent: catch the common "top songs by X" /
 * "best of X" / "X greatest hits" phrasings the LLM occasionally mis-files as a
 * song seed. Returns the named artist(s), if any. Classifies PHRASING only —
 * never taste — so it stays on the intent-parsing side of the rule.
 */
function extractArtistIntent(prompt: string): string[] {
  const out: string[] = [];
  const push = (raw?: string) => {
    if (!raw) return;
    const name = raw
      .trim()
      .replace(/[,;].*$/, "")
      .replace(/\s+(?:ranked|sorted|in\s+\w+|please).*$/i, "")
      .trim();
    if (name && !out.includes(name)) out.push(name);
  };
  const byMatch = prompt.match(
    /\b(?:top\s+songs?|songs?|hits?|tracks?|music|best\s+(?:of|songs?|hits?)|greatest\s+hits?|top\s+\d+)\s+by\s+(.+)$/i,
  );
  push(byMatch?.[1]);
  const ofMatch = prompt.match(/\bbest\s+(?:of|songs?|hits?)\s+(.+)$/i);
  push(ofMatch?.[1]);
  return out;
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

  // 1. Intent capture (LLM). Null when the LLM is unconfigured/unavailable.
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
  //     ARTIST from a named song; we ALSO structurally extract a "by X" / "best
  //     of X" intent from the raw prompt as a fallback (the LLM occasionally
  //     drops a named artist into seedNames). For each candidate we resolve a
  //     channel id and read the artist's own popularity-ordered Songs shelf
  //     (NOT a similar-track radio). Falls through to song-radio if unresolved.
  const artistCandidates = [
    ...(constraints.artists ?? []),
    ...extractArtistIntent(prompt),
  ];
  let resolvedArtist: { name: string; id: string } | null = null;
  for (const name of artistCandidates.slice(0, 3)) {
    const id = await resolveArtistId(name);
    if (id) {
      resolvedArtist = { name, id };
      break;
    }
  }
  if (resolvedArtist) {
    let tracks: MusicTrack[] = [];
    try {
      const catalog = await buildArtistCatalog(resolvedArtist.id, history, {
        // A "top songs" catalog is naturally ~20+; floor it so a radio-style
        // length (the LLM occasionally low-balls to 5) doesn't truncate it.
        limit: Math.max(constraints.length, 20),
        transitionBias,
        likes: likeIds,
        suppressed,
      });
      tracks = catalog.tracks;
      console.log(
        `[yt/vibe] artist-catalog "${resolvedArtist.name}" -> ${resolvedArtist.id} (${tracks.length} tracks)`,
      );
    } catch (err) {
      console.error("[yt/vibe] artist catalog build failed:", (err as Error)?.message ?? err);
    }
    return NextResponse.json<VibeResponse>({
      tracks: applyExclude(tracks),
      constraints,
      configured: true,
      seedQuery: resolvedArtist.name,
    });
  }
  // Nothing resolved as an artist → song-radio. Feed the first candidate into
  // the seed search if the LLM didn't already provide a seedName.
  if (constraints.seedNames.length === 0 && artistCandidates.length > 0) {
    constraints.seedNames = [artistCandidates[0]!];
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
