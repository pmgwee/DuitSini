import type { MusicPlaylist, MusicTrack } from "@/types/music";

/**
 * Official YouTube Data API v3 calls, OAuth-authorized (user context).
 * Both endpoints cost 1 quota unit per call — cheap next to search's 100.
 */

const API_BASE = "https://www.googleapis.com/youtube/v3";

/** Playlist ID YouTube Music uses for "Liked Music"; `LL` = liked videos. */
export const LIKED_MUSIC_ID = "LM";
const LIKED_VIDEOS_ID = "LL";

interface PlaylistsResponse {
  items?: Array<{
    id?: string;
    snippet?: { title?: string; thumbnails?: { medium?: { url?: string } } };
    contentDetails?: { itemCount?: number };
  }>;
}

interface PlaylistItemsResponse {
  items?: Array<{
    snippet?: {
      title?: string;
      videoOwnerChannelTitle?: string;
      thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
      resourceId?: { videoId?: string };
    };
  }>;
}

async function ytGet(path: string, params: Record<string, string>, accessToken: string) {
  const url = new URL(`${API_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
}

/** The user's own playlists (includes playlists created in YouTube Music). */
export async function listMyPlaylists(accessToken: string): Promise<MusicPlaylist[] | null> {
  const resp = await ytGet(
    "playlists",
    { part: "snippet,contentDetails", mine: "true", maxResults: "50" },
    accessToken,
  );
  if (!resp.ok) return null;
  const json = (await resp.json()) as PlaylistsResponse;
  return (json.items ?? [])
    .filter((p) => Boolean(p.id))
    .map((p) => ({
      id: p.id as string,
      title: p.snippet?.title ?? "Untitled",
      itemCount: p.contentDetails?.itemCount ?? 0,
      thumbnail: p.snippet?.thumbnails?.medium?.url ?? null,
    }));
}

/**
 * Tracks in a playlist. For Liked Music (`LM`) some accounts 404 — we fall
 * back to liked videos (`LL`). Deleted/private entries are filtered out.
 */
export async function listPlaylistTracks(
  accessToken: string,
  playlistId: string,
): Promise<MusicTrack[] | null> {
  let resp = await ytGet(
    "playlistItems",
    { part: "snippet", playlistId, maxResults: "50" },
    accessToken,
  );
  if (!resp.ok && playlistId === LIKED_MUSIC_ID) {
    resp = await ytGet(
      "playlistItems",
      { part: "snippet", playlistId: LIKED_VIDEOS_ID, maxResults: "50" },
      accessToken,
    );
  }
  if (!resp.ok) return null;

  const json = (await resp.json()) as PlaylistItemsResponse;
  return (json.items ?? [])
    .filter(
      (it) =>
        Boolean(it.snippet?.resourceId?.videoId) &&
        it.snippet?.title !== "Deleted video" &&
        it.snippet?.title !== "Private video",
    )
    .map((it) => ({
      videoId: it.snippet!.resourceId!.videoId as string,
      title: it.snippet?.title ?? "Untitled",
      channel: (it.snippet?.videoOwnerChannelTitle ?? "").replace(/ - Topic$/, ""),
      thumbnail:
        it.snippet?.thumbnails?.medium?.url ?? it.snippet?.thumbnails?.default?.url ?? null,
    }));
}
