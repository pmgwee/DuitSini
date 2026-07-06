import { NextResponse, type NextRequest } from "next/server";
import type { MusicTrack } from "@/types/music";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const API_KEY = process.env.YOUTUBE_API_KEY;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — protects the 100 searches/day quota.
const cache = new Map<string, { at: number; data: unknown[] }>();

/**
 * Server-side YouTube Data API v3 search. Returns embeddable Music-category
 * videos for a query. The API key stays server-side (never NEXT_PUBLIC_), and
 * results are cached per query for an hour to respect the daily quota.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ results: [], configured: Boolean(API_KEY) });
  }
  if (!API_KEY) {
    return NextResponse.json(
      { results: [], configured: false, error: "YOUTUBE_API_KEY not set" },
      { status: 503 },
    );
  }

  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ results: hit.data, configured: true, cached: true });
  }

  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("part", "snippet");
  url.searchParams.set("type", "video");
  url.searchParams.set("videoEmbeddable", "true");
  url.searchParams.set("videoCategoryId", "10"); // Music
  url.searchParams.set("maxResults", "12");
  url.searchParams.set("q", q);
  url.searchParams.set("key", API_KEY);

  let resp: Response;
  try {
    resp = await fetch(url, { cache: "no-store" });
  } catch {
    return NextResponse.json(
      { results: [], configured: true, error: "network" },
      { status: 502 },
    );
  }
  if (!resp.ok) {
    return NextResponse.json(
      { results: [], configured: true, error: `youtube ${resp.status}` },
      { status: 502 },
    );
  }

  const json = (await resp.json()) as {
    items?: Array<{
      id?: { videoId?: string };
      snippet?: { title?: string; channelTitle?: string; thumbnails?: { medium?: { url?: string } } };
    }>;
  };

  const results: MusicTrack[] = (json.items ?? [])
    .filter((it) => Boolean(it.id?.videoId))
    .map((it) => ({
      videoId: it.id!.videoId as string,
      title: it.snippet?.title ?? "Untitled",
      channel: it.snippet?.channelTitle ?? "",
      thumbnail: it.snippet?.thumbnails?.medium?.url ?? null,
    }));

  cache.set(key, { at: Date.now(), data: results });
  return NextResponse.json({ results, configured: true });
}
