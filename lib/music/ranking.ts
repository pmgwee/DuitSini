import type { MusicTrack } from "@/types/music";
import type { Candidate, CandidateOrigin, HistoryEntry } from "./types";

/**
 * Scoring and slate assembly — the ranking stage of the recommender.
 *
 * Both Spotify and Apple Music run the same two-stage shape: cheap candidate
 * generation for recall, then a ranker that decides what the listener actually
 * sees. `sources.ts` does stage one; this is stage two.
 *
 * The signal hierarchy mirrors what both platforms publish about their own
 * weighting: an explicit save outranks a completed play, a completed play
 * outranks a start, and a skip inside the first 30 seconds is the strongest
 * negative signal available. Apple states library-add is its single
 * highest-weight action; Spotify's BaRT treats a <30s skip as the penalty term.
 */

/** How much to trust each source. Personal signals outrank broad ones. */
const ORIGIN_WEIGHT: Record<CandidateOrigin, number> = {
  radio: 1, // seeded by a track the listener actually played
  "also-like": 0.85, // YouTube's own "more like this"
  "similar-artist": 0.6, // one hop out — adjacent taste
  editorial: 0.45, // broad curation, least personal
  history: 0, // never scored as a discovery candidate
};

/** Position discount within a source. Kept identical to `similarity.ts`. */
function rankWeight(rank: number): number {
  return 1 / Math.log2(rank + 2);
}

const DAY_MS = 86_400_000;

export interface ScoreContext {
  /** Everything the listener has played, keyed by videoId. */
  history: Map<string, HistoryEntry>;
  /** Evaluation time; injected so scoring stays deterministic under test. */
  now: number;
}

/**
 * Score a candidate. Higher is better.
 *
 * Base score is the evidence sum: every occurrence contributes its source's
 * trust × the seed's own weight × a positional discount. A track surfacing
 * under SEVERAL independent sources gets a multiplicative boost — in probing,
 * multi-source hits were consistently the strongest picks, which matches the
 * collaborative-filtering intuition that agreement across neighbourhoods means
 * more than depth within one.
 */
export function score(candidate: Candidate, context: ScoreContext): number {
  let base = 0;
  const sources = new Set<string>();

  for (const occurrence of candidate.occurrences) {
    sources.add(occurrence.sourceId);
    base += ORIGIN_WEIGHT[occurrence.origin] * occurrence.seedWeight * rankWeight(occurrence.rank);
  }

  // Agreement across independent sources is worth more than depth in one.
  base *= 1 + Math.log2(sources.size);

  const seen = context.history.get(candidate.track.videoId);
  if (seen) {
    // Recency penalty: something played in the last few days is exactly what the
    // listener is trying to escape. Decays back to neutral over ~2 weeks.
    const daysSince = (context.now - Date.parse(seen.lastPlayedAt)) / DAY_MS;
    if (Number.isFinite(daysSince)) {
      base *= Math.min(1, Math.max(0.05, daysSince / 14));
    }

    // Skip penalty — the strongest negative signal both platforms use. Each
    // early skip roughly halves the score; two skips effectively bury it.
    if (seen.skipCount > 0) base *= Math.pow(0.45, seen.skipCount);

    // Completions are a genuine positive, but a modest one: we're building a
    // discovery shelf, not a replay shelf.
    if (seen.completeCount > 0) base *= 1 + Math.min(0.5, seen.completeCount * 0.1);
  }

  return base;
}

export interface AssembleOptions {
  limit: number;
  /**
   * Share of slots handed to deliberate exploration rather than the top of the
   * ranking. Spotify's BaRT uses an epsilon-greedy policy for exactly this
   * reason: pure exploitation is what makes a shelf feel stale after a week.
   */
  epsilon?: number;
  /** Max tracks per primary artist, so one artist can't dominate the slate. */
  maxPerArtist?: number;
  /** Pinned first entry — position-aware sequencing wants a familiar opener. */
  opener?: MusicTrack | null;
  /** Injectable RNG so assembly can be tested deterministically. */
  random?: () => number;
}

function primaryArtist(channel: string): string {
  return channel.split(",")[0]!.trim().toLowerCase();
}

/**
 * Pick the final slate from a scored pool.
 *
 * Exploitation fills most slots from the top of the ranking. The remaining
 * `epsilon` share is drawn at random from the LONG TAIL of the pool — guided
 * exploration, not chaos: everything in the pool already survived candidate
 * generation, so a tail pick is still taste-adjacent.
 */
export function assemble(
  scored: Array<{ candidate: Candidate; value: number }>,
  options: AssembleOptions,
): Candidate[] {
  const {
    limit,
    epsilon = 0.12,
    maxPerArtist = 3,
    opener = null,
    random = Math.random,
  } = options;

  const ranked = [...scored].sort((a, b) => b.value - a.value);
  const chosen: Candidate[] = [];
  const usedIds = new Set<string>();
  const artistCounts = new Map<string, number>();

  if (opener) {
    chosen.push({ track: opener, occurrences: [] });
    usedIds.add(opener.videoId);
    artistCounts.set(primaryArtist(opener.channel), 1);
  }

  const take = (entry: { candidate: Candidate }): boolean => {
    const { track } = entry.candidate;
    if (usedIds.has(track.videoId)) return false;
    const artist = primaryArtist(track.channel);
    if (artist && (artistCounts.get(artist) ?? 0) >= maxPerArtist) return false;
    chosen.push(entry.candidate);
    usedIds.add(track.videoId);
    if (artist) artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    return true;
  };

  const exploreSlots = Math.floor(limit * epsilon);
  const exploitTarget = limit - exploreSlots;

  // Exploit: walk the ranking top-down until the quota is met.
  for (const entry of ranked) {
    if (chosen.length >= exploitTarget) break;
    take(entry);
  }

  // Explore: sample from the tail (anything the exploit pass didn't reach).
  const tail = ranked.filter((e) => !usedIds.has(e.candidate.track.videoId));
  let guard = tail.length;
  while (chosen.length < limit && tail.length > 0 && guard-- > 0) {
    const index = Math.floor(random() * tail.length);
    const [entry] = tail.splice(index, 1);
    if (entry) take(entry);
  }

  // Backfill if the artist cap starved the slate (small pools, one-artist seeds).
  if (chosen.length < limit) {
    for (const entry of ranked) {
      if (chosen.length >= limit) break;
      if (usedIds.has(entry.candidate.track.videoId)) continue;
      chosen.push(entry.candidate);
      usedIds.add(entry.candidate.track.videoId);
    }
  }

  return chosen.slice(0, limit);
}

/**
 * Choose seeds to generate candidates from.
 *
 * Weighted by play count and recency, but deliberately spread: taking the top-N
 * most-played tracks would keep regenerating the same neighbourhood, which is
 * the loop we're trying to break. So we sample proportional to weight and force
 * one seed from the tail of the history — a cheap stand-in for the contextual
 * diversity Spotify gets from its session embeddings.
 */
export function pickSeeds(
  history: HistoryEntry[],
  count: number,
  now: number,
  random: () => number = Math.random,
): HistoryEntry[] {
  if (history.length === 0) return [];
  if (history.length <= count) return [...history];

  const weightOf = (entry: HistoryEntry): number => {
    const daysSince = (now - Date.parse(entry.lastPlayedAt)) / DAY_MS;
    const recency = Number.isFinite(daysSince) ? 1 / (1 + Math.max(0, daysSince) / 7) : 0.5;
    const skipPenalty = Math.pow(0.4, entry.skipCount);
    return Math.max(0.01, entry.playCount * recency * skipPenalty);
  };

  const pool = history.map((entry) => ({ entry, weight: weightOf(entry) }));
  const picked: HistoryEntry[] = [];

  // Reserve the last slot for a deliberate long-tail pick.
  const weightedSlots = Math.max(1, count - 1);
  for (let i = 0; i < weightedSlots && pool.length > 0; i++) {
    const total = pool.reduce((sum, p) => sum + p.weight, 0);
    let threshold = random() * total;
    let index = 0;
    for (; index < pool.length - 1; index++) {
      threshold -= pool[index]!.weight;
      if (threshold <= 0) break;
    }
    picked.push(pool[index]!.entry);
    pool.splice(index, 1);
  }

  // The tail pick: least-recently-played survivor, to break out of the bubble.
  if (picked.length < count && pool.length > 0) {
    const oldest = pool.reduce((a, b) =>
      Date.parse(a.entry.lastPlayedAt) <= Date.parse(b.entry.lastPlayedAt) ? a : b,
    );
    picked.push(oldest.entry);
  }

  return picked;
}
