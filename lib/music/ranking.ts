import type { Candidate, CandidateOrigin, HistoryEntry } from "./types";

/**
 * Source-evidence relevance and seed selection — the retrieval-facing half
 * of ranking. Listener state (affinity, exposure, readiness, language) lives in
 * `objective.ts`, which decides what is actually served.
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
  liked: 0.9, // the listener said yes to this one outright
  history: 0, // never scored as a discovery candidate
};

/** Position discount within a source. Kept identical to `similarity.ts`. */
function rankWeight(rank: number): number {
  return 1 / Math.log2(rank + 2);
}

const DAY_MS = 86_400_000;

/**
 * Source-evidence relevance — "how strongly does retrieval associate this track
 * with what the listener reaches for", and nothing else.
 *
 * This deliberately no longer folds in play counts, likes or recency. Those are
 * listener-state terms and they now live in `objective.ts`, where they are
 * bounded and gated by repeat readiness. Keeping them here was the structural
 * error: affinity entered as an UNBOUNDED multiplier while the only freshness
 * term was capped at 1, so accumulated history could always outrun it. A
 * ranker cannot be made fresh by tuning constants inside that shape.
 */
export function relevance(candidate: Candidate): number {
  let base = 0;
  const sources = new Set<string>();

  for (const occurrence of candidate.occurrences) {
    sources.add(occurrence.sourceId);
    base += ORIGIN_WEIGHT[occurrence.origin] * occurrence.seedWeight * rankWeight(occurrence.rank);
  }

  // Agreement across independent sources is worth more than depth in one.
  return base * (1 + Math.log2(sources.size));
}

export function primaryArtist(channel: string): string {
  return channel.split(",")[0]!.trim().toLowerCase();
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
export interface SeedOptions {
  random?: () => number;
  likes?: ReadonlySet<string>;
  /**
   * videoId -> epoch ms this seed was last used to generate a shelf.
   *
   * A song radio is deterministic per seed (measured 49-50/50 identical across
   * calls), so reusing a seed regenerates the same neighbourhood. Without a
   * cooldown the highest-weight seeds win every build and the candidate pool
   * barely moves, which no amount of re-ranking downstream can repair.
   */
  seedCooldown?: ReadonlyMap<string, number>;
  /** Hours before a used seed returns to full weight. */
  cooldownHours?: number;
}

export function pickSeeds(
  history: HistoryEntry[],
  count: number,
  now: number,
  options: SeedOptions = {},
): HistoryEntry[] {
  const {
    random = Math.random,
    likes = new Set<string>(),
    seedCooldown,
    cooldownHours = 36,
  } = options;
  if (history.length === 0) return [];
  if (history.length <= count) return [...history];

  const cooldownFactor = (videoId: string): number => {
    const usedAt = seedCooldown?.get(videoId);
    if (usedAt === undefined) return 1;
    const hours = (now - usedAt) / 3_600_000;
    if (hours >= cooldownHours) return 1;
    // Never zero: a seed the listener loves should return, just not next build.
    return Math.max(0.1, hours / cooldownHours);
  };

  const weightOf = (entry: HistoryEntry): number => {
    const skipPenalty = Math.pow(0.4, entry.skipCount);
    const cooldown = cooldownFactor(entry.videoId);
    // A liked track is the clearest statement of taste we have, so it is a
    // disproportionately good place to start a neighbourhood from. Likes do not
    // decay (a heart is a permanent statement), so a liked track's seed weight
    // does NOT decay with recency either — otherwise older liked minority-taste
    // tracks get buried under recent majority plays and stop surfacing.
    if (likes.has(entry.videoId)) {
      return Math.max(0.01, entry.playCount * skipPenalty * cooldown * 3);
    }
    const daysSince = (now - Date.parse(entry.lastPlayedAt)) / DAY_MS;
    const recency = Number.isFinite(daysSince) ? 1 / (1 + Math.max(0, daysSince) / 7) : 0.5;
    return Math.max(0.01, entry.playCount * recency * skipPenalty * cooldown);
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
    // Prefer a seed that is not on cooldown, so the bubble-breaking slot does
    // not spend itself regenerating last build's neighbourhood.
    const eligible = pool.filter((p) => cooldownFactor(p.entry.videoId) >= 1);
    const field = eligible.length > 0 ? eligible : pool;
    const oldest = field.reduce((a, b) =>
      Date.parse(a.entry.lastPlayedAt) <= Date.parse(b.entry.lastPlayedAt) ? a : b,
    );
    picked.push(oldest.entry);
  }

  return picked;
}
