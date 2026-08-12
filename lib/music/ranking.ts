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
  "artist-catalog": 0.95, // the named artist's own Songs shelf (vibe "top songs by X")
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

/**
 * Confidence weighting, after Hu, Koren & Volinsky (2008), "Collaborative
 * Filtering for Implicit Feedback Datasets".
 *
 * Their central insight is that an interaction carries TWO magnitudes, not one:
 *
 *   preference  p = 1 if the listener engaged at all   (binary)
 *   confidence  c = 1 + α·r                            (how sure we are)
 *
 * This is why a like is not modelled as "a bigger positive". Once a track has
 * been played, preference is already 1 — a like cannot raise it. What a like
 * does is collapse the ambiguity: a play can mean "I left it on", whereas a like
 * can only mean "yes". So it dominates the confidence term instead.
 *
 * Skips enter as NEGATIVE evidence rather than as absence. The reference
 * implementation of this paper (benfred/implicit) does the same thing — it
 * accepts negative confidence values to express "the user disliked this" — which
 * is exactly what a sub-30-second abandon tells us.
 */
const ALPHA = 1.4; // rate at which evidence converts into confidence
const W_LIKE = 1; // one like ≈ five completed plays of certainty
const W_COMPLETE = 0.2;
const W_PLAY = 0.06;
const W_SKIP = 0.55; // subtracted — a skip actively lowers confidence
const PLAY_CAP = 12; // beyond this, extra plays say little we don't know
/** Confidence can go negative; clamp so a buried track can still be explored. */
const MIN_CONFIDENCE = 0.05;

export interface ScoreContext {
  /** Everything the listener has played, keyed by videoId. */
  history: Map<string, HistoryEntry>;
  /** Explicitly liked videoIds — the least ambiguous signal available. */
  likes: Set<string>;
  /** Evaluation time; injected so scoring stays deterministic under test. */
  now: number;
}

/**
 * `c = 1 + α·r` for one track, given everything we know about it.
 *
 * Returns ≥ MIN_CONFIDENCE. A value below 1 means the evidence is net-negative
 * (skipped more than enjoyed) and the track should rank below an unknown one —
 * which is correct: an unknown track is a fair bet, a repeatedly-skipped one
 * is not.
 */
export function confidence(
  videoId: string,
  context: Pick<ScoreContext, "history" | "likes">,
): number {
  const entry = context.history.get(videoId);
  let evidence = 0;

  if (context.likes.has(videoId)) evidence += W_LIKE;
  if (entry) {
    evidence += entry.completeCount * W_COMPLETE;
    evidence += Math.min(entry.playCount, PLAY_CAP) * W_PLAY;
    evidence -= entry.skipCount * W_SKIP;
  }

  return Math.max(MIN_CONFIDENCE, 1 + ALPHA * evidence);
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

  // Confidence subsumes what used to be three ad-hoc multipliers (skip penalty,
  // completion bonus, and an implicit like bonus) into the single principled
  // term above. Likes, completions and plays raise it; skips lower it.
  base *= confidence(candidate.track.videoId, context);

  // Recency: this is the ONE place decay belongs — it is a claim about what the
  // listener wants *now*, not about how tracks relate to each other. (The
  // co-occurrence graph in `similarity.ts` is deliberately never decayed; see
  // the note there.) Something played hours ago is what they're trying to
  // escape; the penalty relaxes back to neutral over ~2 weeks.
  const seen = context.history.get(candidate.track.videoId);
  if (seen) {
    const daysSince = (context.now - Date.parse(seen.lastPlayedAt)) / DAY_MS;
    if (Number.isFinite(daysSince)) {
      // A liked track gets a gentler floor: we still don't want it on repeat,
      // but burying something they explicitly asked for reads as a bug.
      const floor = context.likes.has(candidate.track.videoId) ? 0.35 : 0.05;
      base *= Math.min(1, Math.max(floor, daysSince / 14));
    }
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
 * the loop we're trying to break. So each slot samples proportional to weight
 * but preferentially among entries whose primary artist isn't yet represented
 * (coverage-biased), plus one oldest-played tail pick — a cheap stand-in for
 * the contextual diversity Spotify gets from its session embeddings. The
 * coverage bias is what makes a minority taste cluster (e.g. a Chinese cluster
 * inside an English-majority history) actually contribute seeds instead of
 * being outvoted by the mode.
 */
export function pickSeeds(
  history: HistoryEntry[],
  count: number,
  now: number,
  random: () => number = Math.random,
  likes: Set<string> = new Set(),
): HistoryEntry[] {
  if (history.length === 0) return [];
  if (history.length <= count) return [...history];

  const weightOf = (entry: HistoryEntry): number => {
    const daysSince = (now - Date.parse(entry.lastPlayedAt)) / DAY_MS;
    const recency = Number.isFinite(daysSince) ? 1 / (1 + Math.max(0, daysSince) / 7) : 0.5;
    const skipPenalty = Math.pow(0.4, entry.skipCount);
    // A liked track is the clearest statement of taste we have, so it is a
    // disproportionately good place to start a neighbourhood from.
    const likeBoost = likes.has(entry.videoId) ? 3 : 1;
    return Math.max(0.01, entry.playCount * recency * skipPenalty * likeBoost);
  };

  const pool = history.map((entry) => ({
    entry,
    weight: weightOf(entry),
    artist: primaryArtist(entry.channel),
  }));
  const picked: HistoryEntry[] = [];
  const pickedArtists = new Set<string>();

  // Coverage-biased sampling. Each weighted slot samples proportional to
  // importance, but preferentially among entries whose primary artist isn't
  // represented yet — so a draw SPANS taste clusters (an English-majority
  // history with a Chinese minority yields seeds from BOTH) instead of
  // weighted-proportional sampling landing most slots in the mode. Stays
  // stochastic so variety across builds is preserved; falls back to the full
  // pool once every visible artist is already covered. The last slot is held
  // back for a deliberate long-tail pick below.
  const weightedSlots = Math.max(1, count - 1);
  for (let i = 0; i < weightedSlots && pool.length > 0; i++) {
    const uncovered = pool.filter((p) => !pickedArtists.has(p.artist));
    const field = uncovered.length > 0 ? uncovered : pool;
    const total = field.reduce((sum, p) => sum + p.weight, 0);
    let threshold = random() * total;
    let index = 0;
    for (; index < field.length - 1; index++) {
      threshold -= field[index]!.weight;
      if (threshold <= 0) break;
    }
    const choice = field[index]!;
    picked.push(choice.entry);
    pickedArtists.add(choice.artist);
    pool.splice(pool.indexOf(choice), 1);
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
