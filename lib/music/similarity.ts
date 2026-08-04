import type { Candidate } from "./types";

/**
 * Track similarity and playlist SEQUENCING — the piece that makes a queue feel
 * like Spotify rather than like a shuffled bag.
 *
 * BACKGROUND. Spotify's sequencing research (Moor et al., A/B tested at +2.52%
 * completed tracks / -2.73% skips) shows two effects dominate:
 *   · position-aware — the FIRST track decides whether a session starts at all,
 *     so it should be something the listener already trusts;
 *   · local-sequential — a listener skips a track when it jumps too far from the
 *     one before it. Adjacent tracks must be close in taste-space.
 *
 * Spotify measures "close" with audio features (energy, tempo, valence). We
 * can't: Spotify removed that API in Nov 2024 and YouTube Music never exposed
 * it. So we need a different distance.
 *
 * WHAT WE MEASURED. The obvious substitute — trusting YouTube's own radio order
 * — does not work. Against youtubei.js 17.2.0:
 *
 *     correlation(radio rank, similarity to seed) = -0.145   (≈ none)
 *     adjacent same-primary-artist in native order = 1/49 (2%)
 *     native-order path cost 4084  vs  random shuffle 2653   (worse than random)
 *
 * YouTube's radio queue is a DIVERSITY-CALIBRATED slate, not a smooth path — the
 * same job Spotify's KL-calibration does. Useful, but it is not a distance
 * ordering and must not be treated as one.
 *
 * WHAT DOES WORK. Two tracks that keep turning up in the SAME radio queues are
 * behaviourally close — that is precisely the co-listening signal Spotify's own
 * track embeddings are trained on ("close = likely listened to successively").
 * Measured overlap between radio neighbourhoods spread 0.11–0.54, i.e. it
 * discriminates. So each candidate becomes a sparse vector over the sources it
 * appeared in, and similarity is the cosine between those vectors.
 *
 * The vectors are free: we already fetch those queues for candidate generation.
 *
 * ── DO NOT ADD TIME DECAY HERE ──────────────────────────────────────────────
 * It is tempting to age-weight this graph so it "follows taste changes". Don't.
 * Koren's temporal-dynamics work (the Netflix Prize solution) tested exactly
 * that and found quality improved as decay was moderated, and was best with no
 * decay at all — underweighting old actions loses signal along with the noise,
 * which bites hardest when data per user is scarce (which is our situation).
 * His reconciliation: two items are related if users treated them similarly in
 * a short window, "even if this happened long ago".
 *
 * So the layers are split deliberately:
 *   · THIS FILE — how tracks relate to each other      → never decays
 *   · ranking.ts — what the listener wants right now   → decays (recency term)
 * Taste change is tracked by which seeds get chosen and how candidates are
 * ranked, not by corroding the relationship graph.
 */

/** Position discount — rank 0 counts most, with a long tail. */
function rankWeight(rank: number): number {
  return 1 / Math.log2(rank + 2);
}

/**
 * Sparse co-occurrence vector for a candidate, keyed by source id. This is a
 * poor-man's track embedding: the more sources two tracks share (and the higher
 * they sit in each), the closer they are.
 */
function vectorOf(candidate: Candidate): Map<string, number> {
  const vector = new Map<string, number>();
  for (const occurrence of candidate.occurrences) {
    const weight = rankWeight(occurrence.rank);
    vector.set(occurrence.sourceId, (vector.get(occurrence.sourceId) ?? 0) + weight);
  }
  return vector;
}

function norm(vector: Map<string, number>): number {
  let sum = 0;
  for (const value of vector.values()) sum += value * value;
  return Math.sqrt(sum);
}

/** Cosine similarity in [0, 1]; 0 when the two share no source. */
export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [key, value] of small) {
    const other = large.get(key);
    if (other !== undefined) dot += value * other;
  }
  if (dot === 0) return 0;
  const denominator = norm(a) * norm(b);
  return denominator === 0 ? 0 : dot / denominator;
}

/** Number of sources two co-occurrence vectors share — the "evidence" count. */
function sharedSources(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const key of small.keys()) if (large.has(key)) n++;
  return n;
}

/**
 * Sparse tag vector (genre/mood/era from `tags.ts`). Not imported from there
 * because this file stays pure (no `server-only`); the two types are
 * structurally identical (`Map<string, number>`) and interchangeable.
 */
export type TagVector = Map<string, number>;

/** Primary artist, lowercased — the unit we cap for diversity. */
function primaryArtist(channel: string): string {
  return channel.split(",")[0]!.trim().toLowerCase();
}

export interface SequenceOptions {
  /**
   * Penalty applied when a track would follow another by the same artist.
   * YouTube's own slates keep this at ~2%, so we discourage it too rather than
   * letting pure similarity clump an artist's catalogue together.
   */
  sameArtistPenalty?: number;
  /**
   * Per-transition adjustment learned from the listener's own skips, keyed
   * `${fromVideoId}>${toVideoId}`. Negative values push a transition down.
   * This is the slot where personal taste converges over time — the same way
   * Spotify learned its local-sequential model, from logged behaviour.
   */
  transitionBias?: Map<string, number>;
  /**
   * LLM tag vectors (genre/mood/era) per videoId — the cold-start prior. When
   * two tracks share NO co-occurrence source, their tag cosine fills in so the
   * sequencer can still place them next to taste-neighbours. The instant any
   * co-occurrence overlap exists the behavioural signal takes over (it is the
   * asset, never decayed). Omit to run pure co-occurrence (the original path).
   */
  tagVectors?: Map<string, TagVector>;
  /** Scale applied to the tag term (default 1). Lower ⇒ trust the prior less. */
  priorScale?: number;
}

/**
 * Order candidates into a smooth listening path.
 *
 * Greedy nearest-neighbour over the co-occurrence cosine, starting from
 * `openerIndex` (position-aware: the caller passes something familiar). At each
 * step we take the most similar unused track, minus an artist-repeat penalty
 * and plus any learned per-transition bias.
 *
 * Greedy rather than optimal on purpose: this runs per request on a pool of a
 * few hundred, and the exact-TSP gain is not worth the latency.
 */
export function sequence(
  candidates: Candidate[],
  openerIndex = 0,
  options: SequenceOptions = {},
): Candidate[] {
  if (candidates.length <= 2) return [...candidates];

  const { sameArtistPenalty = 0.35, transitionBias, tagVectors, priorScale = 1 } = options;
  const coVectors = candidates.map(vectorOf);
  const artists = candidates.map((c) => primaryArtist(c.track.channel));

  // Behavioural (co-occurrence) similarity blended with the LLM tag prior. The
  // prior fills in ONLY where co-occurrence is silent (two tracks sharing no
  // source) and fades the instant any overlap exists — the learned graph is the
  // asset and must stay ascendant (see the no-decay note atop this file).
  const tagOf = (i: number): TagVector | undefined =>
    tagVectors?.get(candidates[i]!.track.videoId);
  const pairSimilarity = (i: number, j: number): number => {
    const co = cosine(coVectors[i]!, coVectors[j]!);
    const ta = tagOf(i);
    const tb = tagOf(j);
    if (!ta || ta.size === 0 || !tb || tb.size === 0) return co; // no prior available
    const tsim = cosine(ta, tb);
    if (tsim === 0) return co;
    const evidence = sharedSources(coVectors[i]!, coVectors[j]!);
    const wPrior = evidence === 0 ? 1 : 1 / (1 + evidence);
    return (1 - wPrior) * co + wPrior * tsim * priorScale;
  };

  const remaining = new Set(candidates.map((_, i) => i));
  const start = openerIndex >= 0 && openerIndex < candidates.length ? openerIndex : 0;
  const order = [start];
  remaining.delete(start);

  while (remaining.size > 0) {
    const currentIndex = order[order.length - 1]!;
    let best = -1;
    let bestScore = -Infinity;

    for (const candidateIndex of remaining) {
      let score = pairSimilarity(currentIndex, candidateIndex);
      if (artists[currentIndex] && artists[currentIndex] === artists[candidateIndex]) {
        score -= sameArtistPenalty;
      }
      if (transitionBias) {
        const key = `${candidates[currentIndex]!.track.videoId}>${candidates[candidateIndex]!.track.videoId}`;
        score += transitionBias.get(key) ?? 0;
      }
      if (score > bestScore) {
        bestScore = score;
        best = candidateIndex;
      }
    }

    // Every remaining candidate scored -Infinity only if the set is empty, which
    // the loop guard already excludes; fall back to arbitrary order defensively.
    if (best < 0) best = remaining.values().next().value as number;
    order.push(best);
    remaining.delete(best);
  }

  return order.map((i) => candidates[i]!);
}

/**
 * Mean adjacent similarity of an ordering — the smoothness metric from Spotify's
 * local-sequential model. Exposed so the sequencing can be regression-tested
 * (a good ordering must beat the same tracks shuffled).
 */
export function pathSmoothness(candidates: Candidate[]): number {
  if (candidates.length < 2) return 0;
  const vectors = candidates.map(vectorOf);
  let total = 0;
  for (let i = 1; i < vectors.length; i++) {
    total += cosine(vectors[i - 1]!, vectors[i]!);
  }
  return total / (vectors.length - 1);
}
