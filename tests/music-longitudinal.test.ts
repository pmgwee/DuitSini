import { describe, expect, it } from "vitest";
import { assembleSlate, DISCOVERY_POOLS, type ListenerState } from "@/lib/music/objective";
import {
  buildExposure,
  type ImpressionEvent,
  type ListenEvent,
  type PlayOutcome,
} from "@/lib/music/exposure";
import {
  inferLanguage,
  learnLanguageMix,
  LEARNING_CONFIDENCE,
  type VocalLanguage,
} from "@/lib/music/language";
import { pickSeeds, primaryArtist, relevance } from "@/lib/music/ranking";
import type { Candidate, HistoryEntry } from "@/lib/music/types";
import type { MusicTrack } from "@/types/music";

/**
 * Ninety days of Listen Again, with the listener's responses fed back in.
 *
 * Every previous evaluation in this codebase measured ONE generated shelf:
 * "this like now causes neighbours", "a cold track sequences correctly", "this
 * shelf is 85% unseen once". All of them could pass while the lived experience
 * was a loop, because the loop is a property of the *sequence* of shelves and
 * of what the system learns from serving them. This test asks the longitudinal
 * question instead: after three months of serving and feedback, how much of
 * tomorrow's shelf is new?
 *
 * Fully deterministic and offline — a seeded RNG, a synthetic catalogue, and a
 * retrieval stub that reproduces the measured property that matters (a song
 * radio is ~deterministic per seed, so reusing seeds regenerates the same
 * neighbourhood). No network, no database, no production state.
 */

const DAY_MS = 86_400_000;
const START = Date.UTC(2026, 0, 1);
const SHELF = 40;

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// ── Synthetic catalogue ─────────────────────────────────────────────────────
// Titles carry real script so `inferLanguage` runs its actual code path rather
// than being handed a label.
const LANGUAGE_TITLES: Record<string, (i: number) => string> = {
  en: (i) => `Midnight Drive ${i}`,
  zh: (i) => `城市的光 ${i}`,
  ja: (i) => `ひかりの中で ${i}`,
};

interface CatalogTrack {
  track: MusicTrack;
  cluster: string;
  language: "en" | "zh" | "ja";
}

function buildCatalog(): CatalogTrack[] {
  const catalog: CatalogTrack[] = [];
  // 12 clusters × 3 languages × 20 tracks = 720 tracks, 36 artists.
  const languages: Array<"en" | "zh" | "ja"> = ["en", "zh", "ja"];
  for (let c = 0; c < 12; c++) {
    for (const language of languages) {
      for (let n = 0; n < 20; n++) {
        const id = `${language}-c${c}-t${n}`;
        catalog.push({
          track: {
            videoId: id,
            title: LANGUAGE_TITLES[language]!(n),
            channel: `${language.toUpperCase()} Artist ${c}`,
            thumbnail: null,
            source: "recommended",
          },
          cluster: `c${c}`,
          language,
        });
      }
    }
  }
  return catalog;
}

const CATALOG = buildCatalog();
const BY_ID = new Map(CATALOG.map((entry) => [entry.track.videoId, entry]));

/**
 * Deterministic "song radio": the same seed always yields the same 50 tracks,
 * drawn from the seed's own cluster plus a fixed adjacent cluster. This is the
 * measured behaviour the real sources have, and it is what makes seed choice —
 * not ranking — the thing that decides whether the pool can move at all.
 */
function radioFor(seedId: string): CatalogTrack[] {
  const seed = BY_ID.get(seedId);
  if (!seed) return [];
  const clusterIndex = Number(seed.cluster.slice(1));
  const adjacent = `c${(clusterIndex + 1) % 12}`;
  const pick = CATALOG.filter(
    (entry) =>
      (entry.cluster === seed.cluster || entry.cluster === adjacent) &&
      entry.track.videoId !== seedId,
  );
  // Stable ordering: a hash, not the RNG, so the "radio" never varies per call.
  return [...pick]
    .sort((a, b) => hash(a.track.videoId + seedId) - hash(b.track.videoId + seedId))
    .slice(0, 50);
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 2 ** 32;
}

/** A far-away cluster, standing in for the exploration fanout. */
function explorationFor(day: number): CatalogTrack[] {
  const cluster = `c${(day * 5) % 12}`;
  return CATALOG.filter((entry) => entry.cluster === cluster).slice(0, 20);
}

// ── Simulated listener ──────────────────────────────────────────────────────
/**
 * Taste is a fixed preference over clusters and languages. The listener is
 * multilingual on purpose: a dominant English taste with real, smaller Chinese
 * and Japanese interests, which is the shape ADR-0009 measured for the actual
 * primary listener (~81% EN / ~18% CN).
 */
const TASTE_CLUSTERS = new Set(["c0", "c1", "c2", "c5", "c8"]);
const LANGUAGE_TASTE: Record<string, number> = { en: 0.72, zh: 0.2, ja: 0.08 };

function affinityFor(entry: CatalogTrack): number {
  const cluster = TASTE_CLUSTERS.has(entry.cluster) ? 1 : 0.25;
  return cluster * (LANGUAGE_TASTE[entry.language] ?? 0.1);
}

interface SimulationResult {
  shelves: string[][];
  discoverySlots: number;
  unseenDiscoverySlots: number;
  newArtistsOverTime: number;
  acceptedDiscoveries: Set<string>;
  revisitedDiscoveries: Set<string>;
  languagesServed: Map<VocalLanguage, number>;
  languagesAccepted: Map<VocalLanguage, number>;
  repeatWithin7d: number;
  everPlayedSlots: number;
  servedSlots: number;
  backfilled: number;
  backfilledFamiliar: number;
}

function simulate(days: number, seed: number): SimulationResult {
  const random = rng(seed);
  const listens: ListenEvent[] = [];
  const impressions: ImpressionEvent[] = [];
  const likes = new Set<string>();
  const everPlayed = new Set<string>();
  const seedCooldown = new Map<string, number>();
  const seenArtists = new Set<string>();

  const shelves: string[][] = [];
  const acceptedDiscoveries = new Set<string>();
  const revisitedDiscoveries = new Set<string>();
  const languagesServed = new Map<VocalLanguage, number>();
  const languagesAccepted = new Map<VocalLanguage, number>();
  let discoverySlots = 0;
  let unseenDiscoverySlots = 0;
  let newArtistsOverTime = 0;
  let repeatWithin7d = 0;
  let everPlayedSlots = 0;
  let servedSlots = 0;
  let backfilled = 0;
  let backfilledFamiliar = 0;

  // Day 0 bootstrap: a handful of plays so seeds exist at all.
  for (let i = 0; i < 6; i++) {
    const entry = CATALOG.find((c) => c.cluster === "c0" && c.language === "en" && c.track.videoId.endsWith(`t${i}`))!;
    listens.push({
      videoId: entry.track.videoId,
      at: START,
      origin: "manual",
      outcome: "completed",
      durationRatio: 1,
    });
    everPlayed.add(entry.track.videoId);
  }

  for (let day = 1; day <= days; day++) {
    const now = START + day * DAY_MS;
    const exposure = buildExposure({ listens, impressions }, now, everPlayed);

    // Seeds come from real play history, exactly as production does.
    const history: HistoryEntry[] = [...everPlayed]
      .map((id) => {
        const record = exposure.get(id)!;
        const entry = BY_ID.get(id)!;
        return {
          videoId: id,
          title: entry.track.title,
          channel: entry.track.channel,
          thumbnail: null,
          playCount: record.completions + record.passivePlays + record.deliberatePlays,
          completeCount: record.completions,
          skipCount: record.earlySkips,
          lastPlayedAt: new Date(record.lastPlayAt ?? START).toISOString(),
        } satisfies HistoryEntry;
      })
      .sort((a, b) => Date.parse(b.lastPlayedAt) - Date.parse(a.lastPlayedAt));

    const seeds = pickSeeds(history, 6, now, { random, likes, seedCooldown });
    for (const s of seeds) seedCooldown.set(s.videoId, now);

    // Retrieval.
    const pool = new Map<string, Candidate>();
    const explorationIds = new Set<string>();
    const addMany = (tracks: CatalogTrack[], sourceId: string, seedWeight: number, explore = false) => {
      tracks.forEach((entry, rank) => {
        if (explore) explorationIds.add(entry.track.videoId);
        const existing = pool.get(entry.track.videoId);
        const occurrence = { sourceId, origin: "radio" as const, rank, seedWeight };
        if (existing) existing.occurrences.push(occurrence);
        else pool.set(entry.track.videoId, { track: entry.track, occurrences: [occurrence] });
      });
    };
    for (const s of seeds) addMany(radioFor(s.videoId), `radio:${s.videoId}`, s.playCount || 1);
    addMany(explorationFor(day), `explore:${day}`, 1, true);

    const candidates = [...pool.values()];
    const scored = candidates.map((candidate) => ({ candidate, value: relevance(candidate) }));

    const labels = new Map(
      candidates.map((c) => [c.track.videoId, inferLanguage({ title: c.track.title, channel: c.track.channel })]),
    );
    for (const id of everPlayed) {
      if (labels.has(id)) continue;
      const entry = BY_ID.get(id)!;
      labels.set(id, inferLanguage({ title: entry.track.title, channel: entry.track.channel }));
    }

    const observations = listens
      .filter((event) => event.outcome === "completed" || event.outcome === "substantial")
      .filter((event) => (labels.get(event.videoId)?.confidence ?? 0) >= LEARNING_CONFIDENCE)
      .map((event) => ({
        language: labels.get(event.videoId)?.language ?? ("unknown" as VocalLanguage),
        at: event.at,
        weight: event.origin === "manual" ? 1 : 0.3,
      }))
      .filter((o) => o.language !== "unknown");
    const languageTarget = learnLanguageMix(observations, { now });

    const listener: ListenerState = {
      exposure,
      likes,
      now,
      languages: labels,
      languageTarget,
      clusterOf: (track) => BY_ID.get(track.videoId)?.cluster ?? primaryArtist(track.channel),
      explorationIds,
    };

    const assembled = assembleSlate(scored, { limit: SHELF, listener, random });
    backfilled += assembled.backfilled;
    backfilledFamiliar += assembled.backfilledFamiliar;
    shelves.push(assembled.tracks.map((c) => c.track.videoId));

    // Serve: every slot is an impression, whether or not it is played.
    assembled.slots.forEach((slot, position) => {
      const id = slot.candidate.track.videoId;
      impressions.push({ videoId: id, at: now, position });
      servedSlots += 1;
      const language = labels.get(id)?.language ?? "unknown";
      languagesServed.set(language, (languagesServed.get(language) ?? 0) + 1);

      const wasPlayed = everPlayed.has(id);
      if (DISCOVERY_POOLS.includes(slot.pool)) {
        discoverySlots += 1;
        if (!wasPlayed) unseenDiscoverySlots += 1;
      }
      if (wasPlayed) {
        everPlayedSlots += 1;
        const record = exposure.get(id);
        if (record?.lastPlayAt && now - record.lastPlayAt <= 7 * DAY_MS) repeatWithin7d += 1;
      }
      const artist = primaryArtist(slot.candidate.track.channel);
      if (!seenArtists.has(artist)) {
        seenArtists.add(artist);
        newArtistsOverTime += 1;
      }
    });

    // Listener response: play the first ~8 slots they find appealing.
    let played = 0;
    for (const slot of assembled.slots) {
      if (played >= 8) break;
      const entry = BY_ID.get(slot.candidate.track.videoId);
      if (!entry) continue;
      const appeal = affinityFor(entry);
      if (random() > appeal) continue;
      played += 1;
      const wasNew = !everPlayed.has(entry.track.videoId);
      // Enjoyment is taste-driven; a poor match is abandoned early.
      const roll = random();
      const outcome: PlayOutcome =
        roll < appeal * 0.85 ? "completed" : roll < appeal * 0.85 + 0.2 ? "substantial" : "early_skip";
      listens.push({
        videoId: entry.track.videoId,
        at: now + played * 60_000,
        origin: played === 0 ? "manual" : "autoplay",
        outcome,
        durationRatio: outcome === "completed" ? 1 : outcome === "substantial" ? 0.6 : 0.1,
      });
      const language = labels.get(entry.track.videoId)?.language ?? "unknown";
      if (outcome !== "early_skip") {
        languagesAccepted.set(language, (languagesAccepted.get(language) ?? 0) + 1);
        if (wasNew) acceptedDiscoveries.add(entry.track.videoId);
        else if (acceptedDiscoveries.has(entry.track.videoId)) {
          revisitedDiscoveries.add(entry.track.videoId);
        }
      }
      everPlayed.add(entry.track.videoId);
      if (outcome === "completed" && random() < 0.08) likes.add(entry.track.videoId);
    }
  }

  return {
    shelves,
    discoverySlots,
    unseenDiscoverySlots,
    newArtistsOverTime,
    acceptedDiscoveries,
    revisitedDiscoveries,
    languagesServed,
    languagesAccepted,
    repeatWithin7d,
    everPlayedSlots,
    servedSlots,
    backfilled,
    backfilledFamiliar,
  };
}

function meanJaccard(shelves: string[][], lag = 1): number {
  let total = 0;
  let pairs = 0;
  for (let i = lag; i < shelves.length; i++) {
    const a = new Set(shelves[i - lag]);
    const b = new Set(shelves[i]);
    const intersection = [...a].filter((id) => b.has(id)).length;
    total += intersection / (a.size + b.size - intersection);
    pairs += 1;
  }
  return pairs === 0 ? 0 : total / pairs;
}

describe("Listen Again over 90 days of use", () => {
  const result = simulate(90, 7);
  const report = {
    days: result.shelves.length,
    unseenDiscoveryShare: result.unseenDiscoverySlots / result.discoverySlots,
    everPlayedSlateShare: result.everPlayedSlots / result.servedSlots,
    repeatWithin7dShare: result.repeatWithin7d / result.servedSlots,
    meanConsecutiveJaccard: meanJaccard(result.shelves),
    meanWeeklyJaccard: meanJaccard(result.shelves, 7),
    distinctArtistsServed: result.newArtistsOverTime,
    acceptedDiscoveries: result.acceptedDiscoveries.size,
    revisitedDiscoveries: result.revisitedDiscoveries.size,
    backfillShare: result.backfilled / result.servedSlots,
    familiarBackfillShare: result.backfilledFamiliar / result.servedSlots,
    languagesServed: Object.fromEntries(result.languagesServed),
    languagesAccepted: Object.fromEntries(result.languagesAccepted),
  };

  it("reports its longitudinal measurements", () => {
    console.log(JSON.stringify(report, null, 2));
    expect(report.days).toBe(90);
  });

  it("keeps most discovery slots genuinely new to the listener", () => {
    // The headline property. A discovery slot filled by a track they have
    // already played is the defect, whatever its affinity score.
    expect(report.unseenDiscoveryShare).toBeGreaterThan(0.6);
  });

  it("does not re-serve what was played in the last seven days", () => {
    expect(report.repeatWithin7dShare).toBeLessThan(0.2);
  });

  it("keeps consecutive and week-apart shelves from converging", () => {
    expect(report.meanConsecutiveJaccard).toBeLessThan(0.5);
    expect(report.meanWeeklyJaccard).toBeLessThan(0.5);
  });

  it("reaches beyond the seeded neighbourhood over time", () => {
    // 36 artists exist; a system trapped in its own bubble reaches very few.
    expect(report.distinctArtistsServed).toBeGreaterThan(20);
  });

  it("produces discoveries the listener accepts and later returns to", () => {
    expect(report.acceptedDiscoveries).toBeGreaterThan(30);
    expect(report.revisitedDiscoveries).toBeGreaterThan(0);
  });

  it("sustains all three languages the listener actually accepts", () => {
    // The anti-erasure property: a 72/20/8 taste must not collapse to English.
    for (const language of ["en", "zh", "ja"] as const) {
      expect(result.languagesServed.get(language) ?? 0).toBeGreaterThan(0);
      expect(result.languagesAccepted.get(language) ?? 0).toBeGreaterThan(0);
    }
    const served = result.languagesServed;
    const total = [...served.values()].reduce((sum, value) => sum + value, 0);
    const minorityShare = ((served.get("zh") ?? 0) + (served.get("ja") ?? 0)) / total;
    expect(minorityShare).toBeGreaterThan(0.1);
  });

  it("keeps the shelf mostly unfamiliar after three months of use", () => {
    /*
     * The headline outcome, measured directly on what the listener sees.
     *
     * An earlier version of this test bounded `backfillShare` instead. That was
     * measuring the wrong thing twice over: backfill counts slots that left
     * their designated pool, which is dominated here by the per-artist cap
     * redirecting one unseen track to another — the cap working, not a failure
     * — and it says nothing about what actually reached the shelf. The defect
     * is familiar music filling the shelf, so the bound is on familiar music
     * filling the shelf. The quotas intend ~15% (familiar-anchor plus
     * rediscovery), so 30% is a real ceiling, not a formality: the broken
     * architecture measured 96.9% on the equivalent probe.
     */
    expect(report.everPlayedSlateShare).toBeLessThan(0.3);
  });

  it("attributes where familiar slots come from", () => {
    // Reported for attribution rather than bounded on its own: it exists to say
    // WHY the number above moved, not to be a second, weaker version of it.
    expect(report.familiarBackfillShare).toBeLessThanOrEqual(report.everPlayedSlateShare);
  });

  it("is deterministic for a given seed", () => {
    const again = simulate(20, 11);
    const once = simulate(20, 11);
    expect(again.shelves).toEqual(once.shelves);
  });
});
