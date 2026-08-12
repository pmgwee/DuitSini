import { Innertube } from "youtubei.js";
import type { MusicTrack } from "@/types/music";

/**
 * Anonymous candidate generation against YouTube Music's InnerTube API.
 *
 * WHY NO COOKIES: Google hardened the SAPISID-signed session that the old
 * "Listen again" shelf depended on, and that path also demanded a manual
 * re-capture every time the cookie rotated. It turns out the surfaces we
 * actually want — song radio, "you might also like", similar artists,
 * recommended playlists — all answer **signed-out**. Verified against
 * youtubei.js 17.2.0:
 *
 *   getUpNext(videoId)      -> 50 tracks, is_infinite, continuation token
 *   getRelated(videoId)     -> 6 shelves incl. Similar artists + playlists
 *   /next + continuation    -> +49 tracks per page, unbounded
 *
 * So there is no credential here: nothing to expire, nothing to re-capture.
 *
 * Everything is defensive — every export degrades to an empty result rather
 * than throwing, because the music widget must never take the dashboard down.
 */

/** 11-char video id (letters, digits, - and _). Excludes browseIds/playlistIds. */
const VIDEO_ID = /^[\w-]{11}$/;

/**
 * A radio queue is DETERMINISTIC for a given seed (measured: 49-50/50 identical
 * across repeated calls), so caching costs us no variety at all — variety comes
 * from rotating seeds, not from re-asking. That makes a long TTL free.
 */
const RADIO_TTL_MS = 60 * 60_000;
const RELATED_TTL_MS = 6 * 60 * 60_000;

interface CacheEntry<T> {
  value: T;
  at: number;
}
const radioCache = new Map<string, CacheEntry<RadioQueue>>();
const relatedCache = new Map<string, CacheEntry<RelatedShelves>>();

function cacheGet<T>(map: Map<string, CacheEntry<T>>, key: string, ttl: number): T | null {
  const hit = map.get(key);
  if (!hit || Date.now() - hit.at >= ttl) return null;
  return hit.value;
}

function cacheSet<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): void {
  // Bound the map so a long-lived warm lambda can't grow without limit.
  if (map.size > 500) map.clear();
  map.set(key, { value, at: Date.now() });
}

/** A seed's radio queue: ordered tracks plus the token that extends it. */
export interface RadioQueue {
  seedId: string;
  tracks: MusicTrack[];
  /** Opaque token for the next page; null when the queue can't be extended. */
  continuation: string | null;
}

/** The shelves `getRelated` returns — each an independent candidate source. */
export interface RelatedShelves {
  /** "You might also like" — directly playable tracks. */
  alsoLike: MusicTrack[];
  /** "Similar artists" — channel ids, the stand-in for Spotify's dead /related-artists. */
  similarArtistIds: string[];
  /** "Recommended playlists" — YouTube's editorial/algorithmic layer. */
  playlistIds: string[];
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

let clientPromise: Promise<Innertube> | null = null;

/**
 * One InnerTube client per warm process. `retrieve_player: false` skips the
 * heavy player bootstrap — we only ever browse metadata; actual playback runs
 * in the user's own browser via the YouTube IFrame player. That split matters
 * for deployment: YouTube's datacenter-IP blocking targets `/player` and
 * `api/timedtext`, not the `/next` + `/browse` metadata endpoints we use here.
 */
function getClient(): Promise<Innertube> {
  if (!clientPromise) {
    clientPromise = Innertube.create({
      retrieve_player: false,
      enable_session_cache: false,
      // Region/language for the InnerTube session. The library defaults to
      // hl='en' / gl='US'; a deployment serving a non-US audience overrides via
      // env so the region-sensitive candidate shelves (also-like / similar-
      // artist / editorial) reflect the local market instead of a US one. This
      // app is MYR-home for a Malaysia-based audience → YTM_LOCATION=MY in prod.
      // This is a REGION correction, NOT a language quota: it changes which
      // market YouTube curates for, not the script of titles nor the mix of the
      // recommendation output (the listener's taste still decides that).
      lang: process.env.YTM_LANG || undefined,
      location: process.env.YTM_LOCATION || undefined,
    }).catch((err) => {
      // Let the next call retry instead of caching a rejected promise forever.
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Thumbnails arrive in two shapes depending on the item class: radio queue
 * items expose a bare array, while shelf items (MusicResponsiveListItem,
 * artist cards) wrap it in a MusicThumbnail with a `.contents` array. Treating
 * the wrapper as an array threw and took out the whole related-shelf fetch,
 * silently costing us three of the five candidate sources.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pickThumbnail(item: any): string | null {
  const raw = item?.thumbnail;
  const thumbs: Array<{ url?: string; width?: number }> = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.contents)
      ? raw.contents
      : [];
  if (thumbs.length === 0) return null;
  const medium =
    thumbs.find((t) => (t.width ?? 0) >= 100 && (t.width ?? 0) <= 240) ?? thumbs[thumbs.length - 1];
  return medium?.url ?? null;
}

/**
 * Map any InnerTube item that carries a video id into a MusicTrack. Handles
 * PlaylistPanelVideo (radio queues), MusicResponsiveListItem and MusicTwoRowItem
 * (shelves) — they expose the id under different keys.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTrack(item: any): MusicTrack | null {
  const id: string | undefined =
    item?.video_id ?? item?.id ?? item?.endpoint?.payload?.videoId;
  if (!id || !VIDEO_ID.test(id)) return null;

  const title: string = item?.title?.toString?.() ?? item?.title?.text ?? "";
  if (!title) return null;

  const subtitle: string = item?.subtitle?.toString?.() ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artists: string | undefined = item?.artists?.map((a: any) => a?.name).filter(Boolean).join(", ");
  const channel = artists || item?.author?.name || subtitle.split("•")[0]?.trim() || "";

  return {
    videoId: id,
    // Strip the " - Topic" suffix YouTube appends to auto-generated channels.
    title,
    channel: channel.replace(/ - Topic$/, ""),
    thumbnail: pickThumbnail(item),
    source: "recommended",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tracksFrom(items: any[] | undefined): MusicTrack[] {
  if (!Array.isArray(items)) return [];
  const out: MusicTrack[] = [];
  for (const item of items) {
    // Per-item guard: InnerTube shelves are heterogeneous, and one unexpected
    // item shape must not discard the whole shelf.
    try {
      const track = toTrack(item);
      if (track) out.push(track);
    } catch {
      /* skip malformed item */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * Song radio for a seed track — the single highest-yield source (50 tracks per
 * call). This is YouTube's own next-song engine, the same one that drives the
 * mobile app's autoplay.
 */
export async function fetchRadio(seedId: string): Promise<RadioQueue> {
  if (!VIDEO_ID.test(seedId)) return { seedId, tracks: [], continuation: null };

  const cached = cacheGet(radioCache, seedId, RADIO_TTL_MS);
  if (cached) return cached;

  let queue: RadioQueue = { seedId, tracks: [], continuation: null };
  try {
    const yt = await getClient();
    const panel = await yt.music.getUpNext(seedId);
    queue = {
      seedId,
      // Drop the seed itself — it always occupies slot 0.
      tracks: tracksFrom(panel?.contents).filter((t) => t.videoId !== seedId),
      continuation: typeof panel?.continuation === "string" ? panel.continuation : null,
    };
  } catch (err) {
    console.error("[music/sources] radio failed:", seedId, (err as Error)?.message ?? err);
  }
  cacheSet(radioCache, seedId, queue);
  return queue;
}

/**
 * Extend a radio queue by one page (~49 more tracks). youtubei.js 17.2.0's
 * `TrackInfo.getUpNextContinuation()` helper throws, so we call the raw `/next`
 * endpoint with the token ourselves — verified to return a full extra page.
 */
export async function extendRadio(continuation: string): Promise<RadioQueue | null> {
  if (!continuation) return null;
  try {
    const yt = await getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await yt.actions.execute("/next", {
      client: "YTMUSIC",
      continuation,
      parse: true,
    });
    const contents = response?.continuation_contents;
    const tracks = tracksFrom(contents?.contents);
    if (tracks.length === 0) return null;
    const next = contents?.continuation;
    return {
      seedId: "",
      tracks,
      continuation: typeof next === "string" ? next : null,
    };
  } catch (err) {
    console.error("[music/sources] continuation failed:", (err as Error)?.message ?? err);
    return null;
  }
}

const SHELF_MATCHERS = {
  alsoLike: /might also like/i,
  similarArtists: /similar artists/i,
  playlists: /recommended playlists/i,
} as const;

/**
 * The `getRelated` page — three independent candidate sources in one call:
 * "You might also like" (playable), "Similar artists" (the replacement for
 * Spotify's removed /related-artists), and "Recommended playlists" (YouTube's
 * editorial layer, the analogue of Apple Music's curated shelves).
 */
export async function fetchRelated(videoId: string): Promise<RelatedShelves> {
  const empty: RelatedShelves = { alsoLike: [], similarArtistIds: [], playlistIds: [] };
  if (!VIDEO_ID.test(videoId)) return empty;

  const cached = cacheGet(relatedCache, videoId, RELATED_TTL_MS);
  if (cached) return cached;

  let shelves = empty;
  try {
    const yt = await getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const related: any = await yt.music.getRelated(videoId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sections: any[] = related?.contents ?? related?.sections ?? [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const find = (re: RegExp): any[] =>
      sections.find((s) => re.test(s?.header?.title?.toString?.() ?? s?.title?.toString?.() ?? ""))
        ?.contents ?? [];

    shelves = {
      alsoLike: tracksFrom(find(SHELF_MATCHERS.alsoLike)),
      similarArtistIds: find(SHELF_MATCHERS.similarArtists)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((a: any) => a?.id ?? a?.endpoint?.payload?.browseId)
        .filter((id: unknown): id is string => typeof id === "string" && id.startsWith("UC")),
      playlistIds: find(SHELF_MATCHERS.playlists)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((p: any) => p?.id ?? p?.endpoint?.payload?.browseId)
        .filter((id: unknown): id is string => typeof id === "string")
        // Shelf ids arrive VL-prefixed; getPlaylist wants the bare id.
        .map((id: string) => id.replace(/^VL/, "")),
    };
  } catch (err) {
    console.error("[music/sources] related failed:", videoId, (err as Error)?.message ?? err);
  }
  cacheSet(relatedCache, videoId, shelves);
  return shelves;
}

/** Tracks from a YouTube Music playlist (used for the editorial shelf). */
export async function fetchPlaylistTracks(playlistId: string, limit = 25): Promise<MusicTrack[]> {
  if (!playlistId) return [];
  try {
    const yt = await getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const playlist: any = await yt.music.getPlaylist(playlistId);
    return tracksFrom(playlist?.items ?? playlist?.contents).slice(0, limit);
  } catch (err) {
    console.error("[music/sources] playlist failed:", playlistId, (err as Error)?.message ?? err);
    return [];
  }
}

/** Top songs for an artist channel id (drawn from "Similar artists"). */
export async function fetchArtistSongs(artistId: string, limit = 10): Promise<MusicTrack[]> {
  if (!artistId) return [];
  try {
    const yt = await getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const artist: any = await yt.music.getArtist(artistId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sections: any[] = artist?.sections ?? [];
    // Prefer the explicit "Songs" shelf; otherwise take whatever shelf yields
    // playable video ids (artist pages vary by region and catalog).
    const songShelf =
      sections.find((s) => /songs/i.test(s?.header?.title?.toString?.() ?? "")) ?? null;
    const fromShelf = tracksFrom(songShelf?.contents);
    if (fromShelf.length > 0) return fromShelf.slice(0, limit);
    for (const section of sections) {
      const tracks = tracksFrom(section?.contents);
      if (tracks.length > 0) return tracks.slice(0, limit);
    }
    return [];
  } catch (err) {
    console.error("[music/sources] artist failed:", artistId, (err as Error)?.message ?? err);
    return [];
  }
}

/**
 * Resolve an artist name to its YouTube Music channel id (UC…), or null.
 *
 * The vibe surface's "top songs by X" path needs the artist's browse id — the
 * popularity-ordered Songs shelf lives there, which `fetchArtistSongs` reads.
 * The name is searched (signed-out) and the first artist channel id is returned.
 * Null on any miss/failure → the caller falls back to song-radio.
 */
export async function resolveArtistId(query: string): Promise<string | null> {
  if (!query) return null;
  try {
    const yt = await getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await yt.music.search(query, { type: "artist" });
    // youtubei.js returns either `contents` (flat) or `categories[].contents`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buckets: any[] = Array.isArray(result?.contents)
      ? result.contents
      : Array.isArray(result?.categories)
        ? result.categories.flatMap((c: any) => c?.contents ?? [])
        : [];
    for (const item of buckets) {
      const id: string | undefined =
        item?.id ?? item?.endpoint?.payload?.browseId ?? item?.browseId;
      if (typeof id === "string" && id.startsWith("UC")) return id;
    }
    return null;
  } catch (err) {
    console.error("[music/sources] artist resolve failed:", query, (err as Error)?.message ?? err);
    return null;
  }
}
