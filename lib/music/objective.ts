import type { MusicTrack } from "@/types/music";
import {
  groupPressure,
  noveltyClass,
  repeatReadiness,
  enjoyment,
  type ExposureRecord,
  type NoveltyClass,
} from "./exposure";
import { languageFit, type LanguageLabel, type VocalLanguage } from "./language";
import { primaryArtist } from "./ranking";
import type { Candidate } from "./types";

/**
 * The serving objective: what should be on the shelf *now*.
 *
 * The previous ranker multiplied source evidence by an unbounded confidence
 * term and a linear recency term that reached neutral at fourteen days. Because
 * confidence could exceed 1 without limit while recency was capped at 1, a
 * track with ordinary positive history overtook an equivalent unseen track by
 * about day seven — measured at 96.9% repeats by day twenty. No amount of
 * constant-tuning fixes that shape: it is a consequence of an unbounded
 * multiplier racing a bounded one.
 *
 * So affinity is now bounded and readiness is a real gate:
 *
 *   utility = relevance × (affinity × readiness + discoveryBonus)
 *           + languageFit − groupFatigue
 *
 * with `affinity ∈ [1, 1+AFFINITY_RANGE]` and `readiness ∈ [0, 1]`. An unseen
 * track always has readiness 1 and collects the discovery bonus, so a familiar
 * track must be *genuinely* repeat-ready to outrank it rather than merely
 * well-played. Every term is returned in the breakdown so a slot is always
 * explainable.
 */

/** Ceiling on how much accumulated affinity can lift a track. */
const AFFINITY_RANGE = 0.8;
/** Flat bonus for a track this listener has never played. */
const DISCOVERY_BONUS = 0.45;
/** How strongly an under-served language pulls a candidate up. */
const LANGUAGE_WEIGHT = 0.3;
/** How strongly artist/cluster concentration pushes a candidate down. */
const FATIGUE_WEIGHT = 0.6;

export type SlatePool =
  | "familiar-anchor"
  | "loved"
  | "rediscovery"
  | "adjacent-discovery"
  | "cross-discovery"
  | "exploration";

export const DISCOVERY_POOLS: readonly SlatePool[] = [
  "adjacent-discovery",
  "cross-discovery",
  "exploration",
];

/**
 * Slate composition, as fractions so it scales with any shelf size.
 *
 * Discovery takes 80%. The remaining fifth is split deliberately, because
 * "familiar" is not one thing: a track the listener HEARTED and a track that
 * happened to autoplay past them are different claims, and pooling them is why
 * likes vanished from the shelf. Measured on a real account: 54 likes against
 * 680 played tracks, all competing for one 15% familiar allowance, put exactly
 * ONE liked song on a 40-slot shelf — likes were losing on volume to their own
 * play history.
 *
 * `loved` is therefore reserved and cannot be won by an unhearted track, which
 * is what makes the guarantee hold as the play history keeps growing.
 */
export const DEFAULT_QUOTAS: Readonly<Record<SlatePool, number>> = {
  "familiar-anchor": 0.05,
  loved: 0.1,
  rediscovery: 0.05,
  "adjacent-discovery": 0.38,
  "cross-discovery": 0.22,
  exploration: 0.2,
};

export interface ListenerState {
  /** Durable exposure memory, keyed by videoId. */
  exposure: ReadonlyMap<string, ExposureRecord>;
  likes: ReadonlySet<string>;
  now: number;
  /** Language labels for candidates, where known. */
  languages?: ReadonlyMap<string, LanguageLabel>;
  /** Learned soft language mix. Empty means "no opinion yet". */
  languageTarget?: ReadonlyMap<VocalLanguage, number>;
  /**
   * Semantic cluster key per track. Defaults to the primary artist, which is a
   * weak proxy — a real cluster key (tag centroid) is supplied when available.
   */
  clusterOf?: (track: MusicTrack) => string;
  /** Artists the listener has explicitly liked; their cap is relaxed. */
  endorsedArtists?: ReadonlySet<string>;
  /**
   * Candidates that exist purely to widen retrieval — from under-exposed
   * clusters or cross-language bridges. Marked at generation time because a
   * ranker cannot tell "outside the bubble" from "badly matched" after the fact.
   */
  explorationIds?: ReadonlySet<string>;
}

export interface UtilityBreakdown {
  relevance: number;
  affinity: number;
  readiness: number;
  discovery: number;
  language: number;
  fatigue: number;
  total: number;
  novelty: NoveltyClass;
  pool: SlatePool;
  language_label: VocalLanguage;
}

export interface ScoredCandidate {
  candidate: Candidate;
  /** Source-evidence relevance, from `ranking.score`'s occurrence term. */
  value: number;
}

function labelOf(state: ListenerState, videoId: string): VocalLanguage {
  return state.languages?.get(videoId)?.language ?? "unknown";
}

/**
 * Which pool does this candidate belong to?
 *
 * A track's pool is a fact about the listener's relationship to it, decided
 * before any competition for slots, so the quotas below cannot be silently
 * satisfied by relabeling.
 */
export function classifyPool(
  candidate: Candidate,
  state: ListenerState,
  dominantLanguage: VocalLanguage | null,
): SlatePool {
  const id = candidate.track.videoId;
  const record = state.exposure.get(id);
  const liked = state.likes.has(id);
  const novelty = noveltyClass(record, state.now, { liked });

  // An explicit like outranks every other classification. A hearted track the
  // listener has never played is still something they asked for, so it belongs
  // here rather than being counted as a discovery that happens to be liked.
  if (liked) return "loved";

  if (novelty === "unseen") {
    if (state.explorationIds?.has(id)) return "exploration";
    const language = labelOf(state, id);
    // Cross-discovery is the deliberate bridge out of the dominant taste: a
    // different vocal language, matched through the same retrieval graph.
    if (dominantLanguage && language !== "unknown" && language !== dominantLanguage) {
      return "cross-discovery";
    }
    return "adjacent-discovery";
  }

  if (novelty === "rediscovery") return "rediscovery";
  // `familiar` and `fatigued` both land here; the quota is tiny and utility
  // ordering keeps the fatigued ones out in practice.
  return "familiar-anchor";
}

/** Bounded affinity. Cannot exceed `1 + AFFINITY_RANGE` however much history exists. */
export function affinityOf(state: ListenerState, videoId: string): number {
  const record = state.exposure.get(videoId);
  if (!record) return 1;
  return 1 + AFFINITY_RANGE * enjoyment(record, state.likes.has(videoId));
}

export interface GroupCounts {
  shown7d: number;
  shown30d: number;
  played7d: number;
}

/**
 * Score one candidate for serving. `relevance` comes from the source-evidence
 * stage; everything else is listener state.
 */
export function utility(
  scored: ScoredCandidate,
  state: ListenerState,
  context: {
    dominantLanguage: VocalLanguage | null;
    placedLanguages: ReadonlyMap<VocalLanguage, number>;
    slots: number;
    artistCounts?: ReadonlyMap<string, GroupCounts>;
    clusterCounts?: ReadonlyMap<string, GroupCounts>;
  },
): UtilityBreakdown {
  const { candidate, value: relevance } = scored;
  const id = candidate.track.videoId;
  const liked = state.likes.has(id);
  const record = state.exposure.get(id);

  const affinity = affinityOf(state, id);
  const readiness = repeatReadiness(record, state.now, { liked });
  const novelty = noveltyClass(record, state.now, { liked });
  const discovery = novelty === "unseen" ? DISCOVERY_BONUS : 0;

  const language = labelOf(state, id);
  const languageTerm =
    state.languageTarget && state.languageTarget.size > 0
      ? languageFit(language, state.languageTarget, context.placedLanguages, context.slots) *
        LANGUAGE_WEIGHT
      : 0;

  const artist = primaryArtist(candidate.track.channel);
  const cluster = state.clusterOf?.(candidate.track) ?? artist;
  const artistCount = context.artistCounts?.get(artist);
  const clusterCount = context.clusterCounts?.get(cluster);
  const fatigue =
    ((artistCount ? groupPressure(artistCount, 2) : 0) +
      (clusterCount ? groupPressure(clusterCount, 4) : 0)) *
    FATIGUE_WEIGHT;

  const total = relevance * (affinity * readiness + discovery) + languageTerm - fatigue;

  return {
    relevance,
    affinity,
    readiness,
    discovery,
    language: languageTerm,
    fatigue,
    total,
    novelty,
    pool: classifyPool(candidate, state, context.dominantLanguage),
    language_label: language,
  };
}

export interface AssembleSlateOptions {
  limit: number;
  listener: ListenerState;
  /** Pinned first entry. Counts against the familiar-anchor quota. */
  opener?: MusicTrack | null;
  maxPerArtist?: number;
  endorsedCap?: number;
  quotas?: Partial<Record<SlatePool, number>>;
  /**
   * How much of the slate the `loved` pool may take, as a [min, max] fraction
   * sampled per build.
   *
   * A fixed share produced exactly the same number of liked songs on every
   * rebuild, which reads as mechanical — the shelf is supposed to feel
   * different each time, and "always precisely four" is the most obvious
   * possible tell. Sampling the SIZE as well as the membership means a rebuild
   * can lean into the listener's favourites or lean away from them. The extra
   * is taken from the discovery pools in proportion, so the totals still sum
   * to one and discovery is never silently starved.
   */
  lovedRange?: [number, number];
  random?: () => number;
  /**
   * Softmax temperature for within-pool selection, as a fraction of the pool's
   * own utility spread. 0 = always take the argmax.
   *
   * Cross-build variety comes from here rather than from a random tail bolted
   * onto a deterministic ranking. Expressing it as a fraction of the spread is
   * what makes it behave correctly at both extremes: when candidates are
   * near-identical (the common case inside one pool) the draw is close to
   * uniform, and when one clearly wins it still wins.
   */
  temperature?: number;
  /**
   * Rank globally by utility instead of filling pool quotas.
   *
   * For surfaces where the listener has already stated what they want — "top
   * songs by X" — discovery quotas would fight the request. Exposure and
   * readiness still apply, so a track they just heard still sinks.
   */
  ignorePools?: boolean;
}

export interface AssembledSlate {
  tracks: Candidate[];
  /** Per-slot provenance — the record that makes a shelf auditable. */
  slots: Array<{ candidate: Candidate; pool: SlatePool; breakdown: UtilityBreakdown; rank: number }>;
  /** Slots a quota could not fill from its own pool. */
  backfilled: number;
  /**
   * Backfilled slots that went to a track the listener has already played.
   *
   * This is the number that matters. Plain `backfilled` conflates two very
   * different situations: a pool running out of candidates (often just the
   * per-artist cap doing its job, and harmless when the replacement is still
   * unseen) and the shelf quietly reverting to the listener's own history.
   * Only the second is the defect, so only the second should raise an alarm.
   */
  backfilledFamiliar: number;
  poolCounts: Map<SlatePool, number>;
}

/**
 * Build the slate from explicit pools instead of one ranking plus a tail.
 *
 * The old assembler walked a single ordering top-down for 88% of slots and then
 * sampled the *unused remainder of that same ordering* for the other 12%. That
 * cannot introduce anything the ranking had not already surfaced, which is why
 * "exploration" never explored. Here each pool competes only against itself for
 * its own quota, so a discovery slot cannot be won by a familiar track merely
 * because its affinity is higher.
 */
export function assembleSlate(
  candidates: readonly ScoredCandidate[],
  options: AssembleSlateOptions,
): AssembledSlate {
  const {
    limit,
    listener,
    opener = null,
    maxPerArtist = 3,
    endorsedCap = maxPerArtist * 2,
    quotas = {},
    random = Math.random,
    temperature = 0.35,
    ignorePools = false,
    lovedRange = [0.1, 0.225],
  } = options;

  const dominantLanguage = dominantOf(listener.languageTarget);
  const placedLanguages = new Map<VocalLanguage, number>();
  const artistCounts = new Map<string, number>();
  const clusterCounts = new Map<string, number>();
  const usedIds = new Set<string>();
  const slots: AssembledSlate["slots"] = [];
  const poolCounts = new Map<SlatePool, number>();
  let backfilled = 0;
  let backfilledFamiliar = 0;

  const clusterOf = (track: MusicTrack): string =>
    listener.clusterOf?.(track) ?? primaryArtist(track.channel);

  const place = (
    entry: ScoredCandidate,
    pool: SlatePool,
    breakdown: UtilityBreakdown,
  ): boolean => {
    const { track } = entry.candidate;
    if (usedIds.has(track.videoId)) return false;
    const artist = primaryArtist(track.channel);
    const cap = artist && listener.endorsedArtists?.has(artist) ? endorsedCap : maxPerArtist;
    if (artist && (artistCounts.get(artist) ?? 0) >= cap) return false;
    usedIds.add(track.videoId);
    if (artist) artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1);
    const cluster = clusterOf(track);
    clusterCounts.set(cluster, (clusterCounts.get(cluster) ?? 0) + 1);
    const language = listener.languages?.get(track.videoId)?.language ?? "unknown";
    placedLanguages.set(language, (placedLanguages.get(language) ?? 0) + 1);
    slots.push({ candidate: entry.candidate, pool, breakdown, rank: slots.length });
    poolCounts.set(pool, (poolCounts.get(pool) ?? 0) + 1);
    return true;
  };

  if (opener) {
    const openerEntry: ScoredCandidate = { candidate: { track: opener, occurrences: [] }, value: 0 };
    const breakdown = utility(openerEntry, listener, {
      dominantLanguage,
      placedLanguages,
      slots: limit,
    });
    place(openerEntry, "familiar-anchor", { ...breakdown, pool: "familiar-anchor" });
  }

  if (ignorePools) {
    const ranked = rankBucket(
      candidates.filter((entry) => !usedIds.has(entry.candidate.track.videoId)),
      listener,
      { dominantLanguage, placedLanguages, slots: limit },
    );
    for (const pick of ranked) {
      if (slots.length >= limit) break;
      place(pick.entry, pick.breakdown.pool, pick.breakdown);
    }
    return {
      tracks: slots.map((slot) => slot.candidate),
      slots,
      backfilled: 0,
      backfilledFamiliar: 0,
      poolCounts,
    };
  }

  // Pool membership is decided once, up front.
  const byPool = new Map<SlatePool, ScoredCandidate[]>();
  for (const entry of candidates) {
    if (usedIds.has(entry.candidate.track.videoId)) continue;
    const pool = classifyPool(entry.candidate, listener, dominantLanguage);
    const bucket = byPool.get(pool);
    if (bucket) bucket.push(entry);
    else byPool.set(pool, [entry]);
  }

  const resolved: Record<SlatePool, number> = {
    "familiar-anchor": quotas["familiar-anchor"] ?? DEFAULT_QUOTAS["familiar-anchor"],
    loved: quotas.loved ?? DEFAULT_QUOTAS.loved,
    rediscovery: quotas.rediscovery ?? DEFAULT_QUOTAS.rediscovery,
    "adjacent-discovery": quotas["adjacent-discovery"] ?? DEFAULT_QUOTAS["adjacent-discovery"],
    "cross-discovery": quotas["cross-discovery"] ?? DEFAULT_QUOTAS["cross-discovery"],
    exploration: quotas.exploration ?? DEFAULT_QUOTAS.exploration,
  };

  // Sample this build's liked share, then fund the difference from discovery in
  // proportion so the fractions still sum to one.
  if (quotas.loved === undefined) {
    const [lo, hi] = lovedRange;
    const sampled = lo + random() * Math.max(0, hi - lo);
    const delta = sampled - resolved.loved;
    const discoveryTotal = DISCOVERY_POOLS.reduce((sum, pool) => sum + resolved[pool], 0);
    if (discoveryTotal > 0) {
      for (const pool of DISCOVERY_POOLS) {
        resolved[pool] = Math.max(0, resolved[pool] - delta * (resolved[pool] / discoveryTotal));
      }
    }
    resolved.loved = sampled;
  }

  // Any quota that cannot be met from its own pool is redistributed to the
  // discovery pools that DO have candidates, before anything falls through to a
  // global ranking. Two cases matter and they pull the same way:
  //
  //   - cross-language retrieval came back empty, so those slots should still
  //     go to discovery rather than to whatever ranks highest overall;
  //   - nothing is repeat-ready yet (common for a newer listener), so the
  //     rediscovery slots should become discovery rather than familiar filler.
  //
  // Generic backfill is the path that can hand a slot to a familiar track, so
  // the fewer slots reach it the less a thin pool can quietly turn a discovery
  // shelf back into a history shelf.
  // Discovery pools are filled first: a shelf that runs out of slots should run
  // out of familiar ones, not fresh ones.
  const order: SlatePool[] = [
    "familiar-anchor",
    // Early, so the guarantee survives a thin candidate pool: if likes are only
    // filled from what discovery leaves behind, they are first to disappear.
    "loved",
    "adjacent-discovery",
    "cross-discovery",
    "exploration",
    "rediscovery",
  ];

  let discoveryDebt = 0;
  for (const pool of order) {
    const target = Math.round(limit * resolved[pool]);
    const available = (byPool.get(pool) ?? []).length;
    if (available < target) discoveryDebt += target - available;
  }

  for (const pool of order) {
    let target = Math.round(limit * resolved[pool]);
    const bucket = byPool.get(pool) ?? [];
    if (DISCOVERY_POOLS.includes(pool) && discoveryDebt > 0) {
      const spare = Math.max(0, bucket.length - target);
      const claimed = Math.min(spare, discoveryDebt);
      target += claimed;
      discoveryDebt -= claimed;
    }
    let placed = poolCounts.get(pool) ?? 0;
    let guard = bucket.length * 2;
    while (placed < target && bucket.length > 0 && slots.length < limit && guard-- > 0) {
      const ranked = rankBucket(bucket, listener, {
        dominantLanguage,
        placedLanguages,
        slots: limit,
        artistCounts: groupView(artistCounts),
        clusterCounts: groupView(clusterCounts),
      });
      if (ranked.length === 0) break;
      const pick = sampleByUtility(ranked, random, temperature);
      if (!pick) break;
      const index = bucket.indexOf(pick.entry);
      if (index >= 0) bucket.splice(index, 1);
      if (place(pick.entry, pool, pick.breakdown)) placed += 1;
    }
  }

  // Backfill: quotas are targets, not guarantees. A pool that cannot be filled
  // (a cold catalog, a failed source) yields its slots rather than shortening
  // the shelf — but the count is reported so a silent collapse into familiar
  // history is measurable instead of invisible.
  if (slots.length < limit) {
    const remaining = candidates.filter((entry) => !usedIds.has(entry.candidate.track.videoId));
    const ranked = rankBucket(remaining, listener, {
      dominantLanguage,
      placedLanguages,
      slots: limit,
      artistCounts: groupView(artistCounts),
      clusterCounts: groupView(clusterCounts),
    });
    // Backfill is stochastic for the same reason pool selection is: a shelf
    // whose unfillable slots are always resolved the same way is a shelf that
    // never changes, which is the defect wearing a different hat.
    const bucket = [...ranked];
    while (slots.length < limit && bucket.length > 0) {
      const pick = sampleByUtility(bucket, random, temperature);
      if (!pick) break;
      bucket.splice(bucket.indexOf(pick), 1);
      if (place(pick.entry, pick.breakdown.pool, pick.breakdown)) {
        backfilled += 1;
        if (pick.breakdown.novelty !== "unseen") backfilledFamiliar += 1;
      }
    }
  }

  // Last resort: ignore the artist cap rather than return a short shelf.
  //
  // Ordered by utility, and unseen first within that. Taking candidates in
  // array order here was quietly handing ~15% of all slots to already-played
  // tracks: the per-artist cap would block a discovery pick, the slot would
  // fall through to this loop, and whatever happened to sit earliest in the
  // pool won it. A last resort still has to prefer the right thing.
  if (slots.length < limit) {
    const lastResort = candidates
      .filter((entry) => !usedIds.has(entry.candidate.track.videoId))
      .map((entry) => ({
        entry,
        breakdown: utility(entry, listener, { dominantLanguage, placedLanguages, slots: limit }),
      }))
      .sort((a, b) => {
        const aUnseen = a.breakdown.novelty === "unseen" ? 1 : 0;
        const bUnseen = b.breakdown.novelty === "unseen" ? 1 : 0;
        return bUnseen - aUnseen || b.breakdown.total - a.breakdown.total;
      });
    for (const { entry, breakdown } of lastResort) {
      if (slots.length >= limit) break;
      const id = entry.candidate.track.videoId;
      if (usedIds.has(id)) continue;
      usedIds.add(id);
      slots.push({ candidate: entry.candidate, pool: breakdown.pool, breakdown, rank: slots.length });
      poolCounts.set(breakdown.pool, (poolCounts.get(breakdown.pool) ?? 0) + 1);
      backfilled += 1;
      if (breakdown.novelty !== "unseen") backfilledFamiliar += 1;
    }
  }

  return {
    tracks: slots.map((slot) => slot.candidate),
    slots,
    backfilled,
    backfilledFamiliar,
    poolCounts,
  };
}

function groupView(counts: ReadonlyMap<string, number>): Map<string, GroupCounts> {
  const view = new Map<string, GroupCounts>();
  for (const [key, shown] of counts) {
    view.set(key, { shown7d: shown, shown30d: shown, played7d: 0 });
  }
  return view;
}

/**
 * Draw one entry with probability proportional to `exp(utility / T)`.
 *
 * `T` is derived from the bucket's own spread, so equal-utility candidates are
 * drawn uniformly instead of by array order. That matters more than it sounds:
 * inside a single pool most candidates score almost identically, and a stable
 * sort plus argmax turns "almost identical" into "always the same track".
 */
function sampleByUtility<T extends { breakdown: UtilityBreakdown }>(
  ranked: readonly T[],
  random: () => number,
  temperature: number,
): T | null {
  if (ranked.length === 0) return null;
  if (temperature <= 0) return ranked[0]!;
  const values = ranked.map((entry) => entry.breakdown.total);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const spread = max - min;
  // A floor keeps the exponent finite when every candidate ties.
  const t = Math.max(1e-6, spread * temperature);
  const weights = values.map((value) => Math.exp((value - max) / t));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(total) || total <= 0) return ranked[0]!;
  let threshold = random() * total;
  for (let i = 0; i < ranked.length; i++) {
    threshold -= weights[i]!;
    if (threshold <= 0) return ranked[i]!;
  }
  return ranked[ranked.length - 1]!;
}

function rankBucket(
  bucket: readonly ScoredCandidate[],
  listener: ListenerState,
  context: Parameters<typeof utility>[2],
): Array<{ entry: ScoredCandidate; breakdown: UtilityBreakdown }> {
  return bucket
    .map((entry) => ({ entry, breakdown: utility(entry, listener, context) }))
    .sort((a, b) => b.breakdown.total - a.breakdown.total);
}

function dominantOf(target: ReadonlyMap<VocalLanguage, number> | undefined): VocalLanguage | null {
  if (!target || target.size === 0) return null;
  let best: VocalLanguage | null = null;
  let bestShare = 0;
  for (const [language, share] of target) {
    if (share > bestShare) {
      bestShare = share;
      best = language;
    }
  }
  return best;
}
