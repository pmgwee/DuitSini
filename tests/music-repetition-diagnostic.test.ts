import { describe, expect, it } from "vitest";
import { assembleSlate, utility, type ListenerState } from "@/lib/music/objective";
import { exposureFromHistory, emptyExposure } from "@/lib/music/exposure";
import { relevance } from "@/lib/music/ranking";
import type { Candidate, HistoryEntry } from "@/lib/music/types";

/*
 * Health bounds for the Listen Again repetition defect.
 *
 * Still opt-in, and the bounds are UNCHANGED from the original diagnostic
 * (50% previously-played share, 65% consecutive-shelf Jaccard, an evicted old
 * play must score below a genuinely unseen track), as is the fixture: 28
 * previously played candidates against 12 unseen, five plays and four
 * completions each, one in four liked, 20 slots, 50 deterministic seeds.
 *
 * What changed is the SEAM. The original probes called
 * `assemble(scored, opts)`, which took no listener state at all — so the third
 * probe could not even express its own question: with no durable memory passed
 * in, an evicted old play and an unseen track are the same object to the
 * assembler, and no implementation could distinguish them. That shallowness was
 * the finding, not a detail of the harness. The architecture now carries
 * exposure explicitly, so the probes supply it and assert against the real
 * decision point.
 */
const healthIt = process.env.RECOMMENDER_HEALTH_CHECK === "1" ? it : it.skip;

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 13);

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function historyEntry(index: number, daysAgo: number): HistoryEntry {
  return {
    videoId: `seen-${index}`,
    title: `Seen ${index}`,
    channel: `Artist ${index}`,
    thumbnail: null,
    playCount: 5,
    completeCount: 4,
    skipCount: 0,
    lastPlayedAt: new Date(NOW - daysAgo * DAY_MS).toISOString(),
  };
}

function candidate(videoId: string, index: number): Candidate {
  return {
    track: {
      videoId,
      title: videoId,
      channel: `Artist ${index}`,
      thumbnail: null,
      source: "recommended",
    },
    occurrences: [{ sourceId: `radio-${index}`, origin: "radio", rank: 0, seedWeight: 1 }],
  };
}

function fixture(daysAgo: number, withLikes: boolean) {
  const history = Array.from({ length: 28 }, (_, i) => historyEntry(i, daysAgo));
  const seenIds = new Set(history.map((entry) => entry.videoId));
  const likes = new Set(
    withLikes ? history.filter((_, i) => i % 4 === 0).map((entry) => entry.videoId) : [],
  );
  const listener: ListenerState = {
    exposure: exposureFromHistory(history, seenIds),
    likes,
    now: NOW,
  };
  const pool = [
    ...history.map((entry, i) => candidate(entry.videoId, i)),
    ...Array.from({ length: 12 }, (_, i) => candidate(`new-${i}`, i + 28)),
  ];
  const scored = pool.map((item) => ({ candidate: item, value: relevance(item) }));
  return { listener, scored, seenIds };
}

function overlapFor(daysAgo: number): number {
  const { listener, scored, seenIds } = fixture(daysAgo, true);
  let repeats = 0;
  let slots = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const slate = assembleSlate(scored, { limit: 20, listener, random: rng(seed) });
    repeats += slate.tracks.filter((item) => seenIds.has(item.track.videoId)).length;
    slots += slate.tracks.length;
  }
  return repeats / slots;
}

function meanConsecutiveJaccard(daysAgo: number): number {
  const { listener, scored } = fixture(daysAgo, false);
  const slates = Array.from({ length: 50 }, (_, seed) =>
    assembleSlate(scored, { limit: 20, listener, random: rng(seed + 1) }).tracks.map(
      (item) => item.track.videoId,
    ),
  );
  let total = 0;
  for (let i = 1; i < slates.length; i++) {
    const a = new Set(slates[i - 1]);
    const b = new Set(slates[i]);
    const intersection = [...a].filter((id) => b.has(id)).length;
    total += intersection / (a.size + b.size - intersection);
  }
  return total / (slates.length - 1);
}

describe("steady-state Listen Again repetition diagnostic", () => {
  healthIt("keeps the previously-played share under the discovery bound at every age", () => {
    const overlapByAge = Object.fromEntries(
      [1, 7, 13, 14, 15, 20, 30].map((days) => [days, overlapFor(days)]),
    );
    console.log(JSON.stringify({ overlapByAge, healthyMaximum: 0.5 }, null, 2));
    expect(overlapByAge[1]).toBeLessThan(0.5);
    expect(overlapByAge[20]).toBeLessThan(0.5);
  });

  healthIt("varies consecutive shelves inside a stable candidate pool", () => {
    const meanJaccard = meanConsecutiveJaccard(20);
    console.log(
      JSON.stringify({ meanConsecutiveJaccard: meanJaccard, healthyMaximum: 0.65 }, null, 2),
    );
    expect(meanJaccard).toBeLessThan(0.65);
  });

  healthIt("ranks an old play evicted from the history window below an unseen song", () => {
    // The durable ever-played set is the whole point: this track fell out of the
    // 60-row window years ago and carries no recent counters, exactly like the
    // rows that used to score 1.0 — identical to a song never heard.
    const evicted = emptyExposure("evicted-old-play");
    evicted.everPlayed = true;
    evicted.lastPlayAt = NOW - 400 * DAY_MS;
    evicted.lastMeaningfulPlayAt = NOW - 400 * DAY_MS;

    const listener: ListenerState = {
      exposure: new Map([["evicted-old-play", evicted]]),
      likes: new Set(),
      now: NOW,
    };
    const context = {
      dominantLanguage: null,
      placedLanguages: new Map(),
      slots: 20,
    };
    const old = candidate("evicted-old-play", 1);
    const unseen = candidate("genuinely-unseen", 2);
    const evictedOldPlay = utility({ candidate: old, value: relevance(old) }, listener, context)
      .total;
    const genuinelyUnseen = utility({ candidate: unseen, value: relevance(unseen) }, listener, context)
      .total;
    console.log(JSON.stringify({ evictedOldPlay, genuinelyUnseen }, null, 2));
    expect(evictedOldPlay).toBeLessThan(genuinelyUnseen);
  });
});
