import { describe, expect, it } from "vitest";
import {
  buildExposure,
  classifyPlayback,
  exposureFromHistory,
  impressionFatigue,
  mergeExposure,
  repeatReadiness,
  EARLY_SKIP_MS,
  type ImpressionEvent,
  type ListenEvent,
} from "@/lib/music/exposure";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 14);

describe("classifyPlayback", () => {
  it("treats an abandon inside the skip window as the strongest negative", () => {
    expect(classifyPlayback(4_000, 210).outcome).toBe("early_skip");
    expect(classifyPlayback(EARLY_SKIP_MS - 1, 210).signal).toBe("skip");
  });

  it("separates a substantial listen from a late abandon", () => {
    // Both are past the skip window, and BOTH used to be recorded as nothing —
    // leaving at 0:31 and listening to 95% were the same (invisible) event.
    expect(classifyPlayback(40_000, 200).outcome).toBe("late_skip");
    expect(classifyPlayback(150_000, 200).outcome).toBe("substantial");
    expect(classifyPlayback(150_000, 200).signal).toBe("complete");
  });

  it("degrades to time-only when the duration cannot be read", () => {
    // `getDuration` throws when the embed has been re-parented; the caller
    // catches and passes 0. That must not invent a ratio.
    expect(classifyPlayback(5_000, 0)).toEqual({
      outcome: "early_skip",
      signal: "skip",
      durationRatio: 0,
    });
    expect(classifyPlayback(200_000, 0).outcome).toBe("late_skip");
    expect(classifyPlayback(200_000, 0).durationRatio).toBe(0);
  });

  it("never reports a ratio outside 0..1", () => {
    // A track resumed mid-way can report more elapsed time than its length.
    expect(classifyPlayback(900_000, 120).durationRatio).toBe(1);
    expect(classifyPlayback(-5_000, 120).durationRatio).toBe(0);
  });
});

describe("legacy aggregates survive the switch to an event stream", () => {
  const aggregates = [
    {
      videoId: "long-loved",
      playCount: 40,
      completeCount: 30,
      skipCount: 0,
      lastPlayedAt: new Date(NOW - 3 * DAY_MS).toISOString(),
    },
  ];

  it("keeps counters that predate the stream instead of flattening them", () => {
    // The event stream starts empty at deploy. If exposure is taken from events
    // alone, years of completions collapse to a bare "ever played" flag at
    // exactly the moment the recommender starts trusting exposure.
    const legacy = exposureFromHistory(aggregates, new Set(["long-loved"]), NOW);
    const events = buildExposure({ listens: [], impressions: [] }, NOW, new Set(["long-loved"]));
    const merged = mergeExposure(legacy, events);
    const record = merged.get("long-loved")!;

    expect(record.everPlayed).toBe(true);
    expect(record.completions).toBe(30);
    expect(record.lastMeaningfulPlayAt).toBe(NOW - 3 * DAY_MS);
    // Recently played and well loved: not ready to be served again yet.
    expect(repeatReadiness(record, NOW)).toBeLessThan(0.5);
  });

  it("counts a recent aggregate play as converting its impressions", () => {
    /*
     * The aggregate keeps one timestamp, not per-window counts. Leaving the
     * windows at zero made every impression look unconverted, so a track the
     * listener had just played accrued fatigue as though they had ignored it —
     * which is the opposite of what the signal means.
     */
    const legacy = exposureFromHistory(aggregates, new Set(["long-loved"]), NOW);
    const impressions: ImpressionEvent[] = Array.from({ length: 3 }, (_, i) => ({
      videoId: "long-loved",
      at: NOW - (i + 1) * DAY_MS,
      position: i,
    }));
    const merged = mergeExposure(
      legacy,
      buildExposure({ listens: [], impressions }, NOW, new Set(["long-loved"])),
    );
    const record = merged.get("long-loved")!;

    expect(record.plays7d).toBeGreaterThanOrEqual(1);
    expect(impressionFatigue(record)).toBeLessThan(impressionFatigue({ ...record, plays7d: 0 }));
  });

  it("lets exact event counts win over the aggregate's 'at least one'", () => {
    const listens: ListenEvent[] = Array.from({ length: 4 }, (_, i) => ({
      videoId: "long-loved",
      at: NOW - (i + 1) * DAY_MS,
      origin: "manual" as const,
      outcome: "completed" as const,
      durationRatio: 1,
    }));
    const merged = mergeExposure(
      exposureFromHistory(aggregates, new Set(["long-loved"]), NOW),
      buildExposure({ listens, impressions: [] }, NOW, new Set(["long-loved"])),
    );
    expect(merged.get("long-loved")!.plays7d).toBe(4);
  });

  it("still knows an unwindowed old play is not a discovery", () => {
    const ancient = exposureFromHistory(
      [
        {
          videoId: "played-last-year",
          playCount: 200,
          completeCount: 150,
          skipCount: 0,
          lastPlayedAt: new Date(NOW - 400 * DAY_MS).toISOString(),
        },
      ],
      new Set(["played-last-year"]),
      NOW,
    );
    expect(ancient.get("played-last-year")!.everPlayed).toBe(true);
    // Fully recovered after that long — but recorded as a repeat, not as new.
    expect(repeatReadiness(ancient.get("played-last-year"), NOW)).toBeGreaterThan(0.9);
  });
});
