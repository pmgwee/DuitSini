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
