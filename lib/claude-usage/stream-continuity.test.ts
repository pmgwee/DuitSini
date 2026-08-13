import { describe, expect, it } from "vitest";
import { mergeUsageStreams } from "./stream-continuity";
import { PRESERVED_SOURCE_TTL_MS, type UsageStream } from "./protocol";

// Fixed clock so the TTL is exercised deterministically (the real ingest route
// passes Date.now()).
const NOW = new Date("2026-08-13T00:00:00.000Z").getTime();

const stream = (source: string, percent: number, observedAt: number = NOW): UsageStream => ({
  source,
  label: source,
  five_hour: { utilization: percent, resets_at: null },
  state: "live",
  cached: false,
  observed_at: new Date(observedAt).toISOString(),
});

describe("mergeUsageStreams", () => {
  it("retains a recently-seen missing provider as an explicit last-known reading", () => {
    const previous = [stream("claude_pro", 18), stream("glm", 1), stream("codex", 33)];
    const incoming = [stream("glm", 2), stream("codex", 34)];

    const merged = mergeUsageStreams(incoming, previous, NOW);

    expect(merged.map((value) => value.source)).toEqual(["glm", "codex", "claude_pro"]);
    expect(merged[0]?.five_hour?.utilization).toBe(2);
    expect(merged[2]).toMatchObject({
      source: "claude_pro",
      cached: true,
      state: "offline",
      observed_at: new Date(NOW).toISOString(),
    });
    expect(merged[2]?.status_message).toContain("last reading");
  });

  it("drops a preserved source whose last reading is older than the TTL (retired collector)", () => {
    // Gemini was pushed by a retired build and never re-seen — like the
    // 2026-08-08 reading still showing on 2026-08-13.
    const stale = stream("gemini", 40, NOW - PRESERVED_SOURCE_TTL_MS - 60_000);
    const previous = [stale, stream("glm", 1)];
    const incoming = [stream("glm", 2)];

    const merged = mergeUsageStreams(incoming, previous, NOW);

    expect(merged.map((value) => value.source)).toEqual(["glm"]);
  });

  it("keeps a preserved source observed just inside the TTL", () => {
    const edge = stream("codex", 33, NOW - PRESERVED_SOURCE_TTL_MS + 60_000);
    const previous = [edge, stream("glm", 1)];
    const incoming = [stream("glm", 2)];

    const merged = mergeUsageStreams(incoming, previous, NOW);

    expect(merged.map((value) => value.source)).toEqual(["glm", "codex"]);
  });

  it("keeps a preserved source with no observed_at (age untraceable)", () => {
    const unknown = { ...stream("codex", 33), observed_at: undefined } as UsageStream;
    const previous = [unknown, stream("glm", 1)];
    const incoming = [stream("glm", 2)];

    const merged = mergeUsageStreams(incoming, previous, NOW);

    expect(merged.map((value) => value.source)).toEqual(["glm", "codex"]);
  });

  it("drops malformed prior rows and never duplicates an incoming source", () => {
    const prior = [stream("codex", 30), { source: "bad" } as UsageStream];
    const incoming = [stream("codex", 31)];

    expect(mergeUsageStreams(incoming, prior, NOW)).toEqual(incoming);
  });
});
