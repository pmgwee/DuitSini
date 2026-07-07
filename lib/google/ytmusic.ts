import { createHash } from "node:crypto";
import { Innertube } from "youtubei.js";
import type { MusicTrack } from "@/types/music";

/**
 * Reads YouTube Music's algorithmic "Listen again" shelf by replaying the
 * user's browser session (cookies). Google removed YT Music OAuth in Nov 2024,
 * so cookies are the only way to reach personalized shelves — this is the
 * opt-in power-user path behind the "Connect YouTube Music (advanced)" flow.
 *
 * Everything here is defensive: the official app never depends on this data.
 * On any failure (bad/expired cookies, Google shape change, network) we return
 * `[]` and the shelf silently falls back to the local recency list.
 */

const CACHE_TTL_MS = 10 * 60_000; // per-credential; bounds calls on every play-refetch
const MAX_PAGES = 3; // home shelves paginate; "Listen again" is usually on page 1
interface CacheEntry {
  tracks: MusicTrack[];
  at: number;
}
const cache = new Map<string, CacheEntry>();

/** 11-char video id (letters, digits, - and _). Excludes album/playlist browseIds. */
const VIDEO_ID = /^[\w-]{11}$/;

function pickThumbnail(item: { thumbnail?: Array<{ url?: string; width?: number }> }): string | null {
  const thumbs = item.thumbnail;
  if (!thumbs || thumbs.length === 0) return null;
  // Prefer a medium thumbnail (~120px) for the list; fall back to the last.
  const medium =
    thumbs.find((t) => (t.width ?? 0) >= 100 && (t.width ?? 0) <= 240) ?? thumbs[thumbs.length - 1];
  return medium?.url ?? null;
}

/**
 * Extract a playable track from any home-feed item that carries a video id.
 * Works for MusicTwoRowItem (carousel cards) and MusicResponsiveListItem shapes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTrack(item: any): MusicTrack | null {
  const id: string | undefined =
    item?.id ?? item?.endpoint?.payload?.videoId ?? item?.videoId;
  if (!id || !VIDEO_ID.test(id)) return null;
  // Skip non-playable rows (albums/playlists/artists surface as browseIds, not
  // 11-char video ids — already filtered above — but guard the type too).
  if (item?.item_type && item.item_type !== "song" && item.item_type !== "video") {
    // item_type is only set on MusicTwoRowItem; list items don't set it.
    if (item.item_type !== undefined) return null;
  }
  const title: string = item?.title?.toString?.() ?? item?.title?.text ?? "";
  const subtitle: string = item?.subtitle?.toString?.() ?? item?.subtitle?.text ?? "";
  const channel =
    item?.artists?.[0]?.name ?? subtitle.split("•")[0]?.trim() ?? "";
  const thumbnail = pickThumbnail(item);
  if (!title) return null;
  return {
    videoId: id,
    title,
    // Match the existing mapper: strip the " - Topic" suffix YouTube appends.
    channel: channel.replace(/ - Topic$/, ""),
    thumbnail,
    source: "recommended",
  };
}

function tracksFromSection(section: { contents?: unknown[] }): MusicTrack[] {
  const out: MusicTrack[] = [];
  const contents = section?.contents;
  if (!Array.isArray(contents)) return out;
  for (const c of contents) {
    const track = extractTrack(c);
    if (track) out.push(track);
  }
  return out;
}

/** Find the "Listen again" carousel within the (possibly paginated) home feed. */
async function findListenAgain(
  feed: Awaited<ReturnType<typeof buildHomeFeed>>,
): Promise<MusicTrack[]> {
  for (let page = 0; page < MAX_PAGES; page++) {
    const sections = feed.sections;
    if (sections) {
      for (const section of sections) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const title: string = (section as any)?.header?.title?.toString?.() ?? "";
        if (/listen again/i.test(title)) {
          return tracksFromSection(section as unknown as { contents?: unknown[] });
        }
      }
    }
    if (!feed.has_continuation) break;
    try {
      feed = await feed.getContinuation();
    } catch {
      break;
    }
  }
  return [];
}

async function buildHomeFeed(cookieHeader: string) {
  const yt = await Innertube.create({
    cookie: cookieHeader,
    retrieve_player: false, // we only browse; skip the (heavy) player bootstrap
    enable_session_cache: false, // stateless serverless — no shared session needed
  });
  return yt.music.getHomeFeed();
}

/**
 * The user's YouTube Music "Listen again" shelf as playable tracks, or `[]` on
 * any failure. Results are cached per-credential for CACHE_TTL_MS so the
 * play-invalidated refetch of /api/yt/plays doesn't hammer the unofficial API.
 *
 * `fresh` is true when the tracks came from a live fetch (not the cache), so
 * the caller can stamp `last_ok_at` only on real successes.
 */
export async function getListenAgainRecommendations(
  cookieHeader: string,
): Promise<{ tracks: MusicTrack[]; fresh: boolean }> {
  const key = createHash("sha256").update(cookieHeader).digest("hex").slice(0, 16);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { tracks: hit.tracks, fresh: false };
  }

  let tracks: MusicTrack[] = [];
  try {
    const feed = await buildHomeFeed(cookieHeader);
    tracks = await findListenAgain(feed);
  } catch (err) {
    // Bad/expired cookies, Google shape change, network — degrade silently.
    console.error("[ytmusic] listen-again fetch failed:", (err as Error)?.message ?? err);
    tracks = [];
  }
  cache.set(key, { tracks, at: Date.now() });
  return { tracks, fresh: true };
}

/**
 * One-shot validity check used when saving cookies: does getHomeFeed() succeed
 * and return at least one shelf? Throwing / empty → cookie is bad or expired.
 */
export async function testYTMusicCookie(cookieHeader: string): Promise<boolean> {
  try {
    const feed = await buildHomeFeed(cookieHeader);
    return Boolean(feed.sections && feed.sections.length > 0);
  } catch (err) {
    console.error("[ytmusic] cookie test failed:", (err as Error)?.message ?? err);
    return false;
  }
}
