import { describe, expect, it } from "vitest";
import { mergeUsageStreams } from "./stream-continuity";
import type { UsageStream } from "./protocol";

const stream = (source: string, percent: number): UsageStream => ({
  source,
  label: source,
  five_hour: { utilization: percent, resets_at: null },
  state: "live",
  cached: false,
  observed_at: "2026-08-01T00:00:00.000Z",
});

describe("mergeUsageStreams", () => {
  it("retains a missing provider as an explicit last-known reading", () => {
    const previous = [stream("claude_pro", 18), stream("glm", 1), stream("codex", 33)];
    const incoming = [stream("glm", 2), stream("codex", 34)];

    const merged = mergeUsageStreams(incoming, previous);

    expect(merged.map((value) => value.source)).toEqual(["glm", "codex", "claude_pro"]);
    expect(merged[0]?.five_hour?.utilization).toBe(2);
    expect(merged[2]).toMatchObject({
      source: "claude_pro",
      cached: true,
      state: "offline",
      observed_at: "2026-08-01T00:00:00.000Z",
    });
    expect(merged[2]?.status_message).toContain("last reading");
  });

  it("drops malformed prior rows and never duplicates an incoming source", () => {
    const prior = [stream("codex", 30), { source: "bad" } as UsageStream];
    const incoming = [stream("codex", 31)];

    expect(mergeUsageStreams(incoming, prior)).toEqual(incoming);
  });
});
