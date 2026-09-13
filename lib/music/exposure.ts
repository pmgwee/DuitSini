/**
 * Exposure memory and repeat readiness.
 *
 * The recommender knew what the listener liked. It did not know what it had
 * already *shown* them. Those are different questions, and conflating them is
 * what turns a discovery shelf into a carousel: affinity only ever grows, so
 * once a track accumulates plays it outranks an equivalent unseen track for
 * ever, and the shelf converges on a neighbourhood it already exhausted.
 *
 * The product distinction this module encodes:
 *
 *   affinity        — does this belong in the listener's taste graph?
 *   repeat readiness — should it be served *now*?
 *
 * Repeat readiness is deliberately not a binary seen/unseen flag. Music is one
 * of the few domains where users intentionally replay favourites, and banning
 * everything already heard produces a shelf of strangers (Schedl et al., ISMIR
 * 2020, found that resurfacing an enjoyed discovery increases later revisiting).
 * So a well-loved track becomes eligible again *sooner* than a merely-tolerated
 * one, while repeated impressions that never convert push it further away
 * (the fatigue effect measured by Ma, Liu & Shen, 2016).
 *
 * Everything here is pure and clock-injected so the longitudinal simulation can
 * run months of behaviour deterministically.
 */

export const DAY_MS = 86_400_000;

/**
 * Where a playback start came from. Autoplay is not a taste endorsement.
 *
 * `unknown` is a real state, not a default to be cleaned up later: events from
 * a client that predates origin reporting genuinely do not know, and they are
 * treated as passive rather than being optimistically counted as chosen.
 */
export type PlayOrigin = "manual" | "search" | "playlist" | "autoplay" | "radio" | "unknown";

/**
 * What actually happened during a play.
 *
 * `substantial` is the state the old schema could not express: the listener
 * stayed past the 30-second skip window but did not reach the end. Previously
 * that was recorded as neither skip nor completion — it vanished.
 */
export type PlayOutcome =
  | "completed"
  | "substantial"
  | "late_skip"
  | "early_skip"
  | "unknown";

/** One playback event. Immutable; aggregates are projections of these. */
export interface ListenEvent {
  videoId: string;
  /** Epoch ms. */
  at: number;
  origin: PlayOrigin;
  outcome: PlayOutcome;
  /** Fraction of the track actually played, 0..1. */
  durationRatio: number;
}

/** One served recommendation slot. Shown is evidence even when nothing plays. */
export interface ImpressionEvent {
  videoId: string;
  at: number;
  /** Position in the served slate, 0-based. */
  position: number;
}

/**
 * Everything the ranker needs to know about one track's history with this
 * listener, already reduced to rolling windows.
 *
 * `everPlayed` is separate from the windowed counts on purpose. The old
 * 60-row history window meant a track played 200 times last year scored
 * identically to one the listener has never heard — the single most damaging
 * consequence of treating an aggregate table as the memory.
 */
export interface ExposureRecord {
  videoId: string;
  /** Durable, never windowed: has this listener ever played this track? */
  everPlayed: boolean;
  impressions1d: number;
  impressions7d: number;
  impressions30d: number;
  lastImpressionAt: number | null;
  plays7d: number;
  plays30d: number;
  plays90d: number;
  lastPlayAt: number | null;
  /** Last completed-or-substantial play. A skip does not count as enjoyment. */
  lastMeaningfulPlayAt: number | null;
  completions: number;
  earlySkips: number;
  lateSkips: number;
  /** Plays the listener actively chose. Weighted far above autoplay. */
  deliberatePlays: number;
  /** Plays that merely happened to them (autoplay / radio continuation). */
  passivePlays: number;
}

export function emptyExposure(videoId: string): ExposureRecord {
  return {
    videoId,
    everPlayed: false,
    impressions1d: 0,
    impressions7d: 0,
    impressions30d: 0,
    lastImpressionAt: null,
    plays7d: 0,
    plays30d: 0,
    plays90d: 0,
    lastPlayAt: null,
    lastMeaningfulPlayAt: null,
    completions: 0,
    earlySkips: 0,
    lateSkips: 0,
    deliberatePlays: 0,
    passivePlays: 0,
  };
}

/** The skip window both Spotify and Apple treat as the strongest negative. */
export const EARLY_SKIP_MS = 30_000;
/** Below this share of a track, leaving reads as giving up rather than moving on. */
export const SUBSTANTIAL_RATIO = 0.5;

/**
 * Classify a play the listener has left, from elapsed time and track length.
 *
 * Pure and separate from the player on purpose. The IFrame API call that
 * supplies `totalSec` can throw when the embed has been re-parented, and this
 * runs inside the track-change path — so the decision lives here where it can
 * be tested, and the throwing call stays at the edge where it can be caught.
 *
 * `totalSec <= 0` means the duration was unavailable (or unreadable). Ratio is
 * then 0, which degrades to the old time-only behaviour rather than inventing
 * a number: under the skip window it is an early skip, past it a late skip.
 */
export function classifyPlayback(
  playedMs: number,
  totalSec: number,
): { outcome: PlayOutcome; signal: "skip" | "complete"; durationRatio: number } {
  const ratio =
    totalSec > 0 ? Math.max(0, Math.min(1, playedMs / 1000 / totalSec)) : 0;
  if (playedMs < EARLY_SKIP_MS) {
    return { outcome: "early_skip", signal: "skip", durationRatio: ratio };
  }
  if (ratio >= SUBSTANTIAL_RATIO) {
    return { outcome: "substantial", signal: "complete", durationRatio: ratio };
  }
  return { outcome: "late_skip", signal: "skip", durationRatio: ratio };
}

/** A play the listener chose, as opposed to one the player handed them. */
export function isDeliberate(origin: PlayOrigin): boolean {
  return origin === "manual" || origin === "search" || origin === "playlist";
}

/** Did the listener actually consume this, whatever started it? */
export function isMeaningful(outcome: PlayOutcome): boolean {
  return outcome === "completed" || outcome === "substantial";
}

/**
 * Fold immutable events into per-track windows.
 *
 * Impressions and plays are folded together because fatigue is driven by both:
 * being shown a track ten times and ignoring it is stronger evidence of
 * satiation than never having seen it at all.
 */
export function buildExposure(
  events: { listens: readonly ListenEvent[]; impressions: readonly ImpressionEvent[] },
  now: number,
  everPlayedIds: ReadonlySet<string> = new Set(),
): Map<string, ExposureRecord> {
  const records = new Map<string, ExposureRecord>();
  const of = (videoId: string): ExposureRecord => {
    let record = records.get(videoId);
    if (!record) {
      record = emptyExposure(videoId);
      record.everPlayed = everPlayedIds.has(videoId);
      records.set(videoId, record);
    }
    return record;
  };

  for (const id of everPlayedIds) of(id);

  for (const impression of events.impressions) {
    const record = of(impression.videoId);
    const age = now - impression.at;
    if (age < 0) continue;
    if (age <= DAY_MS) record.impressions1d += 1;
    if (age <= 7 * DAY_MS) record.impressions7d += 1;
    if (age <= 30 * DAY_MS) record.impressions30d += 1;
    record.lastImpressionAt = Math.max(record.lastImpressionAt ?? 0, impression.at) || impression.at;
  }

  for (const listen of events.listens) {
    const record = of(listen.videoId);
    const age = now - listen.at;
    if (age < 0) continue;
    record.everPlayed = true;
    if (age <= 7 * DAY_MS) record.plays7d += 1;
    if (age <= 30 * DAY_MS) record.plays30d += 1;
    if (age <= 90 * DAY_MS) record.plays90d += 1;
    record.lastPlayAt = Math.max(record.lastPlayAt ?? 0, listen.at) || listen.at;
    if (isMeaningful(listen.outcome)) {
      record.lastMeaningfulPlayAt =
        Math.max(record.lastMeaningfulPlayAt ?? 0, listen.at) || listen.at;
    }
    if (listen.outcome === "completed") record.completions += 1;
    if (listen.outcome === "early_skip") record.earlySkips += 1;
    if (listen.outcome === "late_skip") record.lateSkips += 1;
    if (isDeliberate(listen.origin)) record.deliberatePlays += 1;
    else record.passivePlays += 1;
  }

  return records;
}

/**
 * Project the legacy aggregate table into exposure records.
 *
 * `music_plays` predates the event stream, so it cannot say whether a play was
 * chosen or merely autoplayed. Those plays are therefore counted as PASSIVE,
 * which is the conservative reading in both directions that matter: it lowers
 * affinity (less repetition) and lengthens the cooldown (slower return). Under-
 * claiming enjoyment from ambiguous history is the safe error; over-claiming it
 * is precisely how the carousel formed.
 *
 * `everPlayedIds` must come from an UNWINDOWED query. The whole point is that a
 * track played 200 times last year is not a discovery, and the 60-row window
 * made it indistinguishable from one.
 */
export function exposureFromHistory(
  history: readonly {
    videoId: string;
    playCount: number;
    completeCount: number;
    skipCount: number;
    lastPlayedAt: string;
  }[],
  everPlayedIds: ReadonlySet<string> = new Set(),
  now: number = Date.now(),
): Map<string, ExposureRecord> {
  const records = new Map<string, ExposureRecord>();
  for (const id of everPlayedIds) {
    const record = emptyExposure(id);
    record.everPlayed = true;
    records.set(id, record);
  }
  for (const entry of history) {
    const record = records.get(entry.videoId) ?? emptyExposure(entry.videoId);
    const at = Date.parse(entry.lastPlayedAt);
    const lastPlayedAt = Number.isFinite(at) ? at : null;
    record.everPlayed = true;
    record.completions = entry.completeCount;
    record.earlySkips = entry.skipCount;
    record.passivePlays = Math.max(0, entry.playCount - entry.completeCount);
    record.lastPlayAt = lastPlayedAt;
    // A completion is the only evidence of real consumption the aggregate has.
    record.lastMeaningfulPlayAt = entry.completeCount > 0 ? lastPlayedAt : null;
    /*
     * The aggregate cannot say HOW MANY plays fell in each window — it keeps
     * one timestamp — but it can say that at least one did. Leaving these at
     * zero made every impression look unconverted, so a track the listener had
     * just played accrued fatigue as though they had ignored it.
     */
    if (lastPlayedAt !== null) {
      const age = now - lastPlayedAt;
      if (age >= 0) {
        if (age <= 7 * DAY_MS) record.plays7d = Math.max(record.plays7d, 1);
        if (age <= 30 * DAY_MS) record.plays30d = Math.max(record.plays30d, 1);
        if (age <= 90 * DAY_MS) record.plays90d = Math.max(record.plays90d, 1);
      }
    }
    records.set(entry.videoId, record);
  }
  return records;
}

/** Merge event-derived exposure over legacy-derived exposure; events win. */
export function mergeExposure(
  legacy: ReadonlyMap<string, ExposureRecord>,
  events: ReadonlyMap<string, ExposureRecord>,
): Map<string, ExposureRecord> {
  const merged = new Map(legacy);
  for (const [videoId, record] of events) {
    const base = merged.get(videoId);
    if (!base) {
      merged.set(videoId, record);
      continue;
    }
    merged.set(videoId, {
      ...record,
      everPlayed: base.everPlayed || record.everPlayed,
      // Legacy counters cover the period before the event stream existed, so
      // they are added rather than replaced — otherwise switching on events
      // would erase every play that came before it.
      completions: base.completions + record.completions,
      earlySkips: base.earlySkips + record.earlySkips,
      passivePlays: base.passivePlays + record.passivePlays,
      // Windowed counts: the aggregate contributes "at least one", the events
      // contribute exact counts. Taking the max keeps whichever knows more.
      plays7d: Math.max(base.plays7d, record.plays7d),
      plays30d: Math.max(base.plays30d, record.plays30d),
      plays90d: Math.max(base.plays90d, record.plays90d),
      lastPlayAt: Math.max(base.lastPlayAt ?? 0, record.lastPlayAt ?? 0) || null,
      lastMeaningfulPlayAt:
        Math.max(base.lastMeaningfulPlayAt ?? 0, record.lastMeaningfulPlayAt ?? 0) || null,
    });
  }
  return merged;
}

/**
 * How much the listener has demonstrably enjoyed this track, 0..1.
 *
 * Deliberate plays and completions raise it; skips lower it. Autoplay plays
 * count for a fraction of a chosen one — a track that played because the queue
 * reached it is weak evidence, and treating it as equal is how a passive
 * background session silently rewrites the taste profile.
 */
export function enjoyment(record: ExposureRecord, liked = false): number {
  const positive =
    record.completions * 1 +
    record.deliberatePlays * 0.8 +
    record.passivePlays * 0.15 +
    (liked ? 4 : 0);
  const negative = record.earlySkips * 2 + record.lateSkips * 0.75;
  const net = positive - negative;
  if (net <= 0) return 0;
  // Saturating: the difference between 20 and 40 plays is not worth twice the
  // difference between 0 and 20, and letting it grow without bound is exactly
  // how affinity overtook every freshness term.
  return net / (net + 6);
}

/**
 * Satiation from being shown a track without it being played.
 *
 * Impressions that convert are not fatiguing — the listener wanted it. Only the
 * unconverted surplus counts, which is why this subtracts recent plays.
 */
export function impressionFatigue(record: ExposureRecord): number {
  const unconverted = Math.max(0, record.impressions7d - record.plays7d);
  const monthlyUnconverted = Math.max(0, record.impressions30d - record.plays30d);
  return Math.min(1, unconverted * 0.22 + monthlyUnconverted * 0.05);
}

export interface ReadinessOptions {
  /** Explicitly liked — gets a shorter cooldown, never an exemption. */
  liked?: boolean;
  /**
   * Days before a merely-tolerated track is fully eligible again. A loved track
   * scales this down; a skipped one scales it up.
   */
  baseCooldownDays?: number;
}

/**
 * Should this track be served now? 0 = far too soon, 1 = fully eligible.
 *
 * A never-played track is always 1: it has nothing to recover from. For a
 * played track readiness recovers on an exponential curve whose half-life is
 * set by how much the listener actually enjoyed it, then is pushed back down by
 * unconverted impressions.
 *
 * This replaces `min(1, max(floor, daysSince / 14))`, which was linear, capped
 * at 1, and — because affinity was an uncapped multiplier applied afterwards —
 * could not prevent a well-played track outscoring an unseen one by day seven.
 */
export function repeatReadiness(
  record: ExposureRecord | undefined,
  now: number,
  options: ReadinessOptions = {},
): number {
  if (!record || !record.everPlayed) return 1;
  const { liked = false, baseCooldownDays = 21 } = options;

  const love = enjoyment(record, liked);
  // Loved tracks return sooner (down to ~35% of the base wait), disliked ones
  // much later (up to 2.5×). This is the repeat-readiness curve: it encodes
  // "bring back what they loved" without encoding "bring back what they played".
  const scale = 2.5 - 2.15 * love;
  const halfLifeDays = Math.max(1.5, baseCooldownDays * scale * 0.5);

  const reference = record.lastMeaningfulPlayAt ?? record.lastPlayAt;
  if (reference === null) return 1;
  const daysSince = Math.max(0, (now - reference) / DAY_MS);
  const recovered = 1 - Math.pow(0.5, daysSince / halfLifeDays);

  const fatigued = recovered * (1 - impressionFatigue(record));
  return Math.min(1, Math.max(0, fatigued));
}

/** Coarse class used for pool assignment and for the diagnostics. */
export type NoveltyClass = "unseen" | "rediscovery" | "familiar" | "fatigued";

export function noveltyClass(
  record: ExposureRecord | undefined,
  now: number,
  options: ReadinessOptions = {},
): NoveltyClass {
  if (!record || !record.everPlayed) return "unseen";
  const readiness = repeatReadiness(record, now, options);
  if (readiness >= 0.7) return "rediscovery";
  if (readiness >= 0.25) return "familiar";
  return "fatigued";
}

/**
 * Rolling pressure for a group key (artist or semantic cluster).
 *
 * Exact-track fatigue is not enough: serving twelve different songs by the same
 * artist, or twelve tracks from one cluster, is the same experience as serving
 * one song twelve times. Keyed generically so artists and clusters share it.
 */
export function groupPressure(
  counts: { shown7d: number; shown30d: number; played7d: number },
  target: number,
): number {
  const surplus = Math.max(0, counts.shown7d - target);
  const monthlySurplus = Math.max(0, counts.shown30d - target * 3);
  // Played is mild relief: the listener is engaging with this group, so the
  // concentration is at least partly wanted.
  const relief = Math.min(0.4, counts.played7d * 0.08);
  return Math.max(0, Math.min(1, surplus * 0.12 + monthlySurplus * 0.03 - relief));
}
