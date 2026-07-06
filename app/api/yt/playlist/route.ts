import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getGoogleAccessToken } from "@/lib/google/tokens";
import { listPlaylistTracks } from "@/lib/google/youtube";
import type { MusicTrack } from "@/types/music";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface PlaylistTracksResponse {
  tracks: MusicTrack[];
}

/** Tracks of one of the user's playlists (`?id=`), via the official Data API. */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id")?.trim();
  if (!id || !/^[\w-]{1,64}$/.test(id)) {
    return NextResponse.json({ tracks: [], error: "bad id" }, { status: 400 });
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ tracks: [] }, { status: 401 });

  const token = await getGoogleAccessToken(user.id);
  if (!token) return NextResponse.json({ tracks: [], error: "not connected" }, { status: 409 });

  const tracks = await listPlaylistTracks(token, id);
  if (tracks === null) {
    return NextResponse.json({ tracks: [], error: "youtube" }, { status: 502 });
  }
  return NextResponse.json<PlaylistTracksResponse>({ tracks });
}
