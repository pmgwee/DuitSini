import type { MusicTrack } from "@/types/music";

/** Where a candidate came from. Used for weighting and for UI provenance. */
export type CandidateOrigin =
  | "radio" // song radio for a seed the user actually played
  | "also-like" // "You might also like" shelf
  | "similar-artist" // top songs of an artist adjacent to the user's taste
  | "editorial" // YouTube's recommended-playlist shelf
  | "history"; // the user's own play history

/** One appearance of a track in one source, at a given position. */
export interface Occurrence {
  /** Seed videoId, artist channel id, or playlist id — identifies the source. */
  sourceId: string;
  origin: CandidateOrigin;
  /** 0-based position within that source. Lower = more strongly associated. */
  rank: number;
  /** How much the seed itself is worth (e.g. play count of the seed track). */
  seedWeight: number;
}

/**
 * A track under consideration, plus the evidence for it. The occurrence list is
 * what makes ranking explainable — and it doubles as the co-occurrence vector
 * used for similarity (see `similarity.ts`).
 */
export interface Candidate {
  track: MusicTrack;
  occurrences: Occurrence[];
}

/** A track the listener explicitly liked. Carries its own metadata so the
 *  Liked shelf renders without needing a matching play row. */
export interface LikedTrack {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  /** ISO timestamp. Used for shelf ordering, NOT for decaying the like itself. */
  likedAt: string;
}

/**
 * Tracks the listener has pushed away.
 *
 * `notInterested` is permanent; `snoozedUntil` lapses on its own. Both are
 * filtered out of candidate generation entirely rather than merely down-ranked
 * — a listener who says "not this" should not have to say it twice.
 */
export interface Suppressions {
  notInterested: Set<string>;
  /** videoId -> ISO timestamp the snooze expires. */
  snoozedUntil: Map<string, string>;
}

/** A track the user has played, with the behavioural signals we've logged. */
export interface HistoryEntry {
  videoId: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  playCount: number;
  /** ISO timestamp of the most recent play. */
  lastPlayedAt: string;
  /** Times the user skipped this within the first 30s — the strongest negative. */
  skipCount: number;
  /** Times it was played to completion — the strongest passive positive. */
  completeCount: number;
}
