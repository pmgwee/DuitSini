import type { MusicTrack } from "@/types/music";
import {
  fetchArtistSongs,
  fetchPlaylistTracks,
  fetchRadio,
  fetchRelated,
  extendRadio,
} from "./sources";
import { pickSeeds, primaryArtist, relevance } from "./ranking";
import {
  assembleSlate,
  type ListenerState,
  type ScoredCandidate,
  type SlatePool,
} from "./objective";
import {
  exposureFromHistory,
  type ExposureRecord,
  isDeliberate,
  isMeaningful,
  type ListenEvent,
} from "./exposure";
import {
  inferLanguage,
  learnLanguageMix,
  LEARNING_CONFIDENCE,
  type LanguageLabel,
  type LanguageObservation,
  type VocalLanguage,
} from "./language";
import { sequence } from "./similarity";
import { ensureTagVectors } from "./tags";
import { createDbTagStore } from "./tags-store";
import type {
  Candidate,
  CandidateOrigin,
  HistoryEntry,
  LikedTrack,
  Occurrence,
} from "./types";

/**
 * The recommender pipeline. Mirrors the two-stage architecture both Spotify and
 * Apple Music describe publicly:
 *
 *   1. CANDIDATE GENERATION — cheap, recall-oriented, hundreds of candidates
 *      pulled from five anonymous YouTube Music surfaces (`sources.ts`).
 *   2. RANKING + ASSEMBLY — behavioural scoring, diversity caps and an
 *      epsilon-greedy exploration budget (`ranking.ts`).
 *   3. SEQUENCING — order the slate so adjacent tracks flow (`similarity.ts`).
 *
 * Nothing here is authenticated. Nothing expires.
 */

/** Seeds per shelf build. Each is one HTTP call; the pool grows ~50/seed. */
const SEED_COUNT = 6;
/** Extra one-hop sources — an adjacent artist and an editorial playlist. */
const SIMILAR_ARTIST_FANOUT = 2;
const EDITORIAL_FANOUT = 1;
/** Liked-track neighbourhoods to fetch per build (taste-signal fidelity). */
const LIKE_FANOUT = 4;
/** A like carries ~this many plays of seed-trust (cf. W_LIKE "≈ five completed plays"). */
const LIKE_SEED_WEIGHT = 3;
/** How often the liked-fanout rotation advances (cycles through all likes over time). */
const LIKE_ROTATION_MS = 2 * 60_000;
/**
 * Retrieval reserved for candidates OUTSIDE the taste neighbourhood.
 *
 * The old epsilon sampled the unused tail of the same generated pool, so it
 * could only reorder what retrieval had already decided to fetch. Exploration
 * that cannot reach a track the ranker never saw is not exploration. These
 * fan out from the FAR end of the similar-artist and playlist lists — one hop
 * further from the seed than the adjacent layer.
 */
const EXPLORATION_ARTIST_FANOUT = 1;
const EXPLORATION_PLAYLIST_FANOUT = 1;

class CandidatePool {
  private readonly byId = new Map<string, Candidate>();

  add(track: MusicTrack, occurrence: Occurrence): void {
    const existing = this.byId.get(track.videoId);
    if (existing) {
      existing.occurrences.push(occurrence);
      return;
    }
    this.byId.set(track.videoId, { track, occurrences: [occurrence] });
  }

  addMany(
    tracks: MusicTrack[],
    sourceId: string,
    origin: CandidateOrigin,
    seedWeight: number,
  ): void {
    tracks.forEach((track, rank) => this.add(track, { sourceId, origin, rank, seedWeight }));
  }

  values(): Candidate[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }
}

function toHistoryMap(history: HistoryEntry[]): Map<string, HistoryEntry> {
  return new Map(history.map((entry) => [entry.videoId, entry]));
}

/** Settle every promise; a failed source contributes nothing and never throws. */
async function settle<T>(promises: Array<Promise<T>>): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  const out: T[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") out.push(result.value);
  }
  return out;
}

export interface ShelfOptions {
  limit?: number;
  now?: number;
  random?: () => number;
  /** Learned per-transition preferences (see `store.loadTransitionBias`). */
  transitionBias?: Map<string, number>;
  /** Explicitly liked tracks — strongest confidence signal, and strong seeds. */
  likes?: LikedTrack[];
  /** Tracks to remove entirely (not-interested / active snooze). */
  suppressed?: Set<string>;
  /**
   * Cold-start prior: the listener's imported YouTube "Liked Music".
   *
   * Used ONLY to seed neighbourhoods when there is no in-app behaviour yet, and
   * never as a confidence signal — an import is not the same statement as a
   * heart tapped here, and it may be years stale. Without this, a brand-new
   * listener with a large imported library got their own liked songs shuffled
   * back at them, which is precisely the loop this recommender exists to break.
   */
  coldStart?: MusicTrack[];
  /**
   * Durable exposure memory. When omitted it is projected from `history`, which
   * keeps the pipeline working before the event stream has data — but a
   * projection of a 60-row window cannot know about older plays, so the caller
   * should pass `everPlayed` too.
   */
  exposure?: ReadonlyMap<string, ExposureRecord>;
  /**
   * Every videoId this listener has ever played, unwindowed. This is the fix
   * for the defect where a track played 200 times last year scored identically
   * to one they had never heard.
   */
  everPlayed?: ReadonlySet<string>;
  /** Deliberate positive plays used to learn the language mix. */
  listenEvents?: readonly ListenEvent[];
  /** videoId -> last time it was used as a shelf seed (radio cooldown). */
  seedCooldown?: ReadonlyMap<string, number>;
  /** Cached constrained-vocabulary tags, used as language evidence. */
  tagsByTrack?: ReadonlyMap<string, readonly string[]>;
  /**
   * Previously stored language labels. A stored label wins when it is more
   * confident than what title evidence alone can produce — that is how a
   * corroborated label (tags, or a future declared source) outlives the build
   * that discovered it.
   */
  languageHints?: ReadonlyMap<string, { language: VocalLanguage; confidence: number }>;
}

/** One served slot, with everything needed to audit or learn from it later. */
export interface ShelfSlot {
  videoId: string;
  position: number;
  pool: SlatePool;
  /** Retrieval origin of the strongest occurrence. */
  source: string;
  retrievalRank: number;
  language: VocalLanguage;
  /** How much to trust `language`. Carried so a weak guess is never stored as certainty. */
  languageConfidence: number;
  relevance: number;
  readiness: number;
  total: number;
  everPlayed: boolean;
}

export interface ShelfDiagnostics {
  candidateCount: number;
  unseenCandidateCount: number;
  /** Slots a quota could not fill from its own pool — a silent-collapse alarm. */
  backfilled: number;
  poolCounts: Record<string, number>;
  /** Candidate-stage language availability, before ranking. */
  candidateLanguages: Record<string, number>;
  slateLanguages: Record<string, number>;
  languageTarget: Record<string, number>;
  seedIds: string[];
  /** Sources that returned nothing. A silent InnerTube failure must be visible. */
  emptySources: string[];
}

export interface ShelfResult {
  tracks: MusicTrack[];
  slots: ShelfSlot[];
  diagnostics: ShelfDiagnostics;
}

/**
 * Liked tracks that were never played still deserve to seed a neighbourhood —
 * a like on a shelf row is a clear statement of taste even with zero plays.
 * Merge them in as synthetic history so seed selection can see them.
 */
function mergeLikesIntoHistory(history: HistoryEntry[], likes: LikedTrack[]): HistoryEntry[] {
  const known = new Set(history.map((h) => h.videoId));
  const extra: HistoryEntry[] = [];
  for (const like of likes) {
    if (known.has(like.videoId)) continue;
    extra.push({
      videoId: like.videoId,
      title: like.title,
      channel: like.channel,
      thumbnail: like.thumbnail,
      playCount: 1,
      lastPlayedAt: like.likedAt,
      skipCount: 0,
      completeCount: 0,
    });
  }
  return [...history, ...extra];
}

/** Label a set of tracks, using cached tags as corroborating evidence. */
export function labelLanguages(
  tracks: readonly MusicTrack[],
  tagsByTrack?: ReadonlyMap<string, readonly string[]>,
  hints?: ReadonlyMap<string, { language: VocalLanguage; confidence: number }>,
): Map<string, LanguageLabel> {
  const labels = new Map<string, LanguageLabel>();
  for (const track of tracks) {
    const inferred = inferLanguage({
      title: track.title,
      channel: track.channel,
      tags: tagsByTrack?.get(track.videoId),
    });
    const hint = hints?.get(track.videoId);
    labels.set(
      track.videoId,
      hint && hint.confidence > inferred.confidence
        ? { language: hint.language, confidence: hint.confidence, evidence: [] }
        : inferred,
    );
  }
  return labels;
}

/**
 * Turn playback events into language observations.
 *
 * Only meaningful outcomes count, and an autoplay start is damped rather than
 * dropped: it is weak evidence, not no evidence. Treating every autoplay start
 * as a full endorsement is how a long background session used to rewrite the
 * taste profile toward whatever the station happened to play.
 */
function languageObservations(
  events: readonly ListenEvent[],
  labels: ReadonlyMap<string, LanguageLabel>,
): LanguageObservation[] {
  const observations: LanguageObservation[] = [];
  for (const event of events) {
    if (!isMeaningful(event.outcome)) continue;
    const label = labels.get(event.videoId);
    if (!label || label.language === "unknown") continue;
    // A coin-flip label must not train the long-term target: the target then
    // steers retrieval, which produces more of the same label, which confirms
    // it. That feedback loop is cheap to prevent and expensive to detect.
    if (label.confidence < LEARNING_CONFIDENCE) continue;
    const weight = (isDeliberate(event.origin) ? 1 : 0.3) * (event.outcome === "completed" ? 1 : 0.6);
    observations.push({ language: label.language, at: event.at, weight });
  }
  return observations;
}

/**
 * Build the discovery shelf from the listener's own history.
 *
 * This is the fix for the "same songs on a loop" problem: the shelf is no longer
 * a reshuffle of what you already played, it's a ranked slate drawn from
 * neighbourhoods around your history. Measured on a 24-track history, four seeds
 * yield ~160 candidates of which ~85% have never been played.
 *
 * Returns `[]` (never throws) when there's no history or every source failed.
 */
export async function buildShelf(
  history: HistoryEntry[],
  options: ShelfOptions = {},
): Promise<ShelfResult> {
  const {
    limit = 40,
    now = Date.now(),
    random = Math.random,
    transitionBias,
    likes = [],
    suppressed = new Set<string>(),
    coldStart = [],
    exposure,
    everPlayed = new Set<string>(),
    listenEvents = [],
    seedCooldown,
    tagsByTrack,
    languageHints,
  } = options;
  const emptySources: string[] = [];
  const empty = (): ShelfResult => ({
    tracks: [],
    slots: [],
    diagnostics: {
      candidateCount: 0,
      unseenCandidateCount: 0,
      backfilled: 0,
      poolCounts: {},
      candidateLanguages: {},
      slateLanguages: {},
      languageTarget: {},
      seedIds: [],
      emptySources,
    },
  });
  if (history.length === 0 && likes.length === 0 && coldStart.length === 0) return empty();

  const likeIds = new Set(likes.map((l) => l.videoId));
  let seedPool = mergeLikesIntoHistory(history, likes);

  // Cold start only: borrow the imported library to find a starting
  // neighbourhood. Once any real in-app behaviour exists this contributes
  // nothing, so the prior fades on its own rather than needing to be expired.
  if (seedPool.length === 0) {
    seedPool = coldStart.slice(0, 30).map((track) => ({
      videoId: track.videoId,
      title: track.title,
      channel: track.channel,
      thumbnail: track.thumbnail,
      playCount: 1,
      lastPlayedAt: new Date(now).toISOString(),
      skipCount: 0,
      completeCount: 0,
    }));
  }

  const seeds = pickSeeds(seedPool, SEED_COUNT, now, {
    random,
    likes: likeIds,
    seedCooldown,
  });
  if (seeds.length === 0) return empty();

  const pool = new CandidatePool();

  // --- Stage 1a: song radio for each seed (the highest-yield source) ---------
  const radios = await settle(seeds.map((seed) => fetchRadio(seed.videoId)));
  radios.forEach((radio, index) => {
    const seed = seeds[index];
    if (radio.tracks.length === 0) emptySources.push(`radio:${radio.seedId}`);
    pool.addMany(radio.tracks, radio.seedId, "radio", seed?.playCount ?? 1);
  });
  if (radios.length < seeds.length) emptySources.push(`radio:failed:${seeds.length - radios.length}`);

  // --- Stage 1b: the related page across ALL seeds (not just the strongest) --
  // Fetching related per seed (one call each, parallel) means the similar-artist
  // and editorial layers see the FULL seed diversity rather than only the single
  // highest-weight seed's neighbourhood — so a minority-taste seed's similar
  // artists reach the pool too. Shelves are merged and deduped across seeds.
  const relatedPages = await settle(seeds.map((s) => fetchRelated(s.videoId)));
  const mergedAlsoLike: MusicTrack[] = [];
  const similarArtistIds: string[] = [];
  const playlistIds: string[] = [];
  const seenAlso = new Set<string>();
  const seenArtist = new Set<string>();
  const seenPlaylist = new Set<string>();
  for (const page of relatedPages) {
    for (const t of page.alsoLike) {
      if (!seenAlso.has(t.videoId)) {
        seenAlso.add(t.videoId);
        mergedAlsoLike.push(t);
      }
    }
    for (const id of page.similarArtistIds) {
      if (!seenArtist.has(id)) {
        seenArtist.add(id);
        similarArtistIds.push(id);
      }
    }
    for (const id of page.playlistIds) {
      if (!seenPlaylist.has(id)) {
        seenPlaylist.add(id);
        playlistIds.push(id);
      }
    }
  }
  pool.addMany(mergedAlsoLike, "also:multi", "also-like", seeds[0]?.playCount ?? 1);

  // --- Stage 1c: one hop out — adjacent artists and editorial curation -------
  const [artistBatches, playlistBatches] = await Promise.all([
    settle(
      similarArtistIds
        .slice(0, SIMILAR_ARTIST_FANOUT)
        .map(async (id) => ({ id, tracks: await fetchArtistSongs(id) })),
    ),
    settle(
      playlistIds
        .slice(0, EDITORIAL_FANOUT)
        .map(async (id) => ({ id, tracks: await fetchPlaylistTracks(id) })),
    ),
  ]);
  for (const batch of artistBatches) {
    if (batch.tracks.length === 0) emptySources.push(`artist:${batch.id}`);
    pool.addMany(batch.tracks, `artist:${batch.id}`, "similar-artist", 1);
  }
  for (const batch of playlistBatches) {
    if (batch.tracks.length === 0) emptySources.push(`playlist:${batch.id}`);
    pool.addMany(batch.tracks, `playlist:${batch.id}`, "editorial", 1);
  }

  // --- Stage 1c-bis: exploration retrieval ----------------------------------
  // Deliberately drawn from the FAR end of the adjacency lists — the artists and
  // playlists the taste-close layer did not reach. These ids are marked so the
  // assembler can spend its exploration quota on candidates the ranking would
  // otherwise never have seen, rather than on the tail of its own output.
  const explorationIds = new Set<string>();
  const explorationArtistIds = similarArtistIds.slice(SIMILAR_ARTIST_FANOUT).slice(-EXPLORATION_ARTIST_FANOUT);
  const explorationPlaylistIds = playlistIds.slice(EDITORIAL_FANOUT).slice(-EXPLORATION_PLAYLIST_FANOUT);
  const [exploreArtists, explorePlaylists] = await Promise.all([
    settle(explorationArtistIds.map(async (id) => ({ id, tracks: await fetchArtistSongs(id) }))),
    settle(explorationPlaylistIds.map(async (id) => ({ id, tracks: await fetchPlaylistTracks(id) }))),
  ]);
  for (const batch of exploreArtists) {
    for (const track of batch.tracks) explorationIds.add(track.videoId);
    pool.addMany(batch.tracks, `explore-artist:${batch.id}`, "similar-artist", 1);
  }
  for (const batch of explorePlaylists) {
    for (const track of batch.tracks) explorationIds.add(track.videoId);
    pool.addMany(batch.tracks, `explore-playlist:${batch.id}`, "editorial", 1);
  }

  // --- Stage 1d: liked-track fanout (taste-signal fidelity) ------------------
  // A like is the clearest taste statement, but until now it only biased seed
  // selection and the confidence term — it never GUARANTEED its neighbourhood
  // entered the pool. So a freshly-liked discovery (e.g. a track liked from a
  // previous shelf) rarely surfaced similar tracks. Fetch radio around a few
  // liked tracks that weren't picked as seeds. Coverage is a DETERMINISTIC
  // round-robin over the whole liked set (stable within a short window, then
  // rotates) — not a recency-biased sample — because likes don't decay: this is
  // the mechanism that surfaces an older minority-taste cluster (e.g. Chinese
  // likes played long ago) that recency-based seed selection buries.
  const seededIds = new Set(seeds.map((s) => s.videoId));
  const likedCandidates = likes.filter((l) => !seededIds.has(l.videoId));
  if (likedCandidates.length > 0) {
    const start =
      likedCandidates.length > LIKE_FANOUT
        ? Math.floor(now / LIKE_ROTATION_MS) % likedCandidates.length
        : 0;
    const picks: string[] = [];
    for (let i = 0; i < LIKE_FANOUT && i < likedCandidates.length; i++) {
      picks.push(likedCandidates[(start + i) % likedCandidates.length]!.videoId);
    }
    const likeRadios = await settle(picks.map((id) => fetchRadio(id)));
    for (const radio of likeRadios) {
      pool.addMany(radio.tracks, `liked:${radio.seedId}`, "radio", LIKE_SEED_WEIGHT);
    }
  }

  if (pool.size === 0) return empty();

  // --- Stage 2: rank and assemble -------------------------------------------
  // Suppressed tracks are DROPPED, not down-ranked: a listener who said "not
  // this" should not have to keep saying it.
  const candidates = pool
    .values()
    .filter((candidate) => !suppressed.has(candidate.track.videoId));

  if (candidates.length === 0) return empty();

  // Relevance is now pure source evidence. Everything about the listener —
  // affinity, exposure, readiness, language — is applied by the objective, so
  // the two cannot silently trade off inside one multiplied number.
  const scored: ScoredCandidate[] = candidates.map((candidate) => ({
    candidate,
    value: relevance(candidate),
  }));

  const labels = labelLanguages(
    candidates.map((c) => c.track),
    tagsByTrack,
    languageHints,
  );
  // History tracks need labels too: the learned mix is built from what the
  // listener PLAYED, not from what happens to be in today's candidate pool.
  for (const entry of seedPool) {
    if (labels.has(entry.videoId)) continue;
    labels.set(
      entry.videoId,
      inferLanguage({ title: entry.title, channel: entry.channel, tags: tagsByTrack?.get(entry.videoId) }),
    );
  }

  const languageTarget = learnLanguageMix(languageObservations(listenEvents, labels), { now });

  // Exposure: event-derived when available, otherwise projected from the
  // aggregate. `everPlayed` is unwindowed either way.
  const exposureMap =
    exposure ??
    exposureFromHistory(
      seedPool.map((entry) => ({
        videoId: entry.videoId,
        playCount: entry.playCount,
        completeCount: entry.completeCount,
        skipCount: entry.skipCount,
        lastPlayedAt: entry.lastPlayedAt,
      })),
      everPlayed,
    );

  const listener: ListenerState = {
    exposure: exposureMap,
    likes: likeIds,
    now,
    languages: labels,
    languageTarget,
    // Artists the listener has explicitly liked get a relaxed per-artist cap —
    // endorsed taste, not the clumping the cap exists to prevent.
    endorsedArtists: new Set(likes.map((l) => primaryArtist(l.channel))),
    explorationIds,
  };

  // Position-aware: open on the track the listener played most recently, so the
  // shelf starts on something trusted before it asks them to explore.
  const opener = history[0]
    ? {
        videoId: history[0].videoId,
        title: history[0].title,
        channel: history[0].channel,
        thumbnail: history[0].thumbnail,
        source: "local" as const,
      }
    : null;

  const assembled = assembleSlate(scored, { limit, listener, opener, random });

  // --- Stage 3: sequence for smooth transitions ------------------------------
  // Tag the final SLATE (not the whole pool) so cold tracks — pairs that share
  // no co-occurrence source — can still be placed beside taste-neighbours via
  // the LLM tag prior. Cached per track, so only the first build pays the GLM
  // cost; a missing/failed tag just falls back to pure co-occurrence.
  const tagVectors = await ensureTagVectors(
    assembled.tracks.map((c) => ({
      videoId: c.track.videoId,
      title: c.track.title,
      channel: c.track.channel,
    })),
    createDbTagStore(),
  );
  const ordered = sequence(assembled.tracks, 0, { transitionBias, tagVectors });

  const breakdownById = new Map(
    assembled.slots.map((slot) => [slot.candidate.track.videoId, slot]),
  );
  const slots: ShelfSlot[] = ordered.map((candidate, position) => {
    const slot = breakdownById.get(candidate.track.videoId);
    const best = candidate.occurrences[0];
    return {
      videoId: candidate.track.videoId,
      position,
      pool: slot?.pool ?? "adjacent-discovery",
      source: best?.sourceId ?? "opener",
      retrievalRank: best?.rank ?? -1,
      language: labels.get(candidate.track.videoId)?.language ?? "unknown",
      languageConfidence: labels.get(candidate.track.videoId)?.confidence ?? 0,
      relevance: slot?.breakdown.relevance ?? 0,
      readiness: slot?.breakdown.readiness ?? 1,
      total: slot?.breakdown.total ?? 0,
      everPlayed: exposureMap.get(candidate.track.videoId)?.everPlayed ?? false,
    };
  });

  const countBy = <T>(values: readonly T[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const value of values) {
      const key = String(value);
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  };

  return {
    tracks: ordered.map((candidate) => candidate.track),
    slots,
    diagnostics: {
      candidateCount: candidates.length,
      unseenCandidateCount: candidates.filter(
        (c) => !exposureMap.get(c.track.videoId)?.everPlayed,
      ).length,
      backfilled: assembled.backfilled,
      poolCounts: Object.fromEntries([...assembled.poolCounts].map(([k, v]) => [k, v])),
      candidateLanguages: countBy(
        candidates.map((c) => labels.get(c.track.videoId)?.language ?? "unknown"),
      ),
      slateLanguages: countBy(slots.map((slot) => slot.language)),
      languageTarget: Object.fromEntries([...languageTarget].map(([k, v]) => [k, v])),
      seedIds: seeds.map((seed) => seed.videoId),
      emptySources,
    },
  };
}

export interface RadioOptions {
  limit?: number;
  now?: number;
  /** Video ids already queued, so a continuation never repeats what's pending. */
  exclude?: string[];
  /** Learned per-transition preferences (see `store.loadTransitionBias`). */
  transitionBias?: Map<string, number>;
  /** Explicitly liked tracks — raises confidence in the ranking. */
  likes?: Set<string>;
  /** Tracks to remove entirely (not-interested / active snooze). */
  suppressed?: Set<string>;
  /** Durable exposure memory; projected from `history` when omitted. */
  exposure?: ReadonlyMap<string, ExposureRecord>;
  /** Unwindowed set of everything ever played. */
  everPlayed?: ReadonlySet<string>;
}

/**
 * Endless autoplay: given the track that just finished, produce the next batch.
 *
 * This is the Apple Music "Autoplay (∞)" surface — when the queue runs dry the
 * music continues instead of stopping. Deliberately more conservative than the
 * discovery shelf (Apple's Autoplay behaves the same way): it stays close to the
 * seed rather than reaching for novelty, and it filters what the listener has
 * skipped or just heard.
 */
export async function buildRadio(
  seedVideoId: string,
  history: HistoryEntry[],
  options: RadioOptions = {},
): Promise<{ tracks: MusicTrack[]; continuation: string | null }> {
  const {
    limit = 25,
    now = Date.now(),
    exclude = [],
    transitionBias,
    likes = new Set<string>(),
    suppressed = new Set<string>(),
  } = options;

  const radio = await fetchRadio(seedVideoId);
  if (radio.tracks.length === 0) return { tracks: [], continuation: null };

  const historyMap = toHistoryMap(history);
  const excluded = new Set([...exclude, seedVideoId]);

  const pool = new CandidatePool();
  pool.addMany(radio.tracks, radio.seedId, "radio", 1);

  const kept = pool
    .values()
    .filter((candidate) => !excluded.has(candidate.track.videoId))
    .filter((candidate) => !suppressed.has(candidate.track.videoId))
    // Never autoplay something previously skipped — unless it was later liked,
    // which supersedes an old skip (people do come back to a song).
    .filter((candidate) => {
      const skips = historyMap.get(candidate.track.videoId)?.skipCount ?? 0;
      return skips === 0 || likes.has(candidate.track.videoId);
    });
  const scored: ScoredCandidate[] = kept.map((candidate) => ({
    candidate,
    value: relevance(candidate),
  }));

  if (scored.length === 0) return { tracks: [], continuation: radio.continuation };

  // Autoplay is deliberately more conservative than the shelf — it should feel
  // like a continuation, not a jump. But exposure still applies: a long radio
  // session used to bypass personalisation entirely and re-serve tracks the
  // listener had just heard, which is the same loop by a different route.
  const listener: ListenerState = {
    exposure:
      options.exposure ??
      exposureFromHistory(
        history.map((entry) => ({
          videoId: entry.videoId,
          playCount: entry.playCount,
          completeCount: entry.completeCount,
          skipCount: entry.skipCount,
          lastPlayedAt: entry.lastPlayedAt,
        })),
        options.everPlayed ?? new Set<string>(),
      ),
    likes,
    now,
  };
  const assembled = assembleSlate(scored, {
    limit,
    listener,
    maxPerArtist: 2,
    temperature: 0.15,
    quotas: {
      "familiar-anchor": 0,
      rediscovery: 0.08,
      "adjacent-discovery": 0.74,
      "cross-discovery": 0.08,
      exploration: 0.1,
    },
  });
  const slate = assembled.tracks;
  const tagVectors = await ensureTagVectors(
    slate.map((c) => ({ videoId: c.track.videoId, title: c.track.title, channel: c.track.channel })),
    createDbTagStore(),
  );
  const ordered = sequence(slate, 0, { transitionBias, tagVectors });

  return {
    tracks: ordered.map((candidate) => candidate.track),
    continuation: radio.continuation,
  };
}

export interface ArtistCatalogOptions {
  limit?: number;
  now?: number;
  /** Learned per-transition preferences (see `store.loadTransitionBias`). */
  transitionBias?: Map<string, number>;
  /** Explicitly liked videoIds — raises confidence in the ranking. */
  likes?: Set<string>;
  /** Tracks to remove entirely (not-interested / active snooze). */
  suppressed?: Set<string>;
  /** Video ids to exclude (e.g. already-queued). */
  exclude?: string[];
}

/**
 * The "top songs by ARTIST" path (vibe surface). The named artist's own Songs
 * shelf — which YouTube Music already orders by popularity/recognition — is the
 * candidate set. Unlike `buildRadio`, neighbours are NOT mixed in: the listener
 * asked for that artist, so the per-artist diversity cap is lifted (the whole
 * slate is one artist by intent) and `rankWeight(rank)` over the shelf's natural
 * order yields top-down recognition with no view-count fetch. The learned-taste
 * ranker still runs on top: a catalog song the listener skipped sinks, a liked
 * one rises, recent repeats weigh in via the confidence + recency terms.
 */
export async function buildArtistCatalog(
  artistId: string,
  history: HistoryEntry[],
  options: ArtistCatalogOptions = {},
): Promise<{ tracks: MusicTrack[] }> {
  const {
    limit = 25,
    now = Date.now(),
    transitionBias,
    likes = new Set<string>(),
    suppressed = new Set<string>(),
    exclude = [],
  } = options;

  // Pull a shelf larger than the slate so dropped skips still leave a full list.
  const catalog = await fetchArtistSongs(artistId, Math.max(limit * 2, limit + 10));
  if (catalog.length === 0) return { tracks: [] };

  const historyMap = toHistoryMap(history);
  const excluded = new Set(exclude);

  const pool = new CandidatePool();
  pool.addMany(catalog, `artist:${artistId}`, "artist-catalog", 1);

  const kept = pool
    .values()
    .filter((candidate) => !excluded.has(candidate.track.videoId))
    .filter((candidate) => !suppressed.has(candidate.track.videoId))
    // A skip normally sinks a track; a later like supersedes an old skip.
    .filter((candidate) => {
      const skips = historyMap.get(candidate.track.videoId)?.skipCount ?? 0;
      return skips === 0 || likes.has(candidate.track.videoId);
    });
  const scored: ScoredCandidate[] = kept.map((candidate) => ({
    candidate,
    value: relevance(candidate),
  }));

  if (scored.length === 0) return { tracks: [] };

  // The listener named this artist, so discovery quotas would fight the
  // request: rank globally and lift the per-artist cap. Exposure still applies,
  // so a catalog track they just heard still sinks.
  const listener: ListenerState = {
    exposure: exposureFromHistory(
      history.map((entry) => ({
        videoId: entry.videoId,
        playCount: entry.playCount,
        completeCount: entry.completeCount,
        skipCount: entry.skipCount,
        lastPlayedAt: entry.lastPlayedAt,
      })),
    ),
    likes,
    now,
  };
  const slate = assembleSlate(scored, {
    limit,
    listener,
    maxPerArtist: Number.POSITIVE_INFINITY,
    ignorePools: true,
    temperature: 0,
  }).tracks;
  const tagVectors = await ensureTagVectors(
    slate.map((c) => ({ videoId: c.track.videoId, title: c.track.title, channel: c.track.channel })),
    createDbTagStore(),
  );
  const ordered = sequence(slate, 0, { transitionBias, tagVectors });
  return { tracks: ordered.map((candidate) => candidate.track) };
}

/**
 * Extend an in-flight radio queue by one page. Used when a long session
 * exhausts the first 50 tracks — the queue is genuinely unbounded.
 */
export async function continueRadio(
  continuation: string,
  exclude: string[] = [],
): Promise<{ tracks: MusicTrack[]; continuation: string | null }> {
  const page = await extendRadio(continuation);
  if (!page) return { tracks: [], continuation: null };
  const excluded = new Set(exclude);
  return {
    tracks: page.tracks.filter((track) => !excluded.has(track.videoId)),
    continuation: page.continuation,
  };
}
