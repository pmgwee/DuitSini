import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getGoogleAccessToken } from "@/lib/google/tokens";
import { LIKED_MUSIC_ID, listMyPlaylists } from "@/lib/google/youtube";
import type { MusicPlaylist } from "@/types/music";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface LibraryResponse {
  /** False when the user hasn't granted the YouTube scope (or revoked it). */
  connected: boolean;
  playlists: MusicPlaylist[];
}

/**
 * The signed-in user's YouTube (Music) playlists via the official Data API,
 * with "Liked Music" pinned first. `connected: false` is a normal state — the
 * widget renders a "connect with Google" hint, not an error.
 */
export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ connected: false, playlists: [] }, { status: 401 });
  }

  const token = await getGoogleAccessToken(user.id);
  if (!token) {
    return NextResponse.json<LibraryResponse>({ connected: false, playlists: [] });
  }

  const playlists = await listMyPlaylists(token);
  if (playlists === null) {
    // Token was valid but the API refused (scope missing / API not enabled).
    return NextResponse.json<LibraryResponse>({ connected: false, playlists: [] });
  }

  const liked: MusicPlaylist = {
    id: LIKED_MUSIC_ID,
    title: "Liked Music",
    itemCount: 0,
    thumbnail: null,
  };
  return NextResponse.json<LibraryResponse>({ connected: true, playlists: [liked, ...playlists] });
}
