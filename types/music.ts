/** A playable track — the shared currency of the music widget and /api/yt/*. */
export interface MusicTrack {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  /**
   * Origin of the track within the "Listen again" shelf. Undefined for the
   * user's local play history (the recency-first default); `"recommended"` for
   * tracks pulled from YouTube Music's algorithmic shelf via the opt-in cookie
   * connection. Only recommended rows show a badge.
   */
  source?: "local" | "recommended";
}

/** A playlist on the user's YouTube (Music) account. */
export interface MusicPlaylist {
  id: string;
  title: string;
  itemCount: number;
  thumbnail: string | null;
}
