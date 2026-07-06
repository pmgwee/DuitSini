/** A playable track — the shared currency of the music widget and /api/yt/*. */
export interface MusicTrack {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string | null;
}

/** A playlist on the user's YouTube (Music) account. */
export interface MusicPlaylist {
  id: string;
  title: string;
  itemCount: number;
  thumbnail: string | null;
}
